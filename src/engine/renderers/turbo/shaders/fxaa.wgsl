// FXAA post-process shader (quality preset 12, based on Nvidia FXAA 3.11 algorithm).
//
// Performs luminance-based edge detection, determines edge direction,
// walks along the edge in both directions to find endpoints, then
// blends the pixel with its neighbor to smooth the jagged edge.
//
// All textureSample calls are in uniform control flow (no early returns,
// no samples inside data-dependent branches).

struct Params {
    texelSize: vec2f,   // 1/width, 1/height
    _pad0:     f32,
    _pad1:     f32,
};

@group(0) @binding(0) var colorTex:   texture_2d<f32>;
@group(0) @binding(1) var texSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

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

const EDGE_THRESHOLD_MIN: f32 = 0.0312;
const EDGE_THRESHOLD:     f32 = 0.125;
const SUBPIXEL_QUALITY:   f32 = 0.75;

fn luma(c: vec3f) -> f32 {
    return dot(c, vec3f(0.299, 0.587, 0.114));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
    let tx = params.texelSize;

    // --- Sample center and 8 neighbors (all in uniform flow) ---
    let center = textureSample(colorTex, texSampler, uv);
    let lumaC = luma(center.rgb);

    let lumaU  = luma(textureSample(colorTex, texSampler, uv + vec2f( 0.0, -tx.y)).rgb);
    let lumaD  = luma(textureSample(colorTex, texSampler, uv + vec2f( 0.0,  tx.y)).rgb);
    let lumaL  = luma(textureSample(colorTex, texSampler, uv + vec2f(-tx.x,  0.0)).rgb);
    let lumaR  = luma(textureSample(colorTex, texSampler, uv + vec2f( tx.x,  0.0)).rgb);
    let lumaTL = luma(textureSample(colorTex, texSampler, uv + vec2f(-tx.x, -tx.y)).rgb);
    let lumaTR = luma(textureSample(colorTex, texSampler, uv + vec2f( tx.x, -tx.y)).rgb);
    let lumaBL = luma(textureSample(colorTex, texSampler, uv + vec2f(-tx.x,  tx.y)).rgb);
    let lumaBR = luma(textureSample(colorTex, texSampler, uv + vec2f( tx.x,  tx.y)).rgb);

    let lumaMin = min(lumaC, min(min(lumaU, lumaD), min(lumaL, lumaR)));
    let lumaMax = max(lumaC, max(max(lumaU, lumaD), max(lumaL, lumaR)));
    let lumaRange = lumaMax - lumaMin;

    // Low contrast flag — will select center at the end instead of early return
    let lowContrast = lumaRange < max(EDGE_THRESHOLD_MIN, lumaMax * EDGE_THRESHOLD);

    let lumaUD  = lumaU + lumaD;
    let lumaLR  = lumaL + lumaR;
    let lumaTLR = lumaTL + lumaTR;
    let lumaBLR = lumaBL + lumaBR;
    let lumaLCol = lumaTL + lumaBL;
    let lumaRCol = lumaTR + lumaBR;

    // Edge direction
    let edgeH = abs(-2.0 * lumaL + lumaLCol) + abs(-2.0 * lumaC + lumaUD) * 2.0 + abs(-2.0 * lumaR + lumaRCol);
    let edgeV = abs(-2.0 * lumaU + lumaTLR) + abs(-2.0 * lumaC + lumaLR) * 2.0 + abs(-2.0 * lumaD + lumaBLR);
    let isHorizontal = edgeH >= edgeV;

    let stepLen = select(tx.x, tx.y, isHorizontal);
    let luma1 = select(lumaL, lumaU, isHorizontal);
    let luma2 = select(lumaR, lumaD, isHorizontal);
    let grad1 = abs(luma1 - lumaC);
    let grad2 = abs(luma2 - lumaC);

    let steepest1 = grad1 >= grad2;
    let lumaLocalAvg = select(0.5 * (luma2 + lumaC), 0.5 * (luma1 + lumaC), steepest1);
    let gradScaled = 0.25 * max(grad1, grad2);
    let signedStep = select(stepLen, -stepLen, steepest1);

    // Shift UV to edge center
    var edgeUV = uv;
    if (isHorizontal) { edgeUV.y += signedStep * 0.5; }
    else              { edgeUV.x += signedStep * 0.5; }

    let edgeStep = select(vec2f(0.0, tx.y), vec2f(tx.x, 0.0), isHorizontal);

    // --- Edge search: always sample, conditionally advance via select() ---
    var uvP = edgeUV + edgeStep;
    var uvN = edgeUV - edgeStep;

    let sP0 = textureSample(colorTex, texSampler, uvP).rgb;
    let sN0 = textureSample(colorTex, texSampler, uvN).rgb;
    var lumaEndP = luma(sP0) - lumaLocalAvg;
    var lumaEndN = luma(sN0) - lumaLocalAvg;
    var reachedP = abs(lumaEndP) >= gradScaled;
    var reachedN = abs(lumaEndN) >= gradScaled;

    let qualities = array<f32, 12>(1.0, 1.0, 1.0, 1.0, 1.0, 1.5, 2.0, 2.0, 2.0, 2.0, 4.0, 8.0);

    // Unrolled search — always sample at candidate UV, use select() to keep or discard
    var candidateP: vec2f; var candidateN: vec2f;

    candidateP = uvP + edgeStep * qualities[1];
    candidateN = uvN - edgeStep * qualities[1];
    let sP1 = luma(textureSample(colorTex, texSampler, candidateP).rgb) - lumaLocalAvg;
    let sN1 = luma(textureSample(colorTex, texSampler, candidateN).rgb) - lumaLocalAvg;
    uvP = select(candidateP, uvP, reachedP); lumaEndP = select(sP1, lumaEndP, reachedP); reachedP = reachedP || abs(lumaEndP) >= gradScaled;
    uvN = select(candidateN, uvN, reachedN); lumaEndN = select(sN1, lumaEndN, reachedN); reachedN = reachedN || abs(lumaEndN) >= gradScaled;

    candidateP = uvP + edgeStep * qualities[2];
    candidateN = uvN - edgeStep * qualities[2];
    let sP2 = luma(textureSample(colorTex, texSampler, candidateP).rgb) - lumaLocalAvg;
    let sN2 = luma(textureSample(colorTex, texSampler, candidateN).rgb) - lumaLocalAvg;
    uvP = select(candidateP, uvP, reachedP); lumaEndP = select(sP2, lumaEndP, reachedP); reachedP = reachedP || abs(lumaEndP) >= gradScaled;
    uvN = select(candidateN, uvN, reachedN); lumaEndN = select(sN2, lumaEndN, reachedN); reachedN = reachedN || abs(lumaEndN) >= gradScaled;

    candidateP = uvP + edgeStep * qualities[3];
    candidateN = uvN - edgeStep * qualities[3];
    let sP3 = luma(textureSample(colorTex, texSampler, candidateP).rgb) - lumaLocalAvg;
    let sN3 = luma(textureSample(colorTex, texSampler, candidateN).rgb) - lumaLocalAvg;
    uvP = select(candidateP, uvP, reachedP); lumaEndP = select(sP3, lumaEndP, reachedP); reachedP = reachedP || abs(lumaEndP) >= gradScaled;
    uvN = select(candidateN, uvN, reachedN); lumaEndN = select(sN3, lumaEndN, reachedN); reachedN = reachedN || abs(lumaEndN) >= gradScaled;

    candidateP = uvP + edgeStep * qualities[4];
    candidateN = uvN - edgeStep * qualities[4];
    let sP4 = luma(textureSample(colorTex, texSampler, candidateP).rgb) - lumaLocalAvg;
    let sN4 = luma(textureSample(colorTex, texSampler, candidateN).rgb) - lumaLocalAvg;
    uvP = select(candidateP, uvP, reachedP); lumaEndP = select(sP4, lumaEndP, reachedP); reachedP = reachedP || abs(lumaEndP) >= gradScaled;
    uvN = select(candidateN, uvN, reachedN); lumaEndN = select(sN4, lumaEndN, reachedN); reachedN = reachedN || abs(lumaEndN) >= gradScaled;

    candidateP = uvP + edgeStep * qualities[5];
    candidateN = uvN - edgeStep * qualities[5];
    let sP5 = luma(textureSample(colorTex, texSampler, candidateP).rgb) - lumaLocalAvg;
    let sN5 = luma(textureSample(colorTex, texSampler, candidateN).rgb) - lumaLocalAvg;
    uvP = select(candidateP, uvP, reachedP); lumaEndP = select(sP5, lumaEndP, reachedP); reachedP = reachedP || abs(lumaEndP) >= gradScaled;
    uvN = select(candidateN, uvN, reachedN); lumaEndN = select(sN5, lumaEndN, reachedN); reachedN = reachedN || abs(lumaEndN) >= gradScaled;

    candidateP = uvP + edgeStep * qualities[6];
    candidateN = uvN - edgeStep * qualities[6];
    let sP6 = luma(textureSample(colorTex, texSampler, candidateP).rgb) - lumaLocalAvg;
    let sN6 = luma(textureSample(colorTex, texSampler, candidateN).rgb) - lumaLocalAvg;
    uvP = select(candidateP, uvP, reachedP); lumaEndP = select(sP6, lumaEndP, reachedP); reachedP = reachedP || abs(lumaEndP) >= gradScaled;
    uvN = select(candidateN, uvN, reachedN); lumaEndN = select(sN6, lumaEndN, reachedN); reachedN = reachedN || abs(lumaEndN) >= gradScaled;

    candidateP = uvP + edgeStep * qualities[7];
    candidateN = uvN - edgeStep * qualities[7];
    let sP7 = luma(textureSample(colorTex, texSampler, candidateP).rgb) - lumaLocalAvg;
    let sN7 = luma(textureSample(colorTex, texSampler, candidateN).rgb) - lumaLocalAvg;
    uvP = select(candidateP, uvP, reachedP); lumaEndP = select(sP7, lumaEndP, reachedP); reachedP = reachedP || abs(lumaEndP) >= gradScaled;
    uvN = select(candidateN, uvN, reachedN); lumaEndN = select(sN7, lumaEndN, reachedN); reachedN = reachedN || abs(lumaEndN) >= gradScaled;

    candidateP = uvP + edgeStep * qualities[8];
    candidateN = uvN - edgeStep * qualities[8];
    let sP8 = luma(textureSample(colorTex, texSampler, candidateP).rgb) - lumaLocalAvg;
    let sN8 = luma(textureSample(colorTex, texSampler, candidateN).rgb) - lumaLocalAvg;
    uvP = select(candidateP, uvP, reachedP); lumaEndP = select(sP8, lumaEndP, reachedP); reachedP = reachedP || abs(lumaEndP) >= gradScaled;
    uvN = select(candidateN, uvN, reachedN); lumaEndN = select(sN8, lumaEndN, reachedN); reachedN = reachedN || abs(lumaEndN) >= gradScaled;

    candidateP = uvP + edgeStep * qualities[9];
    candidateN = uvN - edgeStep * qualities[9];
    let sP9 = luma(textureSample(colorTex, texSampler, candidateP).rgb) - lumaLocalAvg;
    let sN9 = luma(textureSample(colorTex, texSampler, candidateN).rgb) - lumaLocalAvg;
    uvP = select(candidateP, uvP, reachedP); lumaEndP = select(sP9, lumaEndP, reachedP); reachedP = reachedP || abs(lumaEndP) >= gradScaled;
    uvN = select(candidateN, uvN, reachedN); lumaEndN = select(sN9, lumaEndN, reachedN); reachedN = reachedN || abs(lumaEndN) >= gradScaled;

    candidateP = uvP + edgeStep * qualities[10];
    candidateN = uvN - edgeStep * qualities[10];
    let sP10 = luma(textureSample(colorTex, texSampler, candidateP).rgb) - lumaLocalAvg;
    let sN10 = luma(textureSample(colorTex, texSampler, candidateN).rgb) - lumaLocalAvg;
    uvP = select(candidateP, uvP, reachedP); lumaEndP = select(sP10, lumaEndP, reachedP); reachedP = reachedP || abs(lumaEndP) >= gradScaled;
    uvN = select(candidateN, uvN, reachedN); lumaEndN = select(sN10, lumaEndN, reachedN); reachedN = reachedN || abs(lumaEndN) >= gradScaled;

    candidateP = uvP + edgeStep * qualities[11];
    candidateN = uvN - edgeStep * qualities[11];
    let sP11 = luma(textureSample(colorTex, texSampler, candidateP).rgb) - lumaLocalAvg;
    let sN11 = luma(textureSample(colorTex, texSampler, candidateN).rgb) - lumaLocalAvg;
    uvP = select(candidateP, uvP, reachedP); lumaEndP = select(sP11, lumaEndP, reachedP);
    uvN = select(candidateN, uvN, reachedN); lumaEndN = select(sN11, lumaEndN, reachedN);

    // --- Compute final offset ---
    let distP = select(uvP.y - uv.y, uvP.x - uv.x, isHorizontal);
    let distN = select(uv.y - uvN.y, uv.x - uvN.x, isHorizontal);
    let distMin = min(distP, distN);
    let edgeLen = distP + distN;
    let pixelOffset = -distMin / edgeLen + 0.5;

    let lumaAvgAll = (1.0 / 12.0) * (2.0 * lumaUD + 2.0 * lumaLR + lumaLCol + lumaRCol);
    let subPixOffset = clamp(abs(lumaAvgAll - lumaC) / lumaRange, 0.0, 1.0);
    let subPix = (-2.0 * subPixOffset + 3.0) * subPixOffset * subPixOffset * SUBPIXEL_QUALITY;

    let closerIsP = distP < distN;
    let lumaEndCloser = select(lumaEndN, lumaEndP, closerIsP);
    let goodSpan = (lumaEndCloser < 0.0) != (lumaC - lumaLocalAvg < 0.0);
    let finalOffset = select(subPix, max(pixelOffset, subPix), goodSpan);

    var finalUV = uv;
    if (isHorizontal) { finalUV.y += finalOffset * signedStep; }
    else              { finalUV.x += finalOffset * signedStep; }

    let fxaaResult = textureSample(colorTex, texSampler, finalUV);

    // Use select() instead of early return for low-contrast pixels
    return select(fxaaResult, center, lowContrast);
}
