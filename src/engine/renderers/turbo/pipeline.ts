import { VERTEX_SHADER, FRAGMENT_SHADER, OUTLINE_SHADER, MAX_LIGHTS } from "./shaders";
import { VERTEX_STRIDE } from "./gpu-resources";

/** Size of the per-scene uniform buffer (VP mat4x4 + cameraPos vec4 + sceneParams vec4). */
export const SCENE_UNIFORM_SIZE = (16 + 4 + 4) * 4; // 96 bytes

/** Size of one instance in the storage buffer (model mat4x4 + normalMat0-2 vec4 + params vec4). */
export const INSTANCE_STRIDE = (16 + 4 + 4 + 4 + 4) * 4; // 128 bytes

/** Size of the material uniform buffer. */
export const MATERIAL_UNIFORM_SIZE = 48; // 12 floats padded to 48 bytes (3 vec4)

/** Size of the light uniform buffer. */
export const LIGHT_UNIFORM_SIZE = 16 + MAX_LIGHTS * 48; // count(vec4) + N * 3 vec4

/** Size of the outline params uniform (texelSize vec2 + depthThreshold f32 + normalThreshold f32). */
export const OUTLINE_PARAMS_SIZE = 16; // 1 vec4 worth

/** Bytes per indirect draw argument (indexCount, instanceCount, firstIndex, baseVertex, firstInstance). */
export const INDIRECT_DRAW_SIZE = 5 * 4; // 20 bytes

export interface TurboPipeline {
    opaquePipeline: GPURenderPipeline;
    blendPipeline: GPURenderPipeline;
    outlinePipeline: GPURenderPipeline;
    uniformLayout: GPUBindGroupLayout;   // group 0: scene + material + lights + instances
    textureLayout: GPUBindGroupLayout;   // group 1: textures
    outlineBindGroupLayout: GPUBindGroupLayout;
    depthTexture: GPUTexture;
    depthFormat: GPUTextureFormat;
    colorTexture: GPUTexture;            // intermediate render target
    postProcessTexture: GPUTexture;      // second intermediate for post-processor chains
    canvasFormat: GPUTextureFormat;
    width: number;
    height: number;
}

export function createTurboPipeline(device: GPUDevice, canvasFormat: GPUTextureFormat, width: number, height: number, sampleCount = 1, wireframe = false): TurboPipeline {
    const depthFormat: GPUTextureFormat = "depth32float";

    // --- Bind group layouts ---
    const uniformLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },   // scene
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },                            // material
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },                            // lights
            { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },                    // instances
        ],
    });

    const textureLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
            { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        ],
    });

    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [uniformLayout, textureLayout] });

    // --- Shader modules ---
    const vertModule = device.createShaderModule({ code: VERTEX_SHADER });
    const fragModule = device.createShaderModule({ code: FRAGMENT_SHADER });

    const vertexState: GPUVertexState = {
        module: vertModule,
        entryPoint: "vs",
        buffers: [{
            arrayStride: VERTEX_STRIDE,
            attributes: [
                { shaderLocation: 0, offset: 0, format: "float32x3" },
                { shaderLocation: 1, offset: 12, format: "float32x3" },
                { shaderLocation: 2, offset: 24, format: "float32x2" },
            ],
        }],
    };

    const primitive: GPUPrimitiveState = {
        topology: wireframe ? "line-list" : "triangle-list",
        cullMode: "none",
    };

    const multisample: GPUMultisampleState | undefined = sampleCount > 1 ? { count: sampleCount } : undefined;

    // --- Opaque pipeline ---
    const opaquePipeline = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: vertexState,
        fragment: {
            module: fragModule,
            entryPoint: "fs",
            targets: [{ format: canvasFormat }],
        },
        primitive,
        depthStencil: {
            format: depthFormat,
            depthWriteEnabled: true,
            depthCompare: "less",
        },
        ...(multisample && { multisample }),
    });

    // --- Blend pipeline ---
    const blendPipeline = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: vertexState,
        fragment: {
            module: fragModule,
            entryPoint: "fs",
            targets: [{
                format: canvasFormat,
                blend: {
                    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                },
            }],
        },
        primitive,
        depthStencil: {
            format: depthFormat,
            depthWriteEnabled: false,
            depthCompare: "less",
        },
        ...(multisample && { multisample }),
    });

    // --- Outline post-process pipeline ---
    const outlineBindGroupLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "non-filtering" } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        ],
    });

    const outlineModule = device.createShaderModule({ code: OUTLINE_SHADER });
    const outlinePipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [outlineBindGroupLayout] });

    const outlinePipeline = device.createRenderPipeline({
        layout: outlinePipelineLayout,
        vertex: {
            module: outlineModule,
            entryPoint: "vs",
        },
        fragment: {
            module: outlineModule,
            entryPoint: "fs",
            targets: [{ format: canvasFormat }],
        },
        primitive: { topology: "triangle-list" },
    });

    // --- Textures ---
    const depthTexture = device.createTexture({
        size: [width, height],
        format: depthFormat,
        sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | (sampleCount === 1 ? GPUTextureUsage.TEXTURE_BINDING : 0),
    });

    const colorTexture = device.createTexture({
        size: [width, height],
        format: canvasFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    const postProcessTexture = device.createTexture({
        size: [width, height],
        format: canvasFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    return {
        opaquePipeline, blendPipeline, outlinePipeline,
        uniformLayout, textureLayout, outlineBindGroupLayout,
        depthTexture, depthFormat, colorTexture, postProcessTexture, canvasFormat,
        width, height,
    };
}
