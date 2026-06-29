import { Renderer } from "@/engine/models/Renderer";
import { Scene } from "@/engine/models/Scene";
import type { PostProcessor } from "@/engine/models/PostProcessor";
import type { AntialiasingPostProcessor } from "@/engine/postprocessors/AntialiasingPostProcessor";
import type { Material, SceneObject, TextureData } from "@/engine/models/SceneObject";
import type { LightSource } from "@/engine/models/LightSource";
import { extractFrustumPlanes, isSphereOutsideFrustum, transformBoundingSphere } from "@/engine/utilities/render-utils";
import { uploadMesh, createMaterialBindGroup, createBuffer, writeInstanceData, writeIndirectArgs } from "./gpu-resources";
import type { GpuMeshBuffers } from "./gpu-resources";
import { createTurboPipeline, SCENE_UNIFORM_SIZE, INSTANCE_STRIDE, MATERIAL_UNIFORM_SIZE, LIGHT_UNIFORM_SIZE, OUTLINE_PARAMS_SIZE, INDIRECT_DRAW_SIZE } from "./pipeline";
import type { TurboPipeline } from "./pipeline";
import { MAX_LIGHTS } from "./shaders";
import { ShadingMode } from "@/engine/models/Scene";

const BACKGROUND_COLOR: GPUColor = { r: 91 / 255, g: 91 / 255, b: 91 / 255, a: 1 };

/** Duck-type check for AntialiasingPostProcessor with jitter support. */
function hasJitter(pp: PostProcessor): pp is AntialiasingPostProcessor {
    return typeof (pp as AntialiasingPostProcessor).getJitter === "function";
}

/** Duck-type check for AntialiasingPostProcessor with MSAA support. */
function hasMsaa(pp: PostProcessor): pp is AntialiasingPostProcessor {
    return typeof (pp as AntialiasingPostProcessor).getMsaaView === "function"
        && (pp as AntialiasingPostProcessor).sampleCount > 1;
}

/** Key for batching objects that share the same mesh and material. */
function batchKey(objId: number, matId: number): string {
    return `${objId}:${matId}`;
}

/** A batch of instances sharing the same mesh buffers and material bind group. */
interface DrawBatch {
    meshBufs: GpuMeshBuffers;
    matGroup: GPUBindGroup;
    material: Material | undefined;
    firstInstance: number;
    instanceCount: number;
}

/**
 * "Turbo" — a WebGPU hardware-accelerated renderer with instanced indirect draws.
 *
 * Objects sharing the same mesh+material are batched into a single
 * drawIndexedIndirect call. All per-instance transforms live in one
 * GPU storage buffer, indexed by instance_index in the vertex shader.
 */
export class TurboRenderer extends Renderer<GPUCanvasContext> {
    private device: GPUDevice;
    private turbo: TurboPipeline;

    // Caches keyed by scene object / material id
    private meshCache = new Map<number, GpuMeshBuffers>();
    private matGroupCache = new Map<number, GPUBindGroup>();
    private texCache = new Map<TextureData, GPUTexture>();

    // Reusable uniform buffers
    private sceneUniformBuf: GPUBuffer;
    private materialUniformBuf: GPUBuffer;
    private lightUniformBuf: GPUBuffer;
    private outlineParamsBuf: GPUBuffer;

    // Dynamic buffers — grown as needed
    private instanceBuf: GPUBuffer;
    private instanceBufCapacity = 0; // in instances
    private indirectBuf: GPUBuffer;
    private indirectBufCapacity = 0; // in draw calls

    /** Optional post-processor applied as the final pass before presenting to canvas. */
    private _postProcessor: PostProcessor | null = null;

    get postProcessor(): PostProcessor | null { return this._postProcessor; }
    set postProcessor(pp: PostProcessor | null) {
        this._postProcessor = pp;
        const sc = pp && hasMsaa(pp) ? pp.sampleCount : 1;
        if (sc !== this.currentSampleCount) {
            this.currentSampleCount = sc;
            this.turbo = createTurboPipeline(this.device, this.turbo.canvasFormat, this.canvas.width, this.canvas.height, sc);
        }
    }

    private currentSampleCount = 1;
    private _wireframe = false;

    get wireframe(): boolean { return this._wireframe; }
    set wireframe(value: boolean) {
        if (value === this._wireframe) return;
        this._wireframe = value;
        this.turbo = createTurboPipeline(this.device, this.turbo.canvasFormat, this.canvas.width, this.canvas.height, this.currentSampleCount, value);
    }

    private constructor(canvas: HTMLCanvasElement, context: GPUCanvasContext, device: GPUDevice, turbo: TurboPipeline) {
        super(canvas, context);
        this.device = device;
        this.turbo = turbo;

        this.sceneUniformBuf = device.createBuffer({ size: SCENE_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.materialUniformBuf = device.createBuffer({ size: MATERIAL_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.lightUniformBuf = device.createBuffer({ size: LIGHT_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.outlineParamsBuf = device.createBuffer({ size: OUTLINE_PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

        // Start with room for 64 instances / 64 draws — will grow
        this.instanceBuf = this.createInstanceBuffer(64);
        this.instanceBufCapacity = 64;
        this.indirectBuf = this.createIndirectBuffer(64);
        this.indirectBufCapacity = 64;
    }

    /** The underlying GPU device. */
    getDevice(): GPUDevice { return this.device; }
    /** The canvas texture format. */
    getCanvasFormat(): GPUTextureFormat { return this.turbo.canvasFormat; }
    /** The intermediate color texture. */
    getColorTexture(): GPUTexture { return this.turbo.colorTexture; }
    /** The depth texture from the scene pass. */
    getDepthTexture(): GPUTexture { return this.turbo.depthTexture; }

    resize(width: number, height: number): void {
        this.canvas.width = width;
        this.canvas.height = height;
        this.turbo = createTurboPipeline(this.device, this.turbo.canvasFormat, width, height, this.currentSampleCount, this._wireframe);
    }

    static async create(canvas: HTMLCanvasElement): Promise<TurboRenderer> {
        if (!navigator.gpu) throw new Error("WebGPU not supported in this browser");
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error("Failed to get GPU adapter");
        const device = await adapter.requestDevice({
            requiredLimits: {
                maxBufferSize: adapter.limits.maxBufferSize,
                maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
            },
        });

        const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
        if (!context) throw new Error("Failed to get WebGPU context");

        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format, alphaMode: "opaque" });

        const turbo = createTurboPipeline(device, format, canvas.width, canvas.height);
        return new TurboRenderer(canvas, context, device, turbo);
    }

    clear(): void {
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                clearValue: BACKGROUND_COLOR,
                loadOp: "clear",
                storeOp: "store",
            }],
            depthStencilAttachment: {
                view: this.turbo.depthTexture.createView(),
                depthClearValue: 1.0,
                depthLoadOp: "clear",
                depthStoreOp: "store",
            },
        });
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    render(scene: Scene): void {
        const isToon = scene.shadingMode === ShadingMode.Toon;
        const aspect = this.canvas.width / this.canvas.height;
        const vpMatrix = scene.getViewProjectionMatrix(aspect);

        // Apply sub-pixel jitter for temporal AA
        const pp = this.postProcessor;
        if (pp && hasJitter(pp)) {
            const [jx, jy] = pp.getJitter();
            vpMatrix[3] = (vpMatrix[3] ?? 0) + (2 * jx) / this.canvas.width;
            vpMatrix[7] = (vpMatrix[7] ?? 0) + (2 * jy) / this.canvas.height;
        }

        const frustumPlanes = extractFrustumPlanes(vpMatrix);
        const lights = Array.from(scene.getLights());

        this.writeSceneUniforms(vpMatrix, scene.camera.position, scene.shadingMode);
        this.writeLightUniforms(lights);

        // --- Frustum cull & sort into opaque / blend lists ---
        const opaqueVisible: { obj: SceneObject; material: Material | undefined }[] = [];
        const blendVisible: { obj: SceneObject; material: Material | undefined }[] = [];

        for (const obj of scene.getObjects()) {
            const wb = transformBoundingSphere(obj.mesh.bounds, obj.transform);
            if (isSphereOutsideFrustum(frustumPlanes, wb.cx, wb.cy, wb.cz, wb.radius)) continue;
            const material = scene.getMaterial(obj.materialId);
            if (material?.alphaMode === "BLEND") {
                blendVisible.push({ obj, material });
            } else {
                opaqueVisible.push({ obj, material });
            }
        }

        // --- Build batches (group by mesh id + material id) ---
        const opaqueBatches = this.buildBatches(opaqueVisible);
        const blendBatches = this.buildBatches(blendVisible);
        const totalInstances = opaqueVisible.length + blendVisible.length;
        const totalDraws = opaqueBatches.length + blendBatches.length;

        // --- Grow dynamic buffers if needed ---
        if (totalInstances > this.instanceBufCapacity) {
            this.instanceBuf.destroy();
            const newCap = Math.max(totalInstances, this.instanceBufCapacity * 2);
            this.instanceBuf = this.createInstanceBuffer(newCap);
            this.instanceBufCapacity = newCap;
        }
        if (totalDraws > this.indirectBufCapacity) {
            this.indirectBuf.destroy();
            const newCap = Math.max(totalDraws, this.indirectBufCapacity * 2);
            this.indirectBuf = this.createIndirectBuffer(newCap);
            this.indirectBufCapacity = newCap;
        }

        // --- Write instance data + indirect args ---
        const instanceData = new Float32Array(totalInstances * (INSTANCE_STRIDE / 4));
        const indirectArgs = new Uint32Array(totalDraws * 5);

        let instanceIdx = 0;
        let drawIdx = 0;

        for (const batch of opaqueBatches) {
            batch.firstInstance = instanceIdx;
            writeIndirectArgs(indirectArgs, drawIdx, batch.meshBufs.indexCount, batch.instanceCount, instanceIdx);
            drawIdx++;
            // Instance data was already written during buildBatches — copy from batch objects
        }
        // We need to write instance data in batch order. Rebuild from the lists.
        instanceIdx = 0;
        for (const batch of opaqueBatches) {
            // batch.firstInstance is set; instance data written below
        }
        // Actually write all instance data in order: opaque then blend
        instanceIdx = 0;
        for (const { obj } of opaqueVisible) {
            writeInstanceData(instanceData, instanceIdx * (INSTANCE_STRIDE / 4), obj);
            instanceIdx++;
        }
        for (const { obj } of blendVisible) {
            writeInstanceData(instanceData, instanceIdx * (INSTANCE_STRIDE / 4), obj);
            instanceIdx++;
        }

        // Rebuild indirect args properly now that instance data is in list order
        drawIdx = 0;
        for (const batch of opaqueBatches) {
            writeIndirectArgs(indirectArgs, drawIdx, batch.meshBufs.indexCount, batch.instanceCount, batch.firstInstance);
            drawIdx++;
        }
        for (const batch of blendBatches) {
            writeIndirectArgs(indirectArgs, drawIdx, batch.meshBufs.indexCount, batch.instanceCount, batch.firstInstance);
            drawIdx++;
        }

        if (totalInstances > 0) {
            this.device.queue.writeBuffer(this.instanceBuf, 0, instanceData);
        }
        if (totalDraws > 0) {
            this.device.queue.writeBuffer(this.indirectBuf, 0, indirectArgs);
        }

        // --- Determine render targets ---
        const hasPostProcess = this.postProcessor !== null;
        const isMsaa = hasPostProcess && hasMsaa(this.postProcessor!);
        const needsIntermediate = isToon || (hasPostProcess && !isMsaa);

        let colorView: GPUTextureView;
        let resolveTarget: GPUTextureView | undefined;
        if (isMsaa) {
            colorView = (this.postProcessor as AntialiasingPostProcessor).getMsaaView();
            resolveTarget = isToon
                ? this.turbo.colorTexture.createView()
                : this.context.getCurrentTexture().createView();
        } else {
            colorView = needsIntermediate
                ? this.turbo.colorTexture.createView()
                : this.context.getCurrentTexture().createView();
        }

        const encoder = this.device.createCommandEncoder();

        // --- Scene pass ---
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: colorView,
                ...(resolveTarget && { resolveTarget }),
                clearValue: BACKGROUND_COLOR,
                loadOp: "clear",
                storeOp: resolveTarget ? "discard" : "store",
            }],
            depthStencilAttachment: {
                view: this.turbo.depthTexture.createView(),
                depthClearValue: 1.0,
                depthLoadOp: "clear",
                depthStoreOp: "store",
            },
        });

        // Opaque batches
        if (opaqueBatches.length > 0) {
            pass.setPipeline(this.turbo.opaquePipeline);
            this.drawBatches(pass, opaqueBatches, 0);
        }

        // Blend batches
        if (blendBatches.length > 0) {
            pass.setPipeline(this.turbo.blendPipeline);
            this.drawBatches(pass, blendBatches, opaqueBatches.length);
        }

        pass.end();

        // --- Outline post-process pass (toon only) ---
        if (isToon) {
            this.writeOutlineParams();

            const outlineTarget = hasPostProcess
                ? this.turbo.postProcessTexture.createView()
                : this.context.getCurrentTexture().createView();

            const outlineBindGroup = this.device.createBindGroup({
                layout: this.turbo.outlineBindGroupLayout,
                entries: [
                    { binding: 0, resource: this.turbo.colorTexture.createView() },
                    { binding: 1, resource: this.turbo.depthTexture.createView() },
                    { binding: 2, resource: this.device.createSampler({ magFilter: "nearest", minFilter: "nearest" }) },
                    { binding: 3, resource: { buffer: this.outlineParamsBuf } },
                ],
            });

            const outlinePass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: outlineTarget,
                    loadOp: "clear",
                    storeOp: "store",
                }],
            });

            outlinePass.setPipeline(this.turbo.outlinePipeline);
            outlinePass.setBindGroup(0, outlineBindGroup);
            outlinePass.draw(3);
            outlinePass.end();
        }

        // --- Post-processor pass ---
        if (hasPostProcess) {
            const ppSource = isToon ? this.turbo.postProcessTexture : this.turbo.colorTexture;
            this.postProcessor!.apply(
                encoder,
                ppSource,
                this.turbo.depthTexture,
                this.context.getCurrentTexture(),
            );
            if (hasJitter(this.postProcessor!)) {
                this.postProcessor!.advanceFrame();
            }
        }

        this.device.queue.submit([encoder.finish()]);
    }

    // ─── Batching ───────────────────────────────────────────────────────

    /**
     * Groups visible objects by mesh+material into draw batches.
     * Objects in the input list must be in the order they'll appear in the
     * instance buffer (contiguous per batch).
     */
    private buildBatches(
        visible: { obj: SceneObject; material: Material | undefined }[],
    ): DrawBatch[] {
        // Group by mesh id + material id, preserving insertion order
        const map = new Map<string, { objs: SceneObject[]; material: Material | undefined }>();
        for (const { obj, material } of visible) {
            const key = batchKey(obj.id, obj.materialId);
            let entry = map.get(key);
            if (!entry) {
                entry = { objs: [], material };
                map.set(key, entry);
            }
            entry.objs.push(obj);
        }

        // Reorder visible list so instances within a batch are contiguous,
        // and build batch descriptors.
        // We mutate `visible` in place to match the instance buffer order.
        const batches: DrawBatch[] = [];
        let cursor = 0;
        for (const [, entry] of map) {
            const meshBufs = this.getOrUploadMesh(entry.objs[0]!);
            const matGroup = this.getOrCreateMaterialGroup(entry.objs[0]!.materialId, entry.material);
            batches.push({
                meshBufs,
                matGroup,
                material: entry.material,
                firstInstance: cursor,
                instanceCount: entry.objs.length,
            });
            for (let i = 0; i < entry.objs.length; i++) {
                visible[cursor + i] = { obj: entry.objs[i]!, material: entry.material };
            }
            cursor += entry.objs.length;
        }

        return batches;
    }

    /** Issues drawIndexedIndirect for each batch. */
    private drawBatches(pass: GPURenderPassEncoder, batches: DrawBatch[], indirectOffset: number): void {
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i]!;

            this.writeMaterialUniforms(batch.material);

            const uniformGroup = this.device.createBindGroup({
                layout: this.turbo.uniformLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.sceneUniformBuf } },
                    { binding: 1, resource: { buffer: this.materialUniformBuf } },
                    { binding: 2, resource: { buffer: this.lightUniformBuf } },
                    { binding: 3, resource: { buffer: this.instanceBuf } },
                ],
            });

            pass.setBindGroup(0, uniformGroup);
            pass.setBindGroup(1, batch.matGroup);
            pass.setVertexBuffer(0, batch.meshBufs.vertex);
            pass.setIndexBuffer(batch.meshBufs.index, batch.meshBufs.indexFormat);
            pass.drawIndexedIndirect(this.indirectBuf, (indirectOffset + i) * INDIRECT_DRAW_SIZE);
        }
    }

    // ─── Uniform writers ────────────────────────────────────────────────

    private writeSceneUniforms(vpMatrix: Float32Array, cameraPos: Float32Array, shadingMode: number): void {
        const data = new Float32Array(SCENE_UNIFORM_SIZE / 4);
        // VP matrix — transpose row-major to column-major for WGSL
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
                data[c * 4 + r] = vpMatrix[r * 4 + c] ?? 0;
            }
        }
        // cameraPos (vec4)
        data[16] = cameraPos[0] ?? 0;
        data[17] = cameraPos[1] ?? 0;
        data[18] = cameraPos[2] ?? 0;
        data[19] = 0;
        // sceneParams (vec4)
        data[20] = shadingMode;
        data[21] = 0;
        data[22] = 0;
        data[23] = 0;
        this.device.queue.writeBuffer(this.sceneUniformBuf, 0, data);
    }

    private writeMaterialUniforms(material: Material | undefined): void {
        const data = new Float32Array(MATERIAL_UNIFORM_SIZE / 4);
        data[0] = material?.baseColor[0] ?? 1;
        data[1] = material?.baseColor[1] ?? 1;
        data[2] = material?.baseColor[2] ?? 1;
        data[3] = material?.baseColor[3] ?? 1;
        data[4] = material?.metallicFactor ?? 1;
        data[5] = material?.roughnessFactor ?? 1;
        data[6] = material?.normalScale ?? 1;
        data[7] = material?.alphaCutoff ?? 0.5;

        const view = new DataView(data.buffer);
        const mode = material?.alphaMode;
        view.setUint32(32, mode === "MASK" ? 1 : mode === "BLEND" ? 2 : 0, true);
        let texBits = 0;
        if (material?.diffuseTexture) texBits |= 1;
        if (material?.metallicRoughnessTexture) texBits |= 2;
        if (material?.normalTexture) texBits |= 4;
        view.setUint32(36, texBits, true);

        this.device.queue.writeBuffer(this.materialUniformBuf, 0, data);
    }

    private writeLightUniforms(lights: LightSource[]): void {
        const floatCount = LIGHT_UNIFORM_SIZE / 4;
        const data = new Float32Array(floatCount);
        const view = new DataView(data.buffer);
        const count = Math.min(lights.length, MAX_LIGHTS);
        view.setUint32(0, count, true);

        for (let i = 0; i < count; i++) {
            const light = lights[i]!;
            const base = 4 + i * 12;

            if (light.type === "directional") {
                data[base]     = light.direction[0] ?? 0;
                data[base + 1] = light.direction[1] ?? 0;
                data[base + 2] = light.direction[2] ?? 0;
                data[base + 3] = 0;
            } else {
                data[base]     = light.position[0] ?? 0;
                data[base + 1] = light.position[1] ?? 0;
                data[base + 2] = light.position[2] ?? 0;
                data[base + 3] = 1;
            }

            const intensity = light.intensity;
            data[base + 4] = (light.color[0] ?? 1) * intensity;
            data[base + 5] = (light.color[1] ?? 1) * intensity;
            data[base + 6] = (light.color[2] ?? 1) * intensity;
            data[base + 7] = 0;

            data[base + 8]  = light.attenuation.constant;
            data[base + 9]  = light.attenuation.linear;
            data[base + 10] = light.attenuation.quadratic;
            data[base + 11] = 0;
        }

        this.device.queue.writeBuffer(this.lightUniformBuf, 0, data);
    }

    private writeOutlineParams(): void {
        const data = new Float32Array(OUTLINE_PARAMS_SIZE / 4);
        data[0] = 1 / this.turbo.width;
        data[1] = 1 / this.turbo.height;
        data[2] = 0.1;
        data[3] = 0.0;
        this.device.queue.writeBuffer(this.outlineParamsBuf, 0, data);
    }

    // ─── Buffer helpers ─────────────────────────────────────────────────

    private createInstanceBuffer(capacity: number): GPUBuffer {
        return this.device.createBuffer({
            size: Math.max(capacity * INSTANCE_STRIDE, 32),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    }

    private createIndirectBuffer(capacity: number): GPUBuffer {
        return this.device.createBuffer({
            size: Math.max(capacity * INDIRECT_DRAW_SIZE, 20),
            usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        });
    }

    // ─── Cache helpers ──────────────────────────────────────────────────

    private getOrUploadMesh(obj: SceneObject): GpuMeshBuffers {
        let cached = this.meshCache.get(obj.id);
        if (!cached) {
            cached = uploadMesh(this.device, obj.mesh);
            this.meshCache.set(obj.id, cached);
        }
        return cached;
    }

    private getOrCreateMaterialGroup(matId: number, material: Material | undefined): GPUBindGroup {
        let cached = this.matGroupCache.get(matId);
        if (!cached) {
            cached = createMaterialBindGroup(this.device, this.turbo.textureLayout, material, this.texCache);
            this.matGroupCache.set(matId, cached);
        }
        return cached;
    }
}
