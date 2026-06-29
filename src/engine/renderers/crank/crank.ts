import { Renderer, Scene } from "@/engine/models";
import type { Material, MeshData } from "@/engine/models";
import type { LightSource } from "@/engine/models/LightSource";
import {
    mat4Multiply,
    mat4MultiplyVec4,
    projectToScreen,
    edgeFunction,
    sampleTexture,
    sortTrianglesByDepth,
    extractFrustumPlanes,
    isSphereOutsideFrustum,
    transformBoundingSphere,
} from "@/engine/utilities/render-utils";
import type { ScreenVertex } from "@/engine/utilities/render-utils";

/** Depth-testing strategy used by {@link CrankRenderer}. */
export type DepthMode = "zbuffer" | "painter";

const BACKGROUND_R = 91;
const BACKGROUND_G = 91;
const BACKGROUND_B = 91;
const BACKGROUND_A = 255;

const AMBIENT = 0.15;

/**
 * "Crank" — a pure CPU software renderer.
 *
 * Renders directly into an `ImageData` pixel buffer using scanline triangle
 * rasterization with perspective-correct barycentric UV interpolation.
 * Supports two depth-testing strategies selectable via {@link depthMode}:
 *
 * - `"zbuffer"` (default) — per-pixel depth test using a `Float32Array` depth buffer.
 *   More correct for overlapping geometry.
 * - `"painter"` — triangles are sorted back-to-front by average depth before
 *   rasterization. Faster but can produce artifacts with intersecting geometry.
 *
 * Materials are resolved per-object: if a {@link Material.diffuseTexture} is
 * present the texture is sampled at the interpolated UV; otherwise the
 * {@link Material.baseColor} solid color is used.
 *
 * The full MVP pipeline is applied per-vertex:
 * `clipPos = projectionMatrix * viewMatrix * modelMatrix * vertexPos`
 *
 * @example
 * ```ts
 * const ctx = canvas.getContext("2d")!;
 * const renderer = new CrankRenderer(canvas, ctx);
 * renderer.depthMode = "painter";
 * renderer.render(scene);
 * ```
 */
export class CrankRenderer extends Renderer<CanvasRenderingContext2D> {
    private _depthMode: DepthMode = "zbuffer";
    private _wireframe = false;
    private imageData: ImageData;
    private pixelBuffer: Uint8ClampedArray;
    private depthBuffer: Float32Array;
    private width: number;
    private height: number;

    constructor(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
        super(canvas, context);
        this.width = canvas.width;
        this.height = canvas.height;
        this.imageData = context.createImageData(this.width, this.height);
        this.pixelBuffer = this.imageData.data;
        this.depthBuffer = new Float32Array(this.width * this.height);
    }

    /** The current depth-testing strategy. */
    get depthMode(): DepthMode {
        return this._depthMode;
    }

    /** Switches the depth-testing strategy. Takes effect on the next {@link render} call. */
    set depthMode(mode: DepthMode) {
        this._depthMode = mode;
    }

    get wireframe(): boolean { return this._wireframe; }
    set wireframe(value: boolean) { this._wireframe = value; }

    /** Fills the pixel buffer with the background color and resets the depth buffer. */
    clear(): void {
        for (let i = 0; i < this.pixelBuffer.length; i += 4) {
            this.pixelBuffer[i] = BACKGROUND_R;
            this.pixelBuffer[i + 1] = BACKGROUND_G;
            this.pixelBuffer[i + 2] = BACKGROUND_B;
            this.pixelBuffer[i + 3] = BACKGROUND_A;
        }
        this.depthBuffer.fill(1.0);
    }

    /**
     * Renders all objects in the scene using the active camera's MVP pipeline.
     * Clears the framebuffer, rasterizes every triangle, then blits the
     * pixel buffer to the canvas in a single `putImageData` call.
     */
    render(scene: Scene): void {
        this.clear();
        const aspect = this.width / this.height;
        const vpMatrix = scene.getViewProjectionMatrix(aspect);
        const frustumPlanes = extractFrustumPlanes(vpMatrix);
        const lights = Array.from(scene.getLights());

        for (const obj of scene.getObjects()) {
            const wb = transformBoundingSphere(obj.mesh.bounds, obj.transform);
            if (isSphereOutsideFrustum(frustumPlanes, wb.cx, wb.cy, wb.cz, wb.radius)) continue;

            const mvp = mat4Multiply(vpMatrix, obj.transform);
            const material = scene.getMaterial(obj.materialId);
            const screenVerts = this.transformVertices(obj.mesh, mvp, obj.transform);

            if (this._wireframe) {
                this.renderWireframe(obj.mesh, screenVerts);
            } else if (this._depthMode === "painter") {
                this.renderPainter(obj.mesh, screenVerts, material, lights);
            } else {
                this.renderZBuffer(obj.mesh, screenVerts, material, lights);
            }
        }

        this.context.putImageData(this.imageData, 0, 0);
    }

    private transformVertices(mesh: MeshData, mvp: Float32Array, modelMatrix: Float32Array): (ScreenVertex | null)[] {
        const verts: (ScreenVertex | null)[] = new Array<ScreenVertex | null>(mesh.vertexCount).fill(null);
        // Extract upper-left 3×3 from row-major model matrix for normal transform
        // (Assumes uniform scale — otherwise need inverse-transpose)
        const nm0 = modelMatrix[0] ?? 1, nm1 = modelMatrix[1] ?? 0, nm2 = modelMatrix[2] ?? 0;
        const nm4 = modelMatrix[4] ?? 0, nm5 = modelMatrix[5] ?? 1, nm6 = modelMatrix[6] ?? 0;
        const nm8 = modelMatrix[8] ?? 0, nm9 = modelMatrix[9] ?? 0, nm10 = modelMatrix[10] ?? 1;
        // Flip normals when the model matrix has a reflection (negative 3×3 determinant)
        const det = nm0 * (nm5 * nm10 - nm6 * nm9) - nm1 * (nm4 * nm10 - nm6 * nm8) + nm2 * (nm4 * nm9 - nm5 * nm8);
        const nSign = det < 0 ? -1 : 1;

        for (let i = 0; i < mesh.vertexCount; i++) {
            const px = mesh.positions[i * 3] ?? 0;
            const py = mesh.positions[i * 3 + 1] ?? 0;
            const pz = mesh.positions[i * 3 + 2] ?? 0;
            const clip = mat4MultiplyVec4(mvp, px, py, pz, 1);
            const sv = projectToScreen(
                clip[0] ?? 0, clip[1] ?? 0, clip[2] ?? 0, clip[3] ?? 0,
                mesh.uvs[i * 2] ?? 0, mesh.uvs[i * 2 + 1] ?? 0,
                this.width, this.height,
            );
            if (sv) {
                const lnx = mesh.normals[i * 3] ?? 0;
                const lny = mesh.normals[i * 3 + 1] ?? 0;
                const lnz = mesh.normals[i * 3 + 2] ?? 0;
                // Transform normal by model matrix 3×3
                let wnx = (nm0 * lnx + nm1 * lny + nm2 * lnz) * nSign;
                let wny = (nm4 * lnx + nm5 * lny + nm6 * lnz) * nSign;
                let wnz = (nm8 * lnx + nm9 * lny + nm10 * lnz) * nSign;
                const len = Math.sqrt(wnx * wnx + wny * wny + wnz * wnz);
                if (len > 0) { wnx /= len; wny /= len; wnz /= len; }
                sv.nx = wnx; sv.ny = wny; sv.nz = wnz;
                // World-space position for TBN computation
                sv.wx = (modelMatrix[0] ?? 0) * px + (modelMatrix[1] ?? 0) * py + (modelMatrix[2] ?? 0) * pz + (modelMatrix[3] ?? 0);
                sv.wy = (modelMatrix[4] ?? 0) * px + (modelMatrix[5] ?? 0) * py + (modelMatrix[6] ?? 0) * pz + (modelMatrix[7] ?? 0);
                sv.wz = (modelMatrix[8] ?? 0) * px + (modelMatrix[9] ?? 0) * py + (modelMatrix[10] ?? 0) * pz + (modelMatrix[11] ?? 0);
            }
            verts[i] = sv;
        }
        return verts;
    }

    private renderZBuffer(mesh: MeshData, screenVerts: (ScreenVertex | null)[], material: Material | undefined, lights: LightSource[]): void {
        for (let i = 0; i < mesh.indexCount; i += 3) {
            const i0 = mesh.indices[i] ?? 0;
            const i1 = mesh.indices[i + 1] ?? 0;
            const i2 = mesh.indices[i + 2] ?? 0;
            const v0 = screenVerts[i0];
            const v1 = screenVerts[i1];
            const v2 = screenVerts[i2];
            if (v0 == null || v1 == null || v2 == null) continue;
            this.rasterizeTriangle(v0, v1, v2, material, true, lights);
        }
    }

    private renderPainter(mesh: MeshData, screenVerts: (ScreenVertex | null)[], material: Material | undefined, lights: LightSource[]): void {
        const indexedVerts: (ScreenVertex | null)[] = new Array<ScreenVertex | null>(mesh.indexCount).fill(null);
        for (let i = 0; i < mesh.indexCount; i++) {
            indexedVerts[i] = screenVerts[mesh.indices[i] ?? 0] ?? null;
        }

        const sorted = sortTrianglesByDepth(indexedVerts, mesh.indexCount);
        for (const tri of sorted) {
            const v0 = indexedVerts[tri.index];
            const v1 = indexedVerts[tri.index + 1];
            const v2 = indexedVerts[tri.index + 2];
            if (v0 == null || v1 == null || v2 == null) continue;
            this.rasterizeTriangle(v0, v1, v2, material, true, lights);
        }
    }

    private renderWireframe(mesh: MeshData, screenVerts: (ScreenVertex | null)[]): void {
        for (let i = 0; i < mesh.indexCount; i += 3) {
            const i0 = mesh.indices[i] ?? 0;
            const i1 = mesh.indices[i + 1] ?? 0;
            const i2 = mesh.indices[i + 2] ?? 0;
            const v0 = screenVerts[i0];
            const v1 = screenVerts[i1];
            const v2 = screenVerts[i2];
            if (v0 == null || v1 == null || v2 == null) continue;
            this.drawLine(v0.sx, v0.sy, v1.sx, v1.sy);
            this.drawLine(v1.sx, v1.sy, v2.sx, v2.sy);
            this.drawLine(v2.sx, v2.sy, v0.sx, v0.sy);
        }
    }

    private drawLine(x0: number, y0: number, x1: number, y1: number): void {
        let dx = Math.abs(x1 - x0);
        let dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        let x = Math.round(x0);
        let y = Math.round(y0);
        const ex = Math.round(x1);
        const ey = Math.round(y1);

        dx = Math.abs(ex - x);
        dy = Math.abs(ey - y);
        err = dx - dy;

        while (true) {
            if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
                const idx = (y * this.width + x) * 4;
                this.pixelBuffer[idx] = 220;
                this.pixelBuffer[idx + 1] = 220;
                this.pixelBuffer[idx + 2] = 220;
                this.pixelBuffer[idx + 3] = 255;
            }
            if (x === ex && y === ey) break;
            const e2 = 2 * err;
            if (e2 > -dy) { err -= dy; x += sx; }
            if (e2 < dx) { err += dx; y += sy; }
        }
    }

    private rasterizeTriangle(
        v0: ScreenVertex, v1: ScreenVertex, v2: ScreenVertex,
        material: Material | undefined,
        useDepthTest: boolean,
        lights: LightSource[],
    ): void {
        let area = edgeFunction(v0.sx, v0.sy, v1.sx, v1.sy, v2.sx, v2.sy);
        if (area === 0) return; // degenerate triangle
        // Negative area means opposite winding — swap v1/v2 to flip
        if (area < 0) {
            [v1, v2] = [v2, v1];
            area = -area;
        }

        const minX = Math.max(0, Math.floor(Math.min(v0.sx, v1.sx, v2.sx)));
        const maxX = Math.min(this.width - 1, Math.ceil(Math.max(v0.sx, v1.sx, v2.sx)));
        const minY = Math.max(0, Math.floor(Math.min(v0.sy, v1.sy, v2.sy)));
        const maxY = Math.min(this.height - 1, Math.ceil(Math.max(v0.sy, v1.sy, v2.sy)));

        const invArea = 1 / area;
        const invW0 = 1 / v0.w, invW1 = 1 / v1.w, invW2 = 1 / v2.w;

        const tex = material?.diffuseTexture ?? null;
        const mrTex = material?.metallicRoughnessTexture ?? null;
        const normalTex = material?.normalTexture ?? null;
        const normalScale = material?.normalScale ?? 1;
        const matMetallic = material?.metallicFactor ?? 1;
        const matRoughness = material?.roughnessFactor ?? 1;
        const hasPbr = mrTex !== null || normalTex !== null || matMetallic < 1 || matRoughness < 1 || lights.length > 0;
        const baseR = ((material?.baseColor[0] ?? 1) * 255) | 0;
        const baseG = ((material?.baseColor[1] ?? 1) * 255) | 0;
        const baseB = ((material?.baseColor[2] ?? 1) * 255) | 0;
        const baseA = ((material?.baseColor[3] ?? 1) * 255) | 0;
        const alphaMask = material?.alphaMode === "MASK";
        const alphaCutoff = (material?.alphaCutoff ?? 0.5) * 255;

        // Precompute per-triangle TBN for normal mapping
        let tbnTx = 0, tbnTy = 0, tbnTz = 0;
        let tbnBx = 0, tbnBy = 0, tbnBz = 0;
        if (normalTex !== null) {
            const e1x = v1.wx - v0.wx, e1y = v1.wy - v0.wy, e1z = v1.wz - v0.wz;
            const e2x = v2.wx - v0.wx, e2y = v2.wy - v0.wy, e2z = v2.wz - v0.wz;
            const du1 = v1.u - v0.u, dv1 = v1.v - v0.v;
            const du2 = v2.u - v0.u, dv2 = v2.v - v0.v;
            const det = du1 * dv2 - du2 * dv1;
            if (Math.abs(det) > 1e-8) {
                const invDet = 1 / det;
                tbnTx = (dv2 * e1x - dv1 * e2x) * invDet;
                tbnTy = (dv2 * e1y - dv1 * e2y) * invDet;
                tbnTz = (dv2 * e1z - dv1 * e2z) * invDet;
                const tLen = Math.sqrt(tbnTx * tbnTx + tbnTy * tbnTy + tbnTz * tbnTz);
                if (tLen > 0) { tbnTx /= tLen; tbnTy /= tLen; tbnTz /= tLen; }
                tbnBx = (-du2 * e1x + du1 * e2x) * invDet;
                tbnBy = (-du2 * e1y + du1 * e2y) * invDet;
                tbnBz = (-du2 * e1z + du1 * e2z) * invDet;
                const bLen = Math.sqrt(tbnBx * tbnBx + tbnBy * tbnBy + tbnBz * tbnBz);
                if (bLen > 0) { tbnBx /= bLen; tbnBy /= bLen; tbnBz /= bLen; }
            }
        }

        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                const px = x + 0.5;
                const py = y + 0.5;

                const w0 = edgeFunction(v1.sx, v1.sy, v2.sx, v2.sy, px, py) * invArea;
                const w1 = edgeFunction(v2.sx, v2.sy, v0.sx, v0.sy, px, py) * invArea;
                const w2 = 1 - w0 - w1;

                if (w0 < 0 || w1 < 0 || w2 < 0) continue;

                const z = w0 * v0.z + w1 * v1.z + w2 * v2.z;
                const bufIdx = y * this.width + x;

                if (useDepthTest && z >= (this.depthBuffer[bufIdx] ?? 1)) continue;

                const correction = 1 / (w0 * invW0 + w1 * invW1 + w2 * invW2);
                const u = (w0 * v0.u * invW0 + w1 * v1.u * invW1 + w2 * v2.u * invW2) * correction;
                const v = (w0 * v0.v * invW0 + w1 * v1.v * invW1 + w2 * v2.v * invW2) * correction;

                let r: number, g: number, b: number, a: number;
                if (tex !== null) {
                    [r, g, b, a] = sampleTexture(tex, u, v);
                } else {
                    r = baseR; g = baseG; b = baseB; a = baseA;
                }

                // Alpha mask discard
                if (alphaMask && a < alphaCutoff) continue;

                if (hasPbr) {
                    // Interpolate world-space normal
                    let nx = (w0 * v0.nx * invW0 + w1 * v1.nx * invW1 + w2 * v2.nx * invW2) * correction;
                    let ny = (w0 * v0.ny * invW0 + w1 * v1.ny * invW1 + w2 * v2.ny * invW2) * correction;
                    let nz = (w0 * v0.nz * invW0 + w1 * v1.nz * invW1 + w2 * v2.nz * invW2) * correction;
                    let nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
                    if (nLen > 0) { nx /= nLen; ny /= nLen; nz /= nLen; }

                    // Perturb normal with tangent-space normal map
                    if (normalTex !== null) {
                        const [nmR, nmG, nmB] = sampleTexture(normalTex, u, v);
                        // Decode [0,255] → [-1,1]
                        const tsX = ((nmR ?? 128) / 127.5 - 1) * normalScale;
                        const tsY = ((nmG ?? 128) / 127.5 - 1) * normalScale;
                        const tsZ = (nmB ?? 255) / 127.5 - 1;
                        // TBN * tangent-space normal
                        let pnx = tbnTx * tsX + tbnBx * tsY + nx * tsZ;
                        let pny = tbnTy * tsX + tbnBy * tsY + ny * tsZ;
                        let pnz = tbnTz * tsX + tbnBz * tsY + nz * tsZ;
                        nLen = Math.sqrt(pnx * pnx + pny * pny + pnz * pnz);
                        if (nLen > 0) { nx = pnx / nLen; ny = pny / nLen; nz = pnz / nLen; }
                    }

                    let metallic = matMetallic;
                    let roughness = matRoughness;
                    if (mrTex !== null) {
                        const [, mrG, mrB] = sampleTexture(mrTex, u, v);
                        roughness *= (mrG ?? 0) / 255;
                        metallic *= (mrB ?? 0) / 255;
                    }

                    const rF = r / 255, gF = g / 255, bF = b / 255;

                    // Fresnel F0
                    const f0R = metallic * rF + (1 - metallic) * 0.04;
                    const f0G = metallic * gF + (1 - metallic) * 0.04;
                    const f0B = metallic * bF + (1 - metallic) * 0.04;

                    // Interpolate world-space position for point lights
                    const wpx = (w0 * v0.wx * invW0 + w1 * v1.wx * invW1 + w2 * v2.wx * invW2) * correction;
                    const wpy = (w0 * v0.wy * invW0 + w1 * v1.wy * invW1 + w2 * v2.wy * invW2) * correction;
                    const wpz = (w0 * v0.wz * invW0 + w1 * v1.wz * invW1 + w2 * v2.wz * invW2) * correction;

                    // Accumulate lighting from all scene lights
                    let diffAccR = AMBIENT, diffAccG = AMBIENT, diffAccB = AMBIENT;
                    let specAccR = 0, specAccG = 0, specAccB = 0;
                    const alpha = roughness * roughness;
                    const shininess = Math.max(1, 2 / (alpha * alpha + 1e-4) - 2);

                    for (let li = 0; li < lights.length; li++) {
                        const light = lights[li]!;
                        let lx: number, ly: number, lz: number, atten: number;

                        if (light.type === "directional") {
                            // Direction points toward surface, negate for L vector
                            lx = -(light.direction[0] ?? 0);
                            ly = -(light.direction[1] ?? 0);
                            lz = -(light.direction[2] ?? 0);
                            atten = 1;
                        } else {
                            // Point light: L = lightPos - fragPos
                            lx = (light.position[0] ?? 0) - wpx;
                            ly = (light.position[1] ?? 0) - wpy;
                            lz = (light.position[2] ?? 0) - wpz;
                            const dist = Math.sqrt(lx * lx + ly * ly + lz * lz);
                            if (dist > 0) { lx /= dist; ly /= dist; lz /= dist; }
                            const att = light.attenuation;
                            atten = 1 / (att.constant + att.linear * dist + att.quadratic * dist * dist);
                        }

                        const intensity = light.intensity * atten;
                        const lcR = (light.color[0] ?? 1) * intensity;
                        const lcG = (light.color[1] ?? 1) * intensity;
                        const lcB = (light.color[2] ?? 1) * intensity;

                        const NdotL = Math.max(0, lx * nx + ly * ny + lz * nz);

                        diffAccR += lcR * NdotL;
                        diffAccG += lcG * NdotL;
                        diffAccB += lcB * NdotL;

                        // Blinn-Phong half-vector (view ≈ +Z)
                        const hx = lx, hy = ly, hz = lz + 1;
                        const hLen = Math.sqrt(hx * hx + hy * hy + hz * hz);
                        const NdotH = hLen > 0 ? Math.max(0, (nx * hx + ny * hy + nz * hz) / hLen) : 0;
                        const specTerm = Math.pow(NdotH, shininess) * NdotL;

                        specAccR += lcR * specTerm;
                        specAccG += lcG * specTerm;
                        specAccB += lcB * specTerm;
                    }

                    r = Math.min(255, ((rF * (1 - metallic) * diffAccR + specAccR * f0R) * 255) | 0);
                    g = Math.min(255, ((gF * (1 - metallic) * diffAccG + specAccG * f0G) * 255) | 0);
                    b = Math.min(255, ((bF * (1 - metallic) * diffAccB + specAccB * f0B) * 255) | 0);
                }

                const pixIdx = bufIdx * 4;
                this.pixelBuffer[pixIdx] = r;
                this.pixelBuffer[pixIdx + 1] = g;
                this.pixelBuffer[pixIdx + 2] = b;
                this.pixelBuffer[pixIdx + 3] = a;
                if (useDepthTest) {
                    this.depthBuffer[bufIdx] = z;
                }
            }
        }
    }
}
