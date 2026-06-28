import { Importer } from "@/engine/models/Importer";
import { Scene } from "@/engine/models/Scene";
import { DirtyFlag, createMeshData, createIdentityTransform } from "@/engine/models/SceneObject";

/**
 * Imports Wavefront OBJ text into a Scene.
 * Supports v, vn, vt, f (with v, v/vt, v/vt/vn, v//vn formats), and o/g groups.
 * Each named group becomes a separate SceneObject with an identity transform.
 */
export class ObjImporter extends Importer<string> {
    import(data: string): Scene {
        return this.importFromString(data);
    }

    importFromString(str: string): Scene {
        const scene = new Scene("OBJ Import");

        // Global attribute pools (OBJ indices are global across groups)
        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];

        // Per-group accumulators
        let groupName = "default";
        let faceVerts: number[] = [];
        let faceNormals: number[] = [];
        let faceUVs: number[] = [];
        let faceIndices: number[] = [];
        let vertexCount = 0;

        const flushGroup = () => {
            if (vertexCount === 0) return;
            const matId = scene.addMaterial({
                baseColor: new Float32Array([0.8, 0.8, 0.8, 1.0]),
                diffuseTexture: null,
                metallicRoughnessTexture: null,
                metallicFactor: 1,
                roughnessFactor: 1,
                alphaMode: "OPAQUE",
                alphaCutoff: 0.5,
                normalTexture: null,
                normalScale: 1,
            });
            scene.addObject({
                name: groupName,
                mesh: createMeshData(
                    new Float32Array(faceVerts),
                    new Uint32Array(faceIndices),
                    faceNormals.length > 0 ? new Float32Array(faceNormals) : undefined,
                    faceUVs.length > 0 ? new Float32Array(faceUVs) : undefined,
                ),
                transform: createIdentityTransform(),
                materialId: matId,
                dirty: DirtyFlag.ALL as number,
            });
            faceVerts = [];
            faceNormals = [];
            faceUVs = [];
            faceIndices = [];
            vertexCount = 0;
        };

        const lines = str.split("\n");
        for (const raw of lines) {
            const line = raw.trim();
            if (line.length === 0 || line[0] === "#") continue;

            const parts = line.split(/\s+/);
            const cmd = parts[0];

            if (cmd === "v") {
                positions.push(
                    parseFloat(parts[1] ?? "0"),
                    parseFloat(parts[2] ?? "0"),
                    parseFloat(parts[3] ?? "0"),
                );
            } else if (cmd === "vn") {
                normals.push(
                    parseFloat(parts[1] ?? "0"),
                    parseFloat(parts[2] ?? "0"),
                    parseFloat(parts[3] ?? "0"),
                );
            } else if (cmd === "vt") {
                uvs.push(
                    parseFloat(parts[1] ?? "0"),
                    parseFloat(parts[2] ?? "0"),
                );
            } else if (cmd === "o" || cmd === "g") {
                flushGroup();
                groupName = parts.slice(1).join(" ") || "unnamed";
            } else if (cmd === "f") {
                // Triangulate n-gon faces via fan triangulation
                const faceVertIndices: number[] = [];
                for (let i = 1; i < parts.length; i++) {
                    const segments = (parts[i] ?? "").split("/");
                    const vi = parseInt(segments[0] ?? "0", 10) - 1;
                    const ti = segments[1] ? parseInt(segments[1], 10) - 1 : -1;
                    const ni = segments[2] ? parseInt(segments[2], 10) - 1 : -1;

                    faceVerts.push(
                        positions[vi * 3] ?? 0,
                        positions[vi * 3 + 1] ?? 0,
                        positions[vi * 3 + 2] ?? 0,
                    );
                    if (ni >= 0) {
                        faceNormals.push(
                            normals[ni * 3] ?? 0,
                            normals[ni * 3 + 1] ?? 0,
                            normals[ni * 3 + 2] ?? 0,
                        );
                    }
                    if (ti >= 0) {
                        faceUVs.push(
                            uvs[ti * 2] ?? 0,
                            uvs[ti * 2 + 1] ?? 0,
                        );
                    }
                    faceVertIndices.push(vertexCount++);
                }
                // Fan triangulation: 0-1-2, 0-2-3, 0-3-4, ...
                for (let i = 1; i + 1 < faceVertIndices.length; i++) {
                    faceIndices.push(faceVertIndices[0]!, faceVertIndices[i]!, faceVertIndices[i + 1]!);
                }
            }
        }

        flushGroup();
        return scene;
    }
}
