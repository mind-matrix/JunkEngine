import { Exporter } from "@/engine/models/Exporter";
import { Scene } from "@/engine/models/Scene";

/**
 * Exports scene geometry to Wavefront OBJ format.
 * Each SceneObject becomes a named group. Transforms are baked into vertex positions.
 * Materials and textures are not included (OBJ delegates those to .mtl files).
 */
export class ObjExporter extends Exporter<string> {
    export(scene: Scene): string {
        return this.exportToString(scene);
    }

    exportToString(scene: Scene): string {
        const lines: string[] = [`# JunkEngine OBJ Export - ${scene.name}`];
        let vertexOffset = 0;

        for (const obj of scene.getObjects()) {
            const mesh = obj.mesh;
            const t = obj.transform;
            lines.push(`o ${obj.name}`);

            // Emit positions (transformed by model matrix)
            for (let i = 0; i < mesh.vertexCount; i++) {
                const x = mesh.positions[i * 3] ?? 0;
                const y = mesh.positions[i * 3 + 1] ?? 0;
                const z = mesh.positions[i * 3 + 2] ?? 0;
                const tx = (t[0]??0)*x + (t[1]??0)*y + (t[2]??0)*z + (t[3]??0);
                const ty = (t[4]??0)*x + (t[5]??0)*y + (t[6]??0)*z + (t[7]??0);
                const tz = (t[8]??0)*x + (t[9]??0)*y + (t[10]??0)*z + (t[11]??0);
                lines.push(`v ${tx} ${ty} ${tz}`);
            }

            // Emit normals (rotate only, no translation)
            let hasNormals = false;
            for (let i = 0; i < mesh.vertexCount; i++) {
                const nx = mesh.normals[i * 3] ?? 0;
                const ny = mesh.normals[i * 3 + 1] ?? 0;
                const nz = mesh.normals[i * 3 + 2] ?? 0;
                if (nx !== 0 || ny !== 0 || nz !== 0) hasNormals = true;
                const tnx = (t[0]??0)*nx + (t[1]??0)*ny + (t[2]??0)*nz;
                const tny = (t[4]??0)*nx + (t[5]??0)*ny + (t[6]??0)*nz;
                const tnz = (t[8]??0)*nx + (t[9]??0)*ny + (t[10]??0)*nz;
                lines.push(`vn ${tnx} ${tny} ${tnz}`);
            }

            // Emit UVs
            let hasUVs = false;
            for (let i = 0; i < mesh.vertexCount; i++) {
                const u = mesh.uvs[i * 2] ?? 0;
                const v = mesh.uvs[i * 2 + 1] ?? 0;
                if (u !== 0 || v !== 0) hasUVs = true;
                lines.push(`vt ${u} ${v}`);
            }

            // Emit faces (OBJ indices are 1-based)
            for (let i = 0; i < mesh.indexCount; i += 3) {
                const a = (mesh.indices[i] ?? 0) + 1 + vertexOffset;
                const b = (mesh.indices[i + 1] ?? 0) + 1 + vertexOffset;
                const c = (mesh.indices[i + 2] ?? 0) + 1 + vertexOffset;
                if (hasUVs && hasNormals) {
                    lines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
                } else if (hasNormals) {
                    lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
                } else if (hasUVs) {
                    lines.push(`f ${a}/${a} ${b}/${b} ${c}/${c}`);
                } else {
                    lines.push(`f ${a} ${b} ${c}`);
                }
            }

            vertexOffset += mesh.vertexCount;
        }

        return lines.join("\n") + "\n";
    }
}
