import type { TextureData, BoundingSphere } from "@/engine/models";

// --- Vector operations ---

export function vec3Cross(out: Float32Array, a: Float32Array, b: Float32Array): Float32Array {
    const a0 = a[0] ?? 0, a1 = a[1] ?? 0, a2 = a[2] ?? 0;
    const b0 = b[0] ?? 0, b1 = b[1] ?? 0, b2 = b[2] ?? 0;
    out[0] = a1 * b2 - a2 * b1;
    out[1] = a2 * b0 - a0 * b2;
    out[2] = a0 * b1 - a1 * b0;
    return out;
}

export function vec3Dot(a: Float32Array, b: Float32Array): number {
    return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
}

export function vec3Subtract(out: Float32Array, a: Float32Array, b: Float32Array): Float32Array {
    out[0] = (a[0] ?? 0) - (b[0] ?? 0);
    out[1] = (a[1] ?? 0) - (b[1] ?? 0);
    out[2] = (a[2] ?? 0) - (b[2] ?? 0);
    return out;
}

export function vec3Normalize(out: Float32Array, a: Float32Array): Float32Array {
    const x = a[0] ?? 0, y = a[1] ?? 0, z = a[2] ?? 0;
    let len = x * x + y * y + z * z;
    if (len > 0) {
        len = 1 / Math.sqrt(len);
    }
    out[0] = x * len;
    out[1] = y * len;
    out[2] = z * len;
    return out;
}

// --- Matrix operations ---

export function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            out[i * 4 + j] =
                (a[i * 4] ?? 0) * (b[j] ?? 0) +
                (a[i * 4 + 1] ?? 0) * (b[4 + j] ?? 0) +
                (a[i * 4 + 2] ?? 0) * (b[8 + j] ?? 0) +
                (a[i * 4 + 3] ?? 0) * (b[12 + j] ?? 0);
        }
    }
    return out;
}

export function mat4MultiplyVec4(m: Float32Array, x: number, y: number, z: number, w: number): Float32Array {
    return new Float32Array([
        (m[0] ?? 0) * x + (m[1] ?? 0) * y + (m[2] ?? 0) * z + (m[3] ?? 0) * w,
        (m[4] ?? 0) * x + (m[5] ?? 0) * y + (m[6] ?? 0) * z + (m[7] ?? 0) * w,
        (m[8] ?? 0) * x + (m[9] ?? 0) * y + (m[10] ?? 0) * z + (m[11] ?? 0) * w,
        (m[12] ?? 0) * x + (m[13] ?? 0) * y + (m[14] ?? 0) * z + (m[15] ?? 0) * w,
    ]);
}

export function createPerspectiveMatrix(fov: number, aspect: number, near: number, far: number): Float32Array {
    const out = new Float32Array(16);
    const f = 1.0 / Math.tan(fov / 2);
    const rangeInv = 1 / (near - far);
    out[0] = f / aspect;                // row 0, col 0
    out[5] = f;                          // row 1, col 1
    out[10] = (near + far) * rangeInv;   // row 2, col 2
    out[11] = 2 * near * far * rangeInv; // row 2, col 3
    out[14] = -1;                        // row 3, col 2
    return out;
}

export function createLookAtMatrix(eye: Float32Array, target: Float32Array, up: Float32Array): Float32Array {
    const z = new Float32Array(3);
    const x = new Float32Array(3);
    const y = new Float32Array(3);

    vec3Subtract(z, eye, target);
    vec3Normalize(z, z);
    vec3Cross(x, up, z);
    vec3Normalize(x, x);
    vec3Cross(y, z, x);

    const out = new Float32Array(16);
    out[0] = x[0] ?? 0; out[1] = x[1] ?? 0; out[2]  = x[2] ?? 0; out[3]  = -vec3Dot(x, eye);
    out[4] = y[0] ?? 0; out[5] = y[1] ?? 0; out[6]  = y[2] ?? 0; out[7]  = -vec3Dot(y, eye);
    out[8] = z[0] ?? 0; out[9] = z[1] ?? 0; out[10] = z[2] ?? 0; out[11] = -vec3Dot(z, eye);
    out[12] = 0;         out[13] = 0;         out[14] = 0;          out[15] = 1;
    return out;
}

// --- Rotation matrices ---

export function createRotationY(angle: number): Float32Array {
    const out = new Float32Array(16);
    const c = Math.cos(angle), s = Math.sin(angle);
    out[0] = c;   out[2] = -s;
    out[5] = 1;
    out[8] = s;   out[10] = c;
    out[15] = 1;
    return out;
}

// --- Projection ---

export interface ScreenVertex {
    sx: number;
    sy: number;
    z: number;   // clip-space z for depth
    w: number;   // clip-space w for perspective-correct interpolation
    u: number;
    v: number;
    nx: number;  // world-space normal x
    ny: number;  // world-space normal y
    nz: number;  // world-space normal z
    wx: number;  // world-space position x
    wy: number;  // world-space position y
    wz: number;  // world-space position z
}

export function projectToScreen(
    clipX: number, clipY: number, clipZ: number, clipW: number,
    u: number, v: number,
    width: number, height: number,
): ScreenVertex | null {
    if (clipW <= 0) return null;
    const invW = 1 / clipW;
    const ndcX = clipX * invW;
    const ndcY = clipY * invW;
    const ndcZ = clipZ * invW;
    if (ndcZ < -1 || ndcZ > 1) return null;
    return {
        sx: (ndcX + 1) * 0.5 * width,
        sy: (1 - (ndcY + 1) * 0.5) * height,
        z: ndcZ,
        w: clipW,
        u,
        v,
        nx: 0, ny: 0, nz: 0,
        wx: 0, wy: 0, wz: 0,
    };
}

// --- Triangle rasterization helpers ---

export function edgeFunction(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

// --- Texture sampling ---

export function sampleTexture(tex: TextureData, u: number, v: number): [number, number, number, number] {
    const tu = ((u % 1) + 1) % 1;
    const tv = ((v % 1) + 1) % 1;
    const px = Math.min(Math.floor(tu * tex.width), tex.width - 1);
    const py = Math.min(Math.floor((1 - tv) * tex.height), tex.height - 1);
    const idx = (py * tex.width + px) * 4;
    return [
        tex.pixels[idx] ?? 0,
        tex.pixels[idx + 1] ?? 0,
        tex.pixels[idx + 2] ?? 0,
        tex.pixels[idx + 3] ?? 255,
    ];
}

// --- Frustum culling ---

/**
 * Extracts 6 frustum planes from a row-major view-projection matrix.
 * Each plane is [a, b, c, d] where ax+by+cz+d >= 0 is inside.
 * Order: left, right, bottom, top, near, far.
 */
export function extractFrustumPlanes(vp: Float32Array): Float32Array {
    const planes = new Float32Array(24); // 6 planes × 4 components
    // Row-major: row i is vp[i*4..i*4+3]
    for (let i = 0; i < 4; i++) {
        const r0 = vp[i] ?? 0;       // row 0 col i
        const r1 = vp[4 + i] ?? 0;   // row 1 col i
        const r2 = vp[8 + i] ?? 0;   // row 2 col i
        const r3 = vp[12 + i] ?? 0;  // row 3 col i
        // left:   row3 + row0
        planes[0 * 4 + i] = r3 + r0;
        // right:  row3 - row0
        planes[1 * 4 + i] = r3 - r0;
        // bottom: row3 + row1
        planes[2 * 4 + i] = r3 + r1;
        // top:    row3 - row1
        planes[3 * 4 + i] = r3 - r1;
        // near:   row3 + row2
        planes[4 * 4 + i] = r3 + r2;
        // far:    row3 - row2
        planes[5 * 4 + i] = r3 - r2;
    }
    // Normalize each plane
    for (let p = 0; p < 6; p++) {
        const o = p * 4;
        const a = planes[o] ?? 0, b = planes[o + 1] ?? 0, c = planes[o + 2] ?? 0;
        const len = Math.sqrt(a * a + b * b + c * c);
        if (len > 0) {
            planes[o] = a / len;
            planes[o + 1] = b / len;
            planes[o + 2] = c / len;
            planes[o + 3] = (planes[o + 3] ?? 0) / len;
        }
    }
    return planes;
}

/** Returns true if the sphere is fully outside any frustum plane. */
export function isSphereOutsideFrustum(
    planes: Float32Array,
    cx: number, cy: number, cz: number, radius: number,
): boolean {
    for (let p = 0; p < 6; p++) {
        const o = p * 4;
        const dist = (planes[o] ?? 0) * cx + (planes[o + 1] ?? 0) * cy
                   + (planes[o + 2] ?? 0) * cz + (planes[o + 3] ?? 0);
        if (dist < -radius) return true;
    }
    return false;
}

/** Transforms a bounding sphere center by a row-major 4×4 matrix and scales radius by max axis scale. */
export function transformBoundingSphere(
    bounds: BoundingSphere, model: Float32Array,
): { cx: number; cy: number; cz: number; radius: number } {
    const cx = (model[0] ?? 0) * bounds.cx + (model[1] ?? 0) * bounds.cy + (model[2] ?? 0) * bounds.cz + (model[3] ?? 0);
    const cy = (model[4] ?? 0) * bounds.cx + (model[5] ?? 0) * bounds.cy + (model[6] ?? 0) * bounds.cz + (model[7] ?? 0);
    const cz = (model[8] ?? 0) * bounds.cx + (model[9] ?? 0) * bounds.cy + (model[10] ?? 0) * bounds.cz + (model[11] ?? 0);
    // Max column length of upper-left 3×3 for uniform-ish scale
    const sx = Math.sqrt(((model[0] ?? 0) ** 2) + ((model[4] ?? 0) ** 2) + ((model[8] ?? 0) ** 2));
    const sy = Math.sqrt(((model[1] ?? 0) ** 2) + ((model[5] ?? 0) ** 2) + ((model[9] ?? 0) ** 2));
    const sz = Math.sqrt(((model[2] ?? 0) ** 2) + ((model[6] ?? 0) ** 2) + ((model[10] ?? 0) ** 2));
    return { cx, cy, cz, radius: bounds.radius * Math.max(sx, sy, sz) };
}

// --- Face sorting (painter's algorithm) ---

export interface SortedTriangle {
    index: number;
    avgDepth: number;
}

export function sortTrianglesByDepth(
    screenVerts: (ScreenVertex | null)[],
    indexCount: number,
): SortedTriangle[] {
    const triangles: SortedTriangle[] = [];
    for (let i = 0; i < indexCount; i += 3) {
        const v0 = screenVerts[i];
        const v1 = screenVerts[i + 1];
        const v2 = screenVerts[i + 2];
        if (v0 === null || v0 === undefined ||
            v1 === null || v1 === undefined ||
            v2 === null || v2 === undefined) continue;
        triangles.push({
            index: i,
            avgDepth: (v0.z + v1.z + v2.z) / 3,
        });
    }
    triangles.sort((a, b) => b.avgDepth - a.avgDepth);
    return triangles;
}
