/** Minimal glTF 2.0 JSON schema types for import/export. */

export interface GltfJson {
    asset: { version: string; generator?: string };
    scene?: number;
    scenes?: GltfScene[];
    nodes?: GltfNode[];
    meshes?: GltfMesh[];
    accessors?: GltfAccessor[];
    bufferViews?: GltfBufferView[];
    buffers?: GltfBuffer[];
    materials?: GltfMaterial[];
    images?: GltfImage[];
    textures?: GltfTexture[];
}

export interface GltfScene {
    name?: string;
    nodes?: number[];
}

export interface GltfNode {
    name?: string;
    mesh?: number;
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    children?: number[];
}

export interface GltfMesh {
    name?: string;
    primitives: GltfPrimitive[];
}

export interface GltfPrimitive {
    attributes: Record<string, number>;
    indices?: number;
    material?: number;
    mode?: number;
}

export interface GltfAccessor {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    max?: number[];
    min?: number[];
}

export interface GltfBufferView {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
    target?: number;
}

export interface GltfBuffer {
    byteLength: number;
    uri?: string;
}

export interface GltfMaterial {
    name?: string;
    alphaMode?: string;
    alphaCutoff?: number;
    pbrMetallicRoughness?: {
        baseColorFactor?: number[];
        baseColorTexture?: { index: number };
        metallicFactor?: number;
        roughnessFactor?: number;
        metallicRoughnessTexture?: { index: number };
    };
    normalTexture?: { index: number; scale?: number };
}

export interface GltfImage {
    uri?: string;
    mimeType?: string;
    bufferView?: number;
}

export interface GltfTexture {
    source?: number;
}

// glTF component type constants
export const GL_BYTE = 5120;
export const GL_UNSIGNED_BYTE = 5121;
export const GL_SHORT = 5122;
export const GL_UNSIGNED_SHORT = 5123;
export const GL_UNSIGNED_INT = 5125;
export const GL_FLOAT = 5126;

// glTF accessor type → element count
export function gltfTypeCount(type: string): number {
    switch (type) {
        case "SCALAR": return 1;
        case "VEC2": return 2;
        case "VEC3": return 3;
        case "VEC4": return 4;
        case "MAT4": return 16;
        default: return 1;
    }
}

// Component type → byte size
export function componentByteSize(componentType: number): number {
    switch (componentType) {
        case GL_BYTE:
        case GL_UNSIGNED_BYTE: return 1;
        case GL_SHORT:
        case GL_UNSIGNED_SHORT: return 2;
        case GL_UNSIGNED_INT:
        case GL_FLOAT: return 4;
        default: return 1;
    }
}

/** GLB magic and header constants */
export const GLB_MAGIC = 0x46546C67; // "glTF"
export const GLB_VERSION = 2;
export const GLB_CHUNK_JSON = 0x4E4F534A;
export const GLB_CHUNK_BIN = 0x004E4942;
export const GLB_HEADER_SIZE = 12;
export const GLB_CHUNK_HEADER_SIZE = 8;
