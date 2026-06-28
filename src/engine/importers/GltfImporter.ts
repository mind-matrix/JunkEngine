import { Importer } from "@/engine/models/Importer";
import { Scene } from "@/engine/models/Scene";
import { DirtyFlag, createMeshData, createIdentityTransform } from "@/engine/models/SceneObject";
import type { TextureData } from "@/engine/models/SceneObject";
import {
    GL_BYTE, GL_UNSIGNED_BYTE, GL_SHORT, GL_UNSIGNED_SHORT, GL_UNSIGNED_INT, GL_FLOAT,
    GLB_MAGIC, GLB_CHUNK_JSON, GLB_CHUNK_BIN,
    GLB_HEADER_SIZE, GLB_CHUNK_HEADER_SIZE,
    gltfTypeCount, componentByteSize,
    type GltfJson, type GltfAccessor, type GltfNode,
} from "@/engine/utilities/gltf-types";

/**
 * Imports glTF 2.0 into a Scene.
 * - import() accepts a GLB ArrayBuffer (async — decodes embedded images).
 * - importFromString() accepts a glTF JSON string with base64-embedded buffer.
 *
 * Supports: meshes (POSITION, NORMAL, TEXCOORD_0, COLOR_0), indices,
 * node matrix and TRS transforms, pbrMetallicRoughness baseColorFactor/baseColorTexture,
 * and embedded image decoding (JPEG/PNG from bufferViews).
 */
export class GltfImporter extends Importer<ArrayBuffer> {
    /**
     * Synchronous import — does NOT decode textures.
     * Use {@link importAsync} for full texture support.
     */
    import(data: ArrayBuffer): Scene {
        const { json, bin } = this.parseGlb(data);
        return this.buildScene(json, bin, new Map());
    }

    importFromString(str: string): Scene {
        const json: GltfJson = JSON.parse(str);
        const bin = this.resolveBuffer(json);
        return this.buildScene(json, bin, new Map());
    }

    /** Async import that decodes embedded textures into RGBA pixel data. */
    async importAsync(data: ArrayBuffer): Promise<Scene> {
        const { json, bin } = this.parseGlb(data);
        const textures = await this.decodeTextures(json, bin);
        return this.buildScene(json, bin, textures);
    }

    /** Async import from glTF JSON string with texture decoding. */
    async importFromStringAsync(str: string): Promise<Scene> {
        const json: GltfJson = JSON.parse(str);
        const bin = this.resolveBuffer(json);
        const textures = await this.decodeTextures(json, bin);
        return this.buildScene(json, bin, textures);
    }

    // --- GLB parsing ---

    private parseGlb(data: ArrayBuffer): { json: GltfJson; bin: ArrayBuffer } {
        const view = new DataView(data);
        const magic = view.getUint32(0, true);
        if (magic !== GLB_MAGIC) throw new Error(`Invalid GLB magic: 0x${magic.toString(16)}`);

        let offset = GLB_HEADER_SIZE;
        let json: GltfJson | null = null;
        let bin: ArrayBuffer = new ArrayBuffer(0);

        while (offset < data.byteLength) {
            const chunkLength = view.getUint32(offset, true);
            const chunkType = view.getUint32(offset + 4, true);
            offset += GLB_CHUNK_HEADER_SIZE;

            if (chunkType === GLB_CHUNK_JSON) {
                json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, offset, chunkLength)));
            } else if (chunkType === GLB_CHUNK_BIN) {
                bin = data.slice(offset, offset + chunkLength);
            }
            offset += chunkLength;
        }

        if (!json) throw new Error("GLB missing JSON chunk");
        return { json, bin };
    }

    private resolveBuffer(json: GltfJson): ArrayBuffer {
        const bufDef = json.buffers?.[0];
        if (!bufDef?.uri) return new ArrayBuffer(0);

        const prefix = "data:application/octet-stream;base64,";
        if (!bufDef.uri.startsWith(prefix)) {
            throw new Error("Only base64-embedded buffers are supported in glTF JSON mode");
        }
        const b64 = bufDef.uri.slice(prefix.length);
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    }

    // --- Texture decoding ---

    private async decodeTextures(json: GltfJson, bin: ArrayBuffer): Promise<Map<number, TextureData>> {
        const result = new Map<number, TextureData>();
        if (!json.images) return result;

        const promises: Promise<void>[] = [];

        for (let i = 0; i < json.images.length; i++) {
            const img = json.images[i]!;
            if (img.bufferView === undefined) continue;

            const bv = json.bufferViews?.[img.bufferView];
            if (!bv) continue;

            const start = bv.byteOffset ?? 0;
            const imageBytes = new Uint8Array(bin, start, bv.byteLength);
            const blob = new Blob([imageBytes], { type: img.mimeType ?? "image/png" });

            const idx = i;
            promises.push(
                createImageBitmap(blob).then((bitmap) => {
                    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
                    const ctx = canvas.getContext("2d")!;
                    ctx.drawImage(bitmap, 0, 0);
                    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
                    result.set(idx, {
                        pixels: imageData.data,
                        width: bitmap.width,
                        height: bitmap.height,
                    });
                    bitmap.close();
                }),
            );
        }

        await Promise.all(promises);
        return result;
    }

    // --- Scene building ---

    private buildScene(json: GltfJson, bin: ArrayBuffer, decodedImages: Map<number, TextureData>): Scene {
        const sceneDef = json.scenes?.[json.scene ?? 0];
        const sceneName = sceneDef?.name ?? "glTF Import";
        const scene = new Scene(sceneName);

        // Pre-register materials, resolving baseColorTexture → TextureData
        const matIdMap = new Map<number, number>();
        if (json.materials) {
            for (let i = 0; i < json.materials.length; i++) {
                const gmat = json.materials[i]!;
                const pbr = gmat.pbrMetallicRoughness;
                const bc = pbr?.baseColorFactor ?? [1, 1, 1, 1];

                let diffuseTexture: TextureData | null = null;
                if (pbr?.baseColorTexture !== undefined && json.textures) {
                    const texDef = json.textures[pbr.baseColorTexture.index];
                    if (texDef?.source !== undefined) {
                        diffuseTexture = decodedImages.get(texDef.source) ?? null;
                    }
                }

                let metallicRoughnessTexture: TextureData | null = null;
                if (pbr?.metallicRoughnessTexture !== undefined && json.textures) {
                    const texDef = json.textures[pbr.metallicRoughnessTexture.index];
                    if (texDef?.source !== undefined) {
                        metallicRoughnessTexture = decodedImages.get(texDef.source) ?? null;
                    }
                }

                const newId = scene.addMaterial({
                    baseColor: new Float32Array([bc[0] ?? 1, bc[1] ?? 1, bc[2] ?? 1, bc[3] ?? 1]),
                    diffuseTexture,
                    metallicRoughnessTexture,
                    metallicFactor: pbr?.metallicFactor ?? 1,
                    roughnessFactor: pbr?.roughnessFactor ?? 1,
                    alphaMode: gmat.alphaMode ?? "OPAQUE",
                    alphaCutoff: gmat.alphaCutoff ?? 0.5,
                    normalTexture: this.resolveTexture(gmat.normalTexture?.index, json, decodedImages),
                    normalScale: gmat.normalTexture?.scale ?? 1,
                });
                matIdMap.set(i, newId);
            }
        }

        const rootNodes = sceneDef?.nodes ?? [];
        for (const nodeIdx of rootNodes) {
            this.processNode(json, bin, scene, matIdMap, nodeIdx, createIdentityTransform());
        }

        return scene;
    }

    private resolveTexture(
        texIndex: number | undefined,
        json: GltfJson,
        decodedImages: Map<number, TextureData>,
    ): TextureData | null {
        if (texIndex === undefined || !json.textures) return null;
        const texDef = json.textures[texIndex];
        if (texDef?.source === undefined) return null;
        return decodedImages.get(texDef.source) ?? null;
    }

    private processNode(
        json: GltfJson,
        bin: ArrayBuffer,
        scene: Scene,
        matIdMap: Map<number, number>,
        nodeIdx: number,
        parentTransform: Float32Array,
    ): void {
        const node = json.nodes?.[nodeIdx];
        if (!node) return;

        const localTransform = this.resolveNodeTransform(node);
        const worldTransform = mat4MulRowMajor(parentTransform, localTransform);

        if (node.mesh !== undefined) {
            const meshDef = json.meshes?.[node.mesh];
            if (meshDef) {
                for (const prim of meshDef.primitives) {
                    if (prim.mode !== undefined && prim.mode !== 4) continue;

                    const positions = this.readAccessorF32(json, bin, prim.attributes["POSITION"]);
                    if (!positions) continue;

                    const normals = this.readAccessorF32(json, bin, prim.attributes["NORMAL"]);
                    const rawUvs = this.readAccessorF32(json, bin, prim.attributes["TEXCOORD_0"]);
                    // glTF UV origin is top-left; engine sampleTexture expects bottom-left → flip V
                    const uvs = rawUvs ? flipV(rawUvs) : null;
                    const colors = this.readAccessorF32(json, bin, prim.attributes["COLOR_0"]);
                    const indices = this.readAccessorU32(json, bin, prim.indices);

                    const vertexCount = positions.length / 3;
                    const finalIndices = indices ?? sequentialIndices(vertexCount);

                    scene.addObject({
                        name: node.name ?? meshDef.name ?? "mesh",
                        mesh: createMeshData(positions, finalIndices, normals ?? undefined, uvs ?? undefined, colors ?? undefined),
                        transform: worldTransform,
                        materialId: prim.material !== undefined ? (matIdMap.get(prim.material) ?? 0) : 0,
                        dirty: DirtyFlag.ALL as number,
                    });
                }
            }
        }

        if (node.children) {
            for (const childIdx of node.children) {
                this.processNode(json, bin, scene, matIdMap, childIdx, worldTransform);
            }
        }
    }

    /** Resolves a node's local transform from matrix or TRS properties. */
    private resolveNodeTransform(node: GltfNode): Float32Array {
        if (node.matrix && node.matrix.length === 16) {
            return transposeColToRow(node.matrix);
        }

        // TRS decomposition (glTF defaults: T=[0,0,0], R=[0,0,0,1], S=[1,1,1])
        const t = node.translation ?? [0, 0, 0];
        const r = node.rotation ?? [0, 0, 0, 1]; // quaternion xyzw
        const s = node.scale ?? [1, 1, 1];

        // Convert quaternion to rotation matrix, then compose T * R * S (row-major)
        const qx = r[0] ?? 0, qy = r[1] ?? 0, qz = r[2] ?? 0, qw = r[3] ?? 1;
        const sx = s[0] ?? 1, sy = s[1] ?? 1, sz = s[2] ?? 1;
        const tx = t[0] ?? 0, ty = t[1] ?? 0, tz = t[2] ?? 0;

        const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
        const xx = qx * x2, xy = qx * y2, xz = qx * z2;
        const yy = qy * y2, yz = qy * z2, zz = qz * z2;
        const wx = qw * x2, wy = qw * y2, wz = qw * z2;

        // Row-major T * R * S
        return new Float32Array([
            (1 - yy - zz) * sx, (xy - wz) * sy,     (xz + wy) * sz,     tx,
            (xy + wz) * sx,     (1 - xx - zz) * sy,  (yz - wx) * sz,     ty,
            (xz - wy) * sx,     (yz + wx) * sy,      (1 - xx - yy) * sz, tz,
            0,                   0,                    0,                   1,
        ]);
    }

    // --- Accessor reading ---

    private readAccessorF32(json: GltfJson, bin: ArrayBuffer, accessorIdx: number | undefined): Float32Array | null {
        if (accessorIdx === undefined) return null;
        const acc = json.accessors?.[accessorIdx];
        if (!acc) return null;

        const elemCount = gltfTypeCount(acc.type);
        const totalFloats = acc.count * elemCount;
        const raw = this.readRawBytes(json, bin, acc);
        if (!raw) return null;

        if (acc.componentType === GL_FLOAT) {
            return new Float32Array(raw.buffer, raw.byteOffset, totalFloats);
        }

        const out = new Float32Array(totalFloats);
        const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        for (let i = 0; i < totalFloats; i++) {
            out[i] = this.readComponent(dv, i, acc.componentType);
        }
        return out;
    }

    private readAccessorU32(json: GltfJson, bin: ArrayBuffer, accessorIdx: number | undefined): Uint32Array | null {
        if (accessorIdx === undefined) return null;
        const acc = json.accessors?.[accessorIdx];
        if (!acc) return null;

        const raw = this.readRawBytes(json, bin, acc);
        if (!raw) return null;

        const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const out = new Uint32Array(acc.count);
        const cbs = componentByteSize(acc.componentType);

        for (let i = 0; i < acc.count; i++) {
            const byteIdx = i * cbs;
            switch (acc.componentType) {
                case GL_UNSIGNED_BYTE: out[i] = dv.getUint8(byteIdx); break;
                case GL_UNSIGNED_SHORT: out[i] = dv.getUint16(byteIdx, true); break;
                case GL_UNSIGNED_INT: out[i] = dv.getUint32(byteIdx, true); break;
                default: out[i] = dv.getUint32(byteIdx, true);
            }
        }
        return out;
    }

    private readRawBytes(json: GltfJson, bin: ArrayBuffer, acc: GltfAccessor): Uint8Array | null {
        if (acc.bufferView === undefined) return null;
        const bv = json.bufferViews?.[acc.bufferView];
        if (!bv) return null;

        const elemCount = gltfTypeCount(acc.type);
        const cbs = componentByteSize(acc.componentType);
        const stride = bv.byteStride ?? (elemCount * cbs);
        const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);

        if (stride === elemCount * cbs) {
            const byteLen = acc.count * elemCount * cbs;
            return new Uint8Array(bin, start, byteLen);
        }

        const byteLen = acc.count * elemCount * cbs;
        const out = new Uint8Array(byteLen);
        const src = new Uint8Array(bin);
        const elemBytes = elemCount * cbs;
        for (let i = 0; i < acc.count; i++) {
            const srcOff = start + i * stride;
            const dstOff = i * elemBytes;
            for (let b = 0; b < elemBytes; b++) {
                out[dstOff + b] = src[srcOff + b] ?? 0;
            }
        }
        return out;
    }

    private readComponent(dv: DataView, index: number, componentType: number): number {
        const cbs = componentByteSize(componentType);
        const byteIdx = index * cbs;
        switch (componentType) {
            case GL_BYTE: return dv.getInt8(byteIdx) / 127;
            case GL_UNSIGNED_BYTE: return dv.getUint8(byteIdx) / 255;
            case GL_SHORT: return dv.getInt16(byteIdx, true) / 32767;
            case GL_UNSIGNED_SHORT: return dv.getUint16(byteIdx, true) / 65535;
            case GL_UNSIGNED_INT: return dv.getUint32(byteIdx, true);
            case GL_FLOAT: return dv.getFloat32(byteIdx, true);
            default: return 0;
        }
    }
}

function transposeColToRow(m: number[]): Float32Array {
    return new Float32Array([
        m[0] ?? 0, m[4] ?? 0, m[8] ?? 0, m[12] ?? 0,
        m[1] ?? 0, m[5] ?? 0, m[9] ?? 0, m[13] ?? 0,
        m[2] ?? 0, m[6] ?? 0, m[10] ?? 0, m[14] ?? 0,
        m[3] ?? 0, m[7] ?? 0, m[11] ?? 0, m[15] ?? 0,
    ]);
}

function mat4MulRowMajor(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            out[r * 4 + c] =
                (a[r * 4] ?? 0) * (b[c] ?? 0) +
                (a[r * 4 + 1] ?? 0) * (b[4 + c] ?? 0) +
                (a[r * 4 + 2] ?? 0) * (b[8 + c] ?? 0) +
                (a[r * 4 + 3] ?? 0) * (b[12 + c] ?? 0);
        }
    }
    return out;
}

function sequentialIndices(vertexCount: number): Uint32Array {
    const indices = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) indices[i] = i;
    return indices;
}

/** Flip V in a UV array: glTF V=0 is top, engine V=0 is bottom. */
function flipV(uvs: Float32Array): Float32Array {
    const out = new Float32Array(uvs.length);
    for (let i = 0; i < uvs.length; i += 2) {
        out[i] = uvs[i] ?? 0;
        out[i + 1] = 1 - (uvs[i + 1] ?? 0);
    }
    return out;
}
