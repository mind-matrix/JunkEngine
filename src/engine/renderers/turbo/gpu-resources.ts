import type { Material, MeshData, TextureData, SceneObject } from "@/engine/models/SceneObject";
import { INSTANCE_STRIDE, INDIRECT_DRAW_SIZE } from "./pipeline";

/** Cached GPU buffers for a single scene object's mesh. */
export interface GpuMeshBuffers {
    vertex: GPUBuffer;
    index: GPUBuffer;
    indexCount: number;
    indexFormat: GPUIndexFormat;
}

/** Cached GPU textures + bind group for a single material. */
export interface GpuMaterialGroup {
    bindGroup: GPUBindGroup;
}

/** Stride: 8 floats per vertex (pos3 + normal3 + uv2). */
export const VERTEX_STRIDE = 8 * 4; // bytes

/**
 * Interleaves position, normal, and UV data into a single Float32Array
 * suitable for a single vertex buffer with stride = 8 floats.
 */
export function interleaveVertexData(mesh: MeshData): Float32Array {
    const buf = new Float32Array(mesh.vertexCount * 8);
    for (let i = 0; i < mesh.vertexCount; i++) {
        const o = i * 8;
        buf[o]     = mesh.positions[i * 3] ?? 0;
        buf[o + 1] = mesh.positions[i * 3 + 1] ?? 0;
        buf[o + 2] = mesh.positions[i * 3 + 2] ?? 0;
        buf[o + 3] = mesh.normals[i * 3] ?? 0;
        buf[o + 4] = mesh.normals[i * 3 + 1] ?? 0;
        buf[o + 5] = mesh.normals[i * 3 + 2] ?? 0;
        buf[o + 6] = mesh.uvs[i * 2] ?? 0;
        buf[o + 7] = mesh.uvs[i * 2 + 1] ?? 0;
    }
    return buf;
}

/** Creates a GPU buffer and writes data into it. */
export function createBuffer(device: GPUDevice, data: ArrayBuffer, usage: GPUBufferUsageFlags): GPUBuffer {
    const buffer = device.createBuffer({
        size: Math.max(data.byteLength, 4), // WebGPU requires size > 0
        usage,
        mappedAtCreation: true,
    });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data));
    buffer.unmap();
    return buffer;
}

/** Uploads mesh data to GPU vertex + index buffers. */
export function uploadMesh(device: GPUDevice, mesh: MeshData): GpuMeshBuffers {
    const interleaved = interleaveVertexData(mesh);
    const vertex = createBuffer(device, interleaved.buffer as ArrayBuffer, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
    const index = createBuffer(device, mesh.indices.buffer as ArrayBuffer, GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST);
    return { vertex, index, indexCount: mesh.indexCount, indexFormat: "uint32" };
}

/** 1×1 white RGBA pixel used as placeholder when a texture slot is unused. */
let _placeholderTex: GPUTexture | null = null;

function getPlaceholderTexture(device: GPUDevice): GPUTexture {
    if (_placeholderTex) return _placeholderTex;
    _placeholderTex = device.createTexture({
        size: [1, 1],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
        { texture: _placeholderTex },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        [1, 1],
    );
    return _placeholderTex;
}

/** Uploads a TextureData to a GPUTexture. */
export function uploadTexture(device: GPUDevice, tex: TextureData): GPUTexture {
    const gpuTex = device.createTexture({
        size: [tex.width, tex.height],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
        { texture: gpuTex },
        new Uint8Array(tex.pixels.buffer as ArrayBuffer, tex.pixels.byteOffset, tex.pixels.byteLength),
        { bytesPerRow: tex.width * 4 },
        [tex.width, tex.height],
    );
    return gpuTex;
}

/**
 * Creates a bind group for a material's textures (group 1).
 * Slots: diffuse, metallic-roughness, normal — each with texture + sampler.
 * Missing textures get a 1×1 white placeholder.
 */
export function createMaterialBindGroup(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    material: Material | undefined,
    texCache: Map<TextureData, GPUTexture>,
): GPUBindGroup {
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });

    function resolve(tex: TextureData | null | undefined): GPUTexture {
        if (!tex) return getPlaceholderTexture(device);
        let cached = texCache.get(tex);
        if (!cached) {
            cached = uploadTexture(device, tex);
            texCache.set(tex, cached);
        }
        return cached;
    }

    const diffuse = resolve(material?.diffuseTexture);
    const mr = resolve(material?.metallicRoughnessTexture);
    const normal = resolve(material?.normalTexture);

    return device.createBindGroup({
        layout,
        entries: [
            { binding: 0, resource: diffuse.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: mr.createView() },
            { binding: 3, resource: sampler },
            { binding: 4, resource: normal.createView() },
            { binding: 5, resource: sampler },
        ],
    });
}


/** Number of floats per instance in the storage buffer. */
const INSTANCE_FLOATS = INSTANCE_STRIDE / 4; // 32

/**
 * Writes per-instance data (model matrix, normal matrix rows, normal sign)
 * into a Float32Array suitable for uploading to the instance storage buffer.
 * Column-major layout for WGSL mat4x4f consumption.
 */
export function writeInstanceData(dst: Float32Array, offset: number, obj: SceneObject): void {
    const m = obj.transform;
    // Model matrix — transpose row-major to column-major for WGSL
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            dst[offset + c * 4 + r] = m[r * 4 + c] ?? 0;
        }
    }
    // Normal matrix rows (upper-left 3×3 of model, transposed for WGSL column reads)
    dst[offset + 16] = m[0] ?? 0; dst[offset + 17] = m[4] ?? 0; dst[offset + 18] = m[8] ?? 0; dst[offset + 19] = 0;
    dst[offset + 20] = m[1] ?? 0; dst[offset + 21] = m[5] ?? 0; dst[offset + 22] = m[9] ?? 0; dst[offset + 23] = 0;
    dst[offset + 24] = m[2] ?? 0; dst[offset + 25] = m[6] ?? 0; dst[offset + 26] = m[10] ?? 0; dst[offset + 27] = 0;
    // params.x = normal sign (determinant check)
    const a = m[0] ?? 0, b = m[1] ?? 0, c2 = m[2] ?? 0;
    const d = m[4] ?? 0, e = m[5] ?? 0, f = m[6] ?? 0;
    const g = m[8] ?? 0, h = m[9] ?? 0, k = m[10] ?? 0;
    const det = a * (e * k - f * h) - b * (d * k - f * g) + c2 * (d * h - e * g);
    dst[offset + 28] = det < 0 ? -1 : 1;
    dst[offset + 29] = 0;
    dst[offset + 30] = 0;
    dst[offset + 31] = 0;
}

/**
 * Writes one drawIndexedIndirect argument block into a Uint32Array.
 * Layout: [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
 */
export function writeIndirectArgs(
    dst: Uint32Array, drawIndex: number,
    indexCount: number, instanceCount: number, firstInstance: number,
): void {
    const o = drawIndex * 5;
    dst[o]     = indexCount;
    dst[o + 1] = instanceCount;
    dst[o + 2] = 0; // firstIndex
    dst[o + 3] = 0; // baseVertex
    dst[o + 4] = firstInstance;
}
