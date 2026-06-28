import { Exporter } from "@/engine/models/Exporter";
import { Scene } from "@/engine/models/Scene";
import type { Material, SceneObject } from "@/engine/models/SceneObject";
import {
    GL_FLOAT, GL_UNSIGNED_INT,
    GLB_MAGIC, GLB_VERSION, GLB_CHUNK_JSON, GLB_CHUNK_BIN,
    GLB_HEADER_SIZE, GLB_CHUNK_HEADER_SIZE,
    type GltfJson, type GltfAccessor, type GltfBufferView,
    type GltfNode, type GltfMesh, type GltfMaterial,
} from "@/engine/utilities/gltf-types";

/**
 * Exports a Scene to glTF 2.0.
 * - export() produces a self-contained GLB ArrayBuffer.
 * - exportToString() produces a glTF JSON string with an embedded base64 buffer.
 *
 * Engine row-major matrices are transposed to glTF column-major.
 * Each SceneObject becomes a node+mesh. Materials map to pbrMetallicRoughness baseColorFactor.
 */
export class GltfExporter extends Exporter<ArrayBuffer> {
    export(scene: Scene): ArrayBuffer {
        const { json, binBuffer } = this.buildGltf(scene);
        return this.packGlb(json, binBuffer);
    }

    exportToString(scene: Scene): string {
        const { json, binBuffer } = this.buildGltf(scene);
        // Embed binary as base64 data URI
        const bytes = new Uint8Array(binBuffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
        json.buffers![0]!.uri = "data:application/octet-stream;base64," + btoa(binary);
        return JSON.stringify(json);
    }

    private buildGltf(scene: Scene): { json: GltfJson; binBuffer: ArrayBuffer } {
        const objects = [...scene.getObjects()];
        const materials = this.collectMaterials(scene, objects);
        const matIndexMap = new Map<number, number>();
        materials.forEach((m, i) => matIndexMap.set(m.id, i));

        const bufferParts: ArrayBuffer[] = [];
        let byteOffset = 0;

        const bufferViews: GltfBufferView[] = [];
        const accessors: GltfAccessor[] = [];
        const nodes: GltfNode[] = [];
        const meshes: GltfMesh[] = [];

        const pushBufferView = (data: ArrayBuffer, byteLength: number): number => {
            const idx = bufferViews.length;
            bufferViews.push({ buffer: 0, byteOffset, byteLength });
            bufferParts.push(data);
            // Pad to 4-byte alignment
            const padded = align4(byteLength);
            if (padded > byteLength) {
                bufferParts.push(new ArrayBuffer(padded - byteLength));
            }
            byteOffset += padded;
            return idx;
        };

        const pushAccessor = (
            data: Float32Array | Uint32Array,
            componentType: number,
            type: string,
            count: number,
            min?: number[],
            max?: number[],
        ): number => {
            const sliced = new ArrayBuffer(data.byteLength);
            new Uint8Array(sliced).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            const bv = pushBufferView(sliced, data.byteLength);
            const idx = accessors.length;
            const acc: GltfAccessor = { bufferView: bv, byteOffset: 0, componentType, count, type };
            if (min) acc.min = min;
            if (max) acc.max = max;
            accessors.push(acc);
            return idx;
        };

        for (const obj of objects) {
            const mesh = obj.mesh;
            const vc = mesh.vertexCount;

            // Compute position min/max (required by spec)
            const posMin = [Infinity, Infinity, Infinity];
            const posMax = [-Infinity, -Infinity, -Infinity];
            for (let i = 0; i < vc; i++) {
                for (let c = 0; c < 3; c++) {
                    const v = mesh.positions[i * 3 + c] ?? 0;
                    posMin[c] = Math.min(posMin[c]!, v);
                    posMax[c] = Math.max(posMax[c]!, v);
                }
            }

            const attributes: Record<string, number> = {};
            attributes["POSITION"] = pushAccessor(mesh.positions, GL_FLOAT, "VEC3", vc, posMin, posMax);

            if (hasNonZero(mesh.normals)) {
                attributes["NORMAL"] = pushAccessor(mesh.normals, GL_FLOAT, "VEC3", vc);
            }
            if (hasNonZero(mesh.uvs)) {
                attributes["TEXCOORD_0"] = pushAccessor(mesh.uvs, GL_FLOAT, "VEC2", vc);
            }
            if (hasNonZero(mesh.colors)) {
                attributes["COLOR_0"] = pushAccessor(mesh.colors, GL_FLOAT, "VEC4", vc);
            }

            const indicesAccessor = pushAccessor(mesh.indices, GL_UNSIGNED_INT, "SCALAR", mesh.indexCount);

            const meshIdx = meshes.length;
            meshes.push({
                name: obj.name,
                primitives: [{
                    attributes,
                    indices: indicesAccessor,
                    material: matIndexMap.get(obj.materialId),
                    mode: 4, // TRIANGLES
                }],
            });

            nodes.push({
                name: obj.name,
                mesh: meshIdx,
                matrix: transposeRowToCol(obj.transform),
            });
        }

        // Build glTF materials
        const gltfMaterials: GltfMaterial[] = materials.map((m) => ({
            name: `material_${m.id}`,
            pbrMetallicRoughness: {
                baseColorFactor: [
                    m.baseColor[0] ?? 0.8,
                    m.baseColor[1] ?? 0.8,
                    m.baseColor[2] ?? 0.8,
                    m.baseColor[3] ?? 1.0,
                ],
            },
        }));

        // Merge all buffer parts into one contiguous buffer
        const totalBytes = byteOffset;
        const binBuffer = new ArrayBuffer(totalBytes);
        const binView = new Uint8Array(binBuffer);
        let writeOffset = 0;
        for (const part of bufferParts) {
            binView.set(new Uint8Array(part), writeOffset);
            writeOffset += part.byteLength;
        }

        const json: GltfJson = {
            asset: { version: "2.0", generator: "JunkEngine" },
            scene: 0,
            scenes: [{ name: scene.name, nodes: nodes.map((_, i) => i) }],
            nodes,
            meshes,
            accessors,
            bufferViews,
            buffers: [{ byteLength: totalBytes }],
            materials: gltfMaterials.length > 0 ? gltfMaterials : undefined,
        };

        return { json, binBuffer };
    }

    private packGlb(json: GltfJson, binBuffer: ArrayBuffer): ArrayBuffer {
        const jsonStr = JSON.stringify(json);
        const jsonEncoder = new TextEncoder();
        const jsonBytes = jsonEncoder.encode(jsonStr);
        const jsonPadded = align4(jsonBytes.length);
        const binPadded = align4(binBuffer.byteLength);

        const totalSize = GLB_HEADER_SIZE + GLB_CHUNK_HEADER_SIZE + jsonPadded + GLB_CHUNK_HEADER_SIZE + binPadded;
        const glb = new ArrayBuffer(totalSize);
        const view = new DataView(glb);
        const bytes = new Uint8Array(glb);
        let offset = 0;

        // GLB header
        view.setUint32(offset, GLB_MAGIC, true); offset += 4;
        view.setUint32(offset, GLB_VERSION, true); offset += 4;
        view.setUint32(offset, totalSize, true); offset += 4;

        // JSON chunk
        view.setUint32(offset, jsonPadded, true); offset += 4;
        view.setUint32(offset, GLB_CHUNK_JSON, true); offset += 4;
        bytes.set(jsonBytes, offset);
        // Pad JSON with spaces (0x20) per spec
        for (let i = jsonBytes.length; i < jsonPadded; i++) bytes[offset + i] = 0x20;
        offset += jsonPadded;

        // BIN chunk
        view.setUint32(offset, binPadded, true); offset += 4;
        view.setUint32(offset, GLB_CHUNK_BIN, true); offset += 4;
        bytes.set(new Uint8Array(binBuffer), offset);
        // Pad BIN with zeros per spec (already zeroed by ArrayBuffer)

        return glb;
    }

    private collectMaterials(scene: Scene, objects: SceneObject[]): Material[] {
        const ids = new Set(objects.map((o) => o.materialId));
        const mats: Material[] = [];
        for (const id of ids) {
            const m = scene.getMaterial(id);
            if (m) mats.push(m);
        }
        return mats;
    }
}

/** Transpose a row-major 4×4 matrix to column-major (glTF convention). */
function transposeRowToCol(m: Float32Array): number[] {
    return [
        m[0] ?? 0, m[4] ?? 0, m[8] ?? 0, m[12] ?? 0,
        m[1] ?? 0, m[5] ?? 0, m[9] ?? 0, m[13] ?? 0,
        m[2] ?? 0, m[6] ?? 0, m[10] ?? 0, m[14] ?? 0,
        m[3] ?? 0, m[7] ?? 0, m[11] ?? 0, m[15] ?? 0,
    ];
}

function align4(n: number): number {
    return (n + 3) & ~3;
}

function hasNonZero(arr: Float32Array): boolean {
    for (let i = 0; i < arr.length; i++) {
        if ((arr[i] ?? 0) !== 0) return true;
    }
    return false;
}
