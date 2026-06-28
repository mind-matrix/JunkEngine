struct OutlineParams {
    texelSize:      vec2f,  // 1/width, 1/height
    depthThreshold: f32,
    normalThreshold: f32,
};

@group(0) @binding(0) var colorTex:   texture_2d<f32>;
@group(0) @binding(1) var depthTex:   texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> params: OutlineParams;

struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
};

// Fullscreen triangle — no vertex buffer needed
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
    var out: VsOut;
    // 3 vertices covering the full screen: (-1,-1), (3,-1), (-1,3)
    let x = f32(i32(vi & 1u)) * 4.0 - 1.0;
    let y = f32(i32(vi >> 1u)) * 4.0 - 1.0;
    out.pos = vec4f(x, y, 0.0, 1.0);
    out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return out;
}

fn sampleDepth(uv: vec2f) -> f32 {
    return textureSample(depthTex, texSampler, uv).r;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
    let sceneColor = textureSample(colorTex, texSampler, uv);

    let tx = params.texelSize.x;
    let ty = params.texelSize.y;

    // Sample depth in a 3x3 neighborhood
    let d   = sampleDepth(uv);
    let dL  = sampleDepth(uv + vec2f(-tx, 0.0));
    let dR  = sampleDepth(uv + vec2f( tx, 0.0));
    let dU  = sampleDepth(uv + vec2f(0.0, -ty));
    let dD  = sampleDepth(uv + vec2f(0.0,  ty));
    let dTL = sampleDepth(uv + vec2f(-tx, -ty));
    let dTR = sampleDepth(uv + vec2f( tx, -ty));
    let dBL = sampleDepth(uv + vec2f(-tx,  ty));
    let dBR = sampleDepth(uv + vec2f( tx,  ty));

    // Sobel operator on depth
    let sobelX = (dTR + 2.0 * dR + dBR) - (dTL + 2.0 * dL + dBL);
    let sobelY = (dBL + 2.0 * dD + dBR) - (dTL + 2.0 * dU + dTR);
    let depthEdge = sqrt(sobelX * sobelX + sobelY * sobelY);

    // Roberts cross on depth for finer detail
    let robertsA = abs(d - dBR);
    let robertsB = abs(dR - dD);
    let robertsEdge = robertsA + robertsB;

    // Depth-adaptive threshold: edges far away need less sensitivity
    // Linearize depth for better scaling (assuming reversed-Z or standard [0,1])
    let adaptiveThreshold = params.depthThreshold * max(d * d, 0.001);

    let combinedEdge = max(depthEdge, robertsEdge * 0.5);
    let edgeFactor = smoothstep(adaptiveThreshold * 0.5, adaptiveThreshold, combinedEdge);

    // Darken to black where edges are detected
    let outlineColor = vec3f(0.0, 0.0, 0.0);
    let finalColor = mix(sceneColor.rgb, outlineColor, edgeFactor);

    return vec4f(finalColor, sceneColor.a);
}
