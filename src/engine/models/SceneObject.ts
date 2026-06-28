/** Raw image pixel data used for texture mapping on materials. */
export interface TextureData {
    /** RGBA pixel data, 4 bytes per pixel in row-major order. */
    pixels: Uint8ClampedArray;
    /** Width of the texture in pixels. */
    width: number;
    /** Height of the texture in pixels. */
    height: number;
}

/**
 * Surface material defining how a mesh is shaded.
 * Supports both solid color and image-based diffuse textures.
 * When {@link diffuseTexture} is present it takes priority over {@link baseColor}.
 */
export interface Material {
    /** Unique material identifier assigned by the {@link Scene}. */
    id: number;
    /** Fallback solid color as RGBA floats in the 0–1 range. */
    baseColor: Float32Array;
    /** Optional diffuse texture; `null` means use {@link baseColor}. */
    diffuseTexture: TextureData | null;
    /** Optional metallic-roughness texture (G=roughness, B=metallic per glTF spec). */
    metallicRoughnessTexture: TextureData | null;
    /** Optional tangent-space normal map (RGB, remapped from [0,255] to [-1,1]). */
    normalTexture: TextureData | null;
    /** Scale factor applied to the normal map XY (default 1). */
    normalScale: number;
    /** Base metallic factor 0–1 (default 1). */
    metallicFactor: number;
    /** Base roughness factor 0–1 (default 1). */
    roughnessFactor: number;
    /** Alpha test mode: "OPAQUE" (default), "MASK", or "BLEND". */
    alphaMode: string;
    /** Alpha cutoff threshold for MASK mode (default 0.5). */
    alphaCutoff: number;
}

/**
 * Structure-of-Arrays geometry data for a single mesh.
 * All attribute arrays are flat typed arrays laid out for direct GPU upload
 * or cache-friendly CPU iteration. Every three consecutive indices form one triangle.
 */
/** Bounding sphere for fast frustum culling. */
export interface BoundingSphere {
    /** Center x, y, z in local object space. */
    cx: number; cy: number; cz: number;
    /** Radius. */
    radius: number;
}

export interface MeshData {
    /** Vertex positions — 3 floats (x, y, z) per vertex. */
    positions: Float32Array;
    /** Vertex normals — 3 floats (x, y, z) per vertex. */
    normals: Float32Array;
    /** Texture coordinates — 2 floats (u, v) per vertex. */
    uvs: Float32Array;
    /** Per-vertex colors — 4 floats (r, g, b, a) per vertex. */
    colors: Float32Array;
    /** Triangle index buffer — every 3 consecutive values reference vertices forming a triangle. */
    indices: Uint32Array;
    /** Total number of vertices (positions.length / 3). */
    vertexCount: number;
    /** Total number of indices (indices.length). */
    indexCount: number;
    /** Bounding sphere in local space for frustum culling. */
    bounds: BoundingSphere;
}

/** A renderable entity in the scene graph. */
export interface SceneObject {
    /** Unique entity identifier assigned by the {@link Scene}. */
    id: number;
    /** Human-readable name for debugging. */
    name: string;
    /** Geometry data for this object. */
    mesh: MeshData;
    /** Row-major 4×4 model transform matrix (16 floats). */
    transform: Float32Array;
    /** Index into the {@link Scene} material table. */
    materialId: number;
    /** Bitmask of {@link DirtyFlag} values indicating what needs re-upload. */
    dirty: number;
}

/** Bitmask constants for tracking which parts of a {@link SceneObject} have changed. */
export const DirtyFlag = {
    NONE: 0,
    TRANSFORM: 1 << 0,
    MESH: 1 << 1,
    MATERIAL: 1 << 2,
    ALL: 0b111,
} as const;

/** Returns a new 4×4 identity matrix as a row-major Float32Array. */
export function createIdentityTransform(): Float32Array {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}

/**
 * Convenience factory for {@link MeshData}.
 * Omitted attribute arrays are zero-filled to match the vertex count.
 * @param positions - Flat xyz position array.
 * @param indices   - Triangle index array.
 * @param normals   - Optional per-vertex normals.
 * @param uvs       - Optional per-vertex texture coordinates.
 * @param colors    - Optional per-vertex RGBA colors.
 */
export function createMeshData(
    positions: Float32Array,
    indices: Uint32Array,
    normals?: Float32Array,
    uvs?: Float32Array,
    colors?: Float32Array,
): MeshData {
    const vertexCount = positions.length / 3;
    return {
        positions,
        normals: normals ?? new Float32Array(vertexCount * 3),
        uvs: uvs ?? new Float32Array(vertexCount * 2),
        colors: colors ?? new Float32Array(vertexCount * 4),
        indices,
        vertexCount,
        indexCount: indices.length,
        bounds: computeBoundingSphere(positions, vertexCount),
    };
}

function computeBoundingSphere(positions: Float32Array, vertexCount: number): BoundingSphere {
    if (vertexCount === 0) return { cx: 0, cy: 0, cz: 0, radius: 0 };
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < vertexCount; i++) {
        cx += positions[i * 3] ?? 0;
        cy += positions[i * 3 + 1] ?? 0;
        cz += positions[i * 3 + 2] ?? 0;
    }
    cx /= vertexCount; cy /= vertexCount; cz /= vertexCount;
    let maxR2 = 0;
    for (let i = 0; i < vertexCount; i++) {
        const dx = (positions[i * 3] ?? 0) - cx;
        const dy = (positions[i * 3 + 1] ?? 0) - cy;
        const dz = (positions[i * 3 + 2] ?? 0) - cz;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 > maxR2) maxR2 = r2;
    }
    return { cx, cy, cz, radius: Math.sqrt(maxR2) };
}
