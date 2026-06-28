import { Exporter } from "@/engine/models/Exporter";
import { Scene } from "@/engine/models/Scene";
import type { Material, SceneObject } from "@/engine/models/SceneObject";

const MAGIC = 0x4A4E4B53; // "JNKS"
const VERSION = 1;

/**
 * Binary format layout (all little-endian):
 *
 * [Header]
 *   u32  magic
 *   u32  version
 *   u32  nameLen → name (UTF-8 bytes)
 *
 * [Camera] (60 bytes)
 *   f32×3 position, f32×3 target, f32×3 up, f32 fov, f32 near, f32 far
 *
 * [Materials]
 *   u32  materialCount
 *   per material:
 *     u32  id
 *     f32×4 baseColor
 *     u8   hasTexture
 *     if hasTexture:
 *       u32 width, u32 height, u8[] pixels (w*h*4)
 *
 * [Objects]
 *   u32  objectCount
 *   per object:
 *     u32  id
 *     u32  nameLen → name (UTF-8)
 *     u32  materialId
 *     f32×16 transform
 *     u32  vertexCount, u32 indexCount
 *     f32[] positions (vc*3)
 *     f32[] normals   (vc*3)
 *     f32[] uvs       (vc*2)
 *     f32[] colors    (vc*4)
 *     u32[] indices   (ic)
 */
export class JunkSceneExporter extends Exporter<ArrayBuffer> {
    export(scene: Scene): ArrayBuffer {
        const objects = [...scene.getObjects()];
        const materials = this.collectMaterials(scene, objects);

        const size = this.computeSize(scene, materials, objects);
        const buffer = new ArrayBuffer(size);
        const view = new DataView(buffer);
        let offset = 0;

        const writeU8 = (v: number) => { view.setUint8(offset, v); offset += 1; };
        const writeU32 = (v: number) => { view.setUint32(offset, v, true); offset += 4; };
        const writeF32 = (v: number) => { view.setFloat32(offset, v, true); offset += 4; };
        const writeStr = (s: string) => {
            const encoded = new TextEncoder().encode(s);
            writeU32(encoded.length);
            new Uint8Array(buffer, offset, encoded.length).set(encoded);
            offset += encoded.length;
        };
        const writeF32Array = (a: Float32Array) => {
            for (let i = 0; i < a.length; i++) writeF32(a[i] ?? 0);
        };
        const writeU32Array = (a: Uint32Array) => {
            for (let i = 0; i < a.length; i++) writeU32(a[i] ?? 0);
        };

        // Header
        writeU32(MAGIC);
        writeU32(VERSION);
        writeStr(scene.name);

        // Camera
        const cam = scene.camera;
        writeF32Array(cam.position);
        writeF32Array(cam.target);
        writeF32Array(cam.up);
        writeF32(cam.fov);
        writeF32(cam.near);
        writeF32(cam.far);

        // Materials
        writeU32(materials.length);
        for (const mat of materials) {
            writeU32(mat.id);
            writeF32Array(mat.baseColor);
            const hasTex = mat.diffuseTexture !== null;
            writeU8(hasTex ? 1 : 0);
            if (hasTex && mat.diffuseTexture) {
                writeU32(mat.diffuseTexture.width);
                writeU32(mat.diffuseTexture.height);
                const px = mat.diffuseTexture.pixels;
                new Uint8Array(buffer, offset, px.length).set(px);
                offset += px.length;
            }
        }

        // Objects
        writeU32(objects.length);
        for (const obj of objects) {
            writeU32(obj.id);
            writeStr(obj.name);
            writeU32(obj.materialId);
            writeF32Array(obj.transform);
            writeU32(obj.mesh.vertexCount);
            writeU32(obj.mesh.indexCount);
            writeF32Array(obj.mesh.positions);
            writeF32Array(obj.mesh.normals);
            writeF32Array(obj.mesh.uvs);
            writeF32Array(obj.mesh.colors);
            writeU32Array(obj.mesh.indices);
        }

        return buffer;
    }

    exportToString(scene: Scene): string {
        const buf = this.export(scene);
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
        return btoa(binary);
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

    private computeSize(scene: Scene, materials: Material[], objects: SceneObject[]): number {
        const nameBytes = new TextEncoder().encode(scene.name).length;
        let size = 4 + 4 + 4 + nameBytes; // magic + version + nameLen + name
        size += 60; // camera
        size += 4;  // material count
        for (const mat of materials) {
            size += 4 + 16 + 1; // id + baseColor + hasTexture
            if (mat.diffuseTexture) {
                size += 4 + 4 + mat.diffuseTexture.width * mat.diffuseTexture.height * 4;
            }
        }
        size += 4; // object count
        for (const obj of objects) {
            const objNameBytes = new TextEncoder().encode(obj.name).length;
            size += 4 + 4 + objNameBytes + 4 + 64; // id + nameLen + name + matId + transform
            size += 4 + 4; // vertexCount + indexCount
            const vc = obj.mesh.vertexCount;
            const ic = obj.mesh.indexCount;
            size += vc * 3 * 4; // positions
            size += vc * 3 * 4; // normals
            size += vc * 2 * 4; // uvs
            size += vc * 4 * 4; // colors
            size += ic * 4;     // indices
        }
        return size;
    }
}
