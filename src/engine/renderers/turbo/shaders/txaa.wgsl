// Temporal Anti-Aliasing (TXAA) post-process shader.
//
// Blends the current frame with a history buffer using:
// - Per-pixel motion vectors for reprojection (falls back to zero motion if no velocity buffer).
// - YCoCg neighborhood clamping to reject ghosting from stale history.
// - Luminance-weighted blend factor for responsive edges.

struct Params {
    texelSize:   vec2f,   // 1/width, 1/height
    blendFactor: f32,     // base history weight (0.9–0.95 typical)
    _pad0:       f32,
};

@group(0) @binding(0) var currentTex:  texture_2d<f32>;
@group(0) @binding(1) var historyTex:  texture_2d<f32>;
@group(0) @binding(2) var velocityTex: texture_2d<f32>;
@group(0) @binding(3) var texSampler:  sampler;
@group(0) @binding(4) var<uniform> params: Params;

struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
    var out: VsOut;
    let x = f32(i32(vi & 1u)) * 4.0 - 1.0;
    let y = f32(i32(vi >> 1u)) * 4.0 - 1.0;
    out.pos = vec4f(x, y, 0.0, 1.0);
    out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return out;
}

fn rgbToYCoCg(c: vec3f) -> vec3f {
    let co = c.r - c.b;
    let t  = c.b + co * 0.5;
    let cg = c.g - t;
    let y  = t + cg * 0.5;
    return vec3f(y, co, cg);
}

fn yCoCgToRgb(c: vec3f) -> vec3f {
    let t = c.x - c.z * 0.5;
    let g = c.z + t;
    let b = t - c.y * 0.5;
    let r = b + c.y;
    return vec3f(r, g, b);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
    let tx = params.texelSize;

    // Read motion vector for reprojection (rg = screen-space velocity)
    let velocity = textureSample(velocityTex, texSampler, uv).rg;
    let historyUV = clamp(uv - velocity, vec2f(0.0), vec2f(1.0));

    let currentColor = textureSample(currentTex, texSampler, uv).rgb;
    var historyColor = textureSample(historyTex, texSampler, historyUV).rgb;

    // Flag out-of-bounds reprojection — handled later by zeroing blend weight
    let rawUV = uv - velocity;
    let oob = rawUV.x < 0.0 || rawUV.x > 1.0 || rawUV.y < 0.0 || rawUV.y > 1.0;

    // --- Neighborhood clamping in YCoCg space ---
    // Sample 3x3 neighborhood of current frame
    let s0 = rgbToYCoCg(textureSample(currentTex, texSampler, uv + vec2f(-tx.x, -tx.y)).rgb);
    let s1 = rgbToYCoCg(textureSample(currentTex, texSampler, uv + vec2f( 0.0,  -tx.y)).rgb);
    let s2 = rgbToYCoCg(textureSample(currentTex, texSampler, uv + vec2f( tx.x, -tx.y)).rgb);
    let s3 = rgbToYCoCg(textureSample(currentTex, texSampler, uv + vec2f(-tx.x,  0.0)).rgb);
    let s4 = rgbToYCoCg(currentColor);
    let s5 = rgbToYCoCg(textureSample(currentTex, texSampler, uv + vec2f( tx.x,  0.0)).rgb);
    let s6 = rgbToYCoCg(textureSample(currentTex, texSampler, uv + vec2f(-tx.x,  tx.y)).rgb);
    let s7 = rgbToYCoCg(textureSample(currentTex, texSampler, uv + vec2f( 0.0,   tx.y)).rgb);
    let s8 = rgbToYCoCg(textureSample(currentTex, texSampler, uv + vec2f( tx.x,  tx.y)).rgb);

    // AABB of the neighborhood
    var nMin = min(s0, min(s1, min(s2, min(s3, min(s4, min(s5, min(s6, min(s7, s8))))))));
    var nMax = max(s0, max(s1, max(s2, max(s3, max(s4, max(s5, max(s6, max(s7, s8))))))));

    // Tighten the box using cross-shaped samples for better ghosting rejection
    let crossMin = min(s1, min(s3, min(s5, s7)));
    let crossMax = max(s1, max(s3, max(s5, s7)));
    nMin = (nMin + crossMin) * 0.5;
    nMax = (nMax + crossMax) * 0.5;

    // Clamp history to neighborhood
    let histYCoCg = rgbToYCoCg(historyColor);
    let clamped = clamp(histYCoCg, nMin, nMax);
    historyColor = yCoCgToRgb(clamped);

    // --- Luminance-weighted blend ---
    // Reduce history weight where luminance changes rapidly (responsive edges).
    // Zero out weight entirely when history UV was out of bounds.
    let lumaCurrent = s4.x;
    let lumaHistory = clamped.x;
    let lumaDiff = abs(lumaCurrent - lumaHistory) / max(lumaCurrent, max(lumaHistory, 0.2));
    let weight = select(clamp(params.blendFactor * (1.0 - lumaDiff * 0.5), 0.0, 0.98), 0.0, oob);

    let result = mix(currentColor, historyColor, weight);
    return vec4f(result, 1.0);
}
