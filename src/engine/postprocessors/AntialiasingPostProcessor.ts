import { PostProcessor } from "@/engine/models/PostProcessor";
import { FXAA_SHADER, TXAA_SHADER } from "@/engine/renderers/turbo/shaders";

/** Supported anti-aliasing algorithms. */
export enum AAMethod {
    /** Multisample AA — hardware multisampling resolved to the output. */
    MSAA = "MSAA",
    /** Fast Approximate AA — single-pass luminance-based edge smoothing. */
    FXAA = "FXAA",
    /** Temporal AA — blends current frame with clamped history buffer. */
    TXAA = "TXAA",
}

/** Configuration for {@link AntialiasingPostProcessor}. */
export interface AAOptions {
    method: AAMethod;
    /** MSAA sample count (4 is typical). Ignored for FXAA/TXAA. */
    sampleCount?: number;
    /** TXAA history blend factor (0–1, default 0.9). Ignored for FXAA/MSAA. */
    blendFactor?: number;
}

// ─── Internal helpers for each algorithm ────────────────────────────────

/** State for the FXAA fullscreen pass. */
interface FxaaState {
    pipeline: GPURenderPipeline;
    bindGroupLayout: GPUBindGroupLayout;
    paramsBuf: GPUBuffer;
}

/** State for the TXAA temporal pass. */
interface TxaaState {
    pipeline: GPURenderPipeline;
    bindGroupLayout: GPUBindGroupLayout;
    paramsBuf: GPUBuffer;
    /** Ping-pong history textures — [0] is read, [1] is written, then swapped. */
    history: [GPUTexture, GPUTexture];
    /** Dummy 1×1 black velocity texture used when no velocity buffer is provided. */
    dummyVelocity: GPUTexture;
    /** Index into history that is the *current* read source. */
    readIdx: number;
    blendFactor: number;
}

/** State for MSAA resolve. */
interface MsaaState {
    sampleCount: number;
    msaaTexture: GPUTexture;
}

/** Halton sequence value for the given index and base. */
function halton(index: number, base: number): number {
    let result = 0;
    let f = 1 / base;
    let i = index;
    while (i > 0) {
        result += f * (i % base);
        i = Math.floor(i / base);
        f /= base;
    }
    return result;
}

/** Number of jitter samples in the Halton sequence before wrapping. */
const JITTER_SEQUENCE_LENGTH = 16;

/**
 * Anti-aliasing post-processor supporting MSAA, FXAA, and TXAA.
 *
 * Usage:
 * ```ts
 * const aa = new AntialiasingPostProcessor(device, w, h, canvasFmt, { method: AAMethod.FXAA });
 * // In render loop:
 * aa.apply(encoder, colorTex, depthTex, canvasView);
 * ```
 *
 * For MSAA the workflow is different — call {@link getMsaaView} to get the
 * multisampled render target that the scene pass should render *into*, then
 * call {@link apply} which resolves it to the output.
 */
export class AntialiasingPostProcessor extends PostProcessor {
    readonly method: AAMethod;
    private canvasFormat: GPUTextureFormat;

    private fxaa: FxaaState | null = null;
    private txaa: TxaaState | null = null;
    private msaa: MsaaState | null = null;

    private frameIndex = 0;

    /**
     * Returns the sub-pixel jitter offset for the current frame in pixels.
     * Apply this to the projection matrix before rendering the scene.
     * Only meaningful for TXAA; returns (0,0) for other methods.
     */
    getJitter(): [number, number] {
        if (this.method !== AAMethod.TXAA) return [0, 0];
        const idx = (this.frameIndex % JITTER_SEQUENCE_LENGTH) + 1; // 1-based to avoid (0,0)
        return [
            halton(idx, 2) - 0.5,
            halton(idx, 3) - 0.5,
        ];
    }

    /** Advances the internal frame counter. Call once per frame after apply(). */
    advanceFrame(): void {
        this.frameIndex++;
    }

    constructor(
        device: GPUDevice,
        width: number,
        height: number,
        canvasFormat: GPUTextureFormat,
        options: AAOptions,
    ) {
        super(device, width, height);
        this.method = options.method;
        this.canvasFormat = canvasFormat;

        switch (options.method) {
            case AAMethod.FXAA:
                this.fxaa = this.buildFxaa();
                break;
            case AAMethod.TXAA:
                this.txaa = this.buildTxaa(options.blendFactor ?? 0.9);
                break;
            case AAMethod.MSAA:
                this.msaa = this.buildMsaa(options.sampleCount ?? 4);
                break;
        }
    }

    // ─── Public API ─────────────────────────────────────────────────────

    /**
     * Returns the multisampled texture view that the scene pass should
     * render into. Only valid when method is MSAA.
     */
    getMsaaView(): GPUTextureView {
        if (!this.msaa) throw new Error("getMsaaView() is only valid for MSAA mode");
        return this.msaa.msaaTexture.createView();
    }

    /** MSAA sample count. Returns 1 if not in MSAA mode. */
    get sampleCount(): number {
        return this.msaa?.sampleCount ?? 1;
    }

    apply(
        encoder: GPUCommandEncoder,
        sourceColor: GPUTexture,
        sourceDepth: GPUTexture,
        outputTexture: GPUTexture,
    ): void {
        switch (this.method) {
            case AAMethod.FXAA:
                this.applyFxaa(encoder, sourceColor, outputTexture.createView());
                break;
            case AAMethod.TXAA:
                this.applyTxaa(encoder, sourceColor, outputTexture);
                break;
            case AAMethod.MSAA:
                break;
        }
    }

    resize(width: number, height: number): void {
        this.width = width;
        this.height = height;

        if (this.fxaa) {
            this.writeFxaaParams(this.fxaa);
        }
        if (this.txaa) {
            this.txaa.history[0].destroy();
            this.txaa.history[1].destroy();
            this.txaa.history = this.createHistoryPair();
            this.txaa.readIdx = 0;
            this.writeTxaaParams(this.txaa);
        }
        if (this.msaa) {
            this.msaa.msaaTexture.destroy();
            this.msaa.msaaTexture = this.createMsaaTexture(this.msaa.sampleCount);
        }
    }

    dispose(): void {
        this.fxaa?.paramsBuf.destroy();
        if (this.txaa) {
            this.txaa.paramsBuf.destroy();
            this.txaa.history[0].destroy();
            this.txaa.history[1].destroy();
            this.txaa.dummyVelocity.destroy();
        }
        this.msaa?.msaaTexture.destroy();
    }

    // ─── FXAA ───────────────────────────────────────────────────────────

    private buildFxaa(): FxaaState {
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            ],
        });

        const module = this.device.createShaderModule({ code: FXAA_SHADER });
        const pipeline = this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
            vertex: { module, entryPoint: "vs" },
            fragment: { module, entryPoint: "fs", targets: [{ format: this.canvasFormat }] },
            primitive: { topology: "triangle-list" },
        });

        const paramsBuf = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const state: FxaaState = { pipeline, bindGroupLayout, paramsBuf };
        this.writeFxaaParams(state);
        return state;
    }

    private writeFxaaParams(state: FxaaState): void {
        const data = new Float32Array([1 / this.width, 1 / this.height, 0, 0]);
        this.device.queue.writeBuffer(state.paramsBuf, 0, data);
    }

    private applyFxaa(encoder: GPUCommandEncoder, sourceColor: GPUTexture, outputView: GPUTextureView): void {
        const f = this.fxaa!;
        const sampler = this.device.createSampler({ magFilter: "linear", minFilter: "linear" });
        const bindGroup = this.device.createBindGroup({
            layout: f.bindGroupLayout,
            entries: [
                { binding: 0, resource: sourceColor.createView() },
                { binding: 1, resource: sampler },
                { binding: 2, resource: { buffer: f.paramsBuf } },
            ],
        });

        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: outputView, loadOp: "clear", storeOp: "store" }],
        });
        pass.setPipeline(f.pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
    }

    // ─── TXAA ───────────────────────────────────────────────────────────

    private buildTxaa(blendFactor: number): TxaaState {
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },  // current
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },  // history
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },  // velocity
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            ],
        });

        const module = this.device.createShaderModule({ code: TXAA_SHADER });
        const pipeline = this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
            vertex: { module, entryPoint: "vs" },
            fragment: { module, entryPoint: "fs", targets: [{ format: this.canvasFormat }] },
            primitive: { topology: "triangle-list" },
        });

        const paramsBuf = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const history = this.createHistoryPair();

        // 1×1 black velocity texture (zero motion) as fallback
        const dummyVelocity = this.device.createTexture({
            size: [1, 1],
            format: "rg16float",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.device.queue.writeTexture(
            { texture: dummyVelocity },
            new Uint8Array(4), // 4 bytes = 2 × float16(0)
            { bytesPerRow: 4 },
            [1, 1],
        );

        const state: TxaaState = { pipeline, bindGroupLayout, paramsBuf, history, dummyVelocity, readIdx: 0, blendFactor };
        this.writeTxaaParams(state);
        return state;
    }

    private createHistoryPair(): [GPUTexture, GPUTexture] {
        const desc: GPUTextureDescriptor = {
            size: [this.width, this.height],
            format: this.canvasFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        };
        return [this.device.createTexture(desc), this.device.createTexture(desc)];
    }

    private writeTxaaParams(state: TxaaState): void {
        const data = new Float32Array([1 / this.width, 1 / this.height, state.blendFactor, 0]);
        this.device.queue.writeBuffer(state.paramsBuf, 0, data);
    }

    private applyTxaa(
        encoder: GPUCommandEncoder,
        sourceColor: GPUTexture,
        outputTexture: GPUTexture,
    ): void {
        const t = this.txaa!;
        const readTex = t.history[t.readIdx]!;
        const writeIdx = 1 - t.readIdx;
        const writeTex = t.history[writeIdx]!;

        const sampler = this.device.createSampler({ magFilter: "linear", minFilter: "linear" });
        const bindGroup = this.device.createBindGroup({
            layout: t.bindGroupLayout,
            entries: [
                { binding: 0, resource: sourceColor.createView() },
                { binding: 1, resource: readTex.createView() },
                { binding: 2, resource: t.dummyVelocity.createView() },
                { binding: 3, resource: sampler },
                { binding: 4, resource: { buffer: t.paramsBuf } },
            ],
        });

        // Pass 1: render TXAA result into history write buffer
        const historyPass = encoder.beginRenderPass({
            colorAttachments: [{ view: writeTex.createView(), loadOp: "clear", storeOp: "store" }],
        });
        historyPass.setPipeline(t.pipeline);
        historyPass.setBindGroup(0, bindGroup);
        historyPass.draw(3);
        historyPass.end();

        // Pass 2: same draw to canvas (same inputs, deterministic output)
        const canvasPass = encoder.beginRenderPass({
            colorAttachments: [{ view: outputTexture.createView(), loadOp: "clear", storeOp: "store" }],
        });
        canvasPass.setPipeline(t.pipeline);
        canvasPass.setBindGroup(0, bindGroup);
        canvasPass.draw(3);
        canvasPass.end();

        t.readIdx = writeIdx;
    }

    // ─── MSAA ───────────────────────────────────────────────────────────

    private buildMsaa(sampleCount: number): MsaaState {
        const msaaTexture = this.createMsaaTexture(sampleCount);
        return { sampleCount, msaaTexture };
    }

    private createMsaaTexture(sampleCount: number): GPUTexture {
        return this.device.createTexture({
            size: [this.width, this.height],
            format: this.canvasFormat,
            sampleCount,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
    }
}
