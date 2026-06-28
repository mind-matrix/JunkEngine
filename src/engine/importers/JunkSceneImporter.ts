import { Importer } from "@/engine/models/Importer";
import { Scene } from "@/engine/models/Scene";
import { DirtyFlag, createMeshData } from "@/engine/models/SceneObject";

const MAGIC = 0x4A4E4B53;
const VERSION = 1;

export class JunkSceneImporter extends Importer<ArrayBuffer> {
    import(data: ArrayBuffer): Scene {
        const view = new DataView(data);
        let offset = 0;

        const readU8 = (): number => { const v = view.getUint8(offset); offset += 1; return v; };
        const readU32 = (): number => { const v = view.getUint32(offset, true); offset += 4; return v; };
        const readF32 = (): number => { const v = view.getFloat32(offset, true); offset += 4; return v; };
        const readStr = (): string => {
            const len = readU32();
            const bytes = new Uint8Array(data, offset, len);
            offset += len;
            return new TextDecoder().decode(bytes);
        };
        const readF32Array = (count: number): Float32Array => {
            const arr = new Float32Array(count);
            for (let i = 0; i < count; i++) arr[i] = readF32();
            return arr;
        };
        const readU32Array = (count: number): Uint32Array => {
            const arr = new Uint32Array(count);
            for (let i = 0; i < count; i++) arr[i] = readU32();
            return arr;
        };

        // Header
        const magic = readU32();
        if (magic !== MAGIC) throw new Error(`Invalid JunkScene magic: 0x${magic.toString(16)}`);
        const version = readU32();
        if (version !== VERSION) throw new Error(`Unsupported JunkScene version: ${version}`);
        const sceneName = readStr();

        const scene = new Scene(sceneName);

        // Camera
        scene.camera.position = readF32Array(3);
        scene.camera.target = readF32Array(3);
        scene.camera.up = readF32Array(3);
        scene.camera.fov = readF32();
        scene.camera.near = readF32();
        scene.camera.far = readF32();

        // Materials
        const matCount = readU32();
        const matIdMap = new Map<number, number>(); // original id → new id
        for (let i = 0; i < matCount; i++) {
            const origId = readU32();
            const baseColor = readF32Array(4);
            const hasTex = readU8() !== 0;
            let diffuseTexture = null;
            if (hasTex) {
                const width = readU32();
                const height = readU32();
                const pixelLen = width * height * 4;
                const pixels = new Uint8ClampedArray(data.slice(offset, offset + pixelLen));
                offset += pixelLen;
                diffuseTexture = { pixels, width, height };
            }
            const newId = scene.addMaterial({ baseColor, diffuseTexture, metallicRoughnessTexture: null, metallicFactor: 1, roughnessFactor: 1, alphaMode: "OPAQUE", alphaCutoff: 0.5, normalTexture: null, normalScale: 1 });
            matIdMap.set(origId, newId);
        }

        // Objects
        const objCount = readU32();
        for (let i = 0; i < objCount; i++) {
            readU32(); // original id (discarded, Scene assigns new ids)
            const name = readStr();
            const origMatId = readU32();
            const transform = readF32Array(16);
            const vertexCount = readU32();
            const indexCount = readU32();
            const positions = readF32Array(vertexCount * 3);
            const normals = readF32Array(vertexCount * 3);
            const uvs = readF32Array(vertexCount * 2);
            const colors = readF32Array(vertexCount * 4);
            const indices = readU32Array(indexCount);

            scene.addObject({
                name,
                mesh: createMeshData(positions, indices, normals, uvs, colors),
                transform,
                materialId: matIdMap.get(origMatId) ?? 0,
                dirty: DirtyFlag.ALL as number,
            });
        }

        return scene;
    }

    importFromString(str: string): Scene {
        const binary = atob(str);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return this.import(bytes.buffer);
    }
}
