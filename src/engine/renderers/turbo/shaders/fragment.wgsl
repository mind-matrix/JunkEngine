const AMBIENT: f32 = 0.15;
const MAX_LIGHTS: u32 = PLACEHOLDER_MAX_LIGHTS;

// --- Toon constants ---
const TOON_SHADOW_THRESHOLD: f32 = 0.3;
const TOON_MID_THRESHOLD: f32 = 0.6;
const TOON_SHADOW_VALUE: f32 = 0.35;
const TOON_MID_VALUE: f32 = 0.65;
const TOON_LIT_VALUE: f32 = 1.0;
const TOON_SPEC_THRESHOLD: f32 = 0.92;
const TOON_RIM_THRESHOLD: f32 = 0.55;
const TOON_RIM_STRENGTH: f32 = 0.15;
const TOON_EDGE_THRESHOLD: f32 = 0.3;
const TOON_EDGE_DARKNESS: f32 = 0.15;

struct MaterialUniforms {
    baseColor:       vec4f,
    metallicFactor:  f32,
    roughnessFactor: f32,
    normalScale:     f32,
    alphaCutoff:     f32,
    alphaMode:       u32,   // 0=OPAQUE, 1=MASK, 2=BLEND
    hasTexture:      u32,   // bitmask: bit0=diffuse, bit1=MR, bit2=normal
    _pad0:           u32,
    _pad1:           u32,
};

struct Light {
    posOrDir:    vec4f,   // xyz = position/direction, w = type (0=dir, 1=point)
    color:       vec4f,   // rgb = color * intensity, a = unused
    attenuation: vec4f,   // constant, linear, quadratic, unused
};

struct LightUniforms {
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    lights: array<Light, PLACEHOLDER_MAX_LIGHTS>,
};

struct SceneUniforms {
    vp:          mat4x4f,
    cameraPos:   vec4f,   // xyz = world-space camera position, w = unused
    sceneParams: vec4f,   // x = shadingMode (0=PBR, 1=Toon), yzw = reserved
};

@group(0) @binding(0) var<uniform> u: SceneUniforms;
@group(0) @binding(1) var<uniform> mtl: MaterialUniforms;
@group(0) @binding(2) var<uniform> lightUni: LightUniforms;

@group(1) @binding(0) var diffuseTex:  texture_2d<f32>;
@group(1) @binding(1) var diffuseSamp: sampler;
@group(1) @binding(2) var mrTex:       texture_2d<f32>;
@group(1) @binding(3) var mrSamp:      sampler;
@group(1) @binding(4) var normalTex:   texture_2d<f32>;
@group(1) @binding(5) var normalSamp:  sampler;

// Quantize a smooth NdotL value into discrete toon bands
fn toonBand(NdotL: f32) -> f32 {
    if (NdotL < TOON_SHADOW_THRESHOLD) { return TOON_SHADOW_VALUE; }
    if (NdotL < TOON_MID_THRESHOLD)    { return TOON_MID_VALUE; }
    return TOON_LIT_VALUE;
}

@fragment
fn fs(
    @location(0) worldPos: vec3f,
    @location(1) worldNormal: vec3f,
    @location(2) uv: vec2f,
) -> @location(0) vec4f {
    // Sample all textures unconditionally (WGSL requires uniform control flow)
    let diffSample = textureSample(diffuseTex, diffuseSamp, uv);
    let mrSample   = textureSample(mrTex, mrSamp, uv);
    let nmSample   = textureSample(normalTex, normalSamp, uv).xyz;

    // Derivatives for TBN (must also be in uniform control flow)
    let dPdx  = dpdx(worldPos);
    let dPdy  = dpdy(worldPos);
    let dUVdx = dpdx(uv);
    let dUVdy = dpdy(uv);

    // --- Base color ---
    var color: vec4f;
    if ((mtl.hasTexture & 1u) != 0u) {
        color = diffSample;
    } else {
        color = mtl.baseColor;
    }

    // --- Alpha mask ---
    if (mtl.alphaMode == 1u && color.a < mtl.alphaCutoff) {
        discard;
    }

    // --- Normal ---
    var N = normalize(worldNormal);

    if ((mtl.hasTexture & 4u) != 0u) {
        let det = dUVdx.x * dUVdy.y - dUVdx.y * dUVdy.x;
        if (abs(det) > 1e-8) {
            let invDet = 1.0 / det;
            let T = normalize((dPdx * dUVdy.y - dPdy * dUVdx.y) * invDet);
            let B = normalize((dPdy * dUVdx.x - dPdx * dUVdy.x) * invDet);

            var ts = nmSample * 2.0 - 1.0;
            ts = vec3f(ts.x * mtl.normalScale, ts.y * mtl.normalScale, ts.z);
            N = normalize(T * ts.x + B * ts.y + N * ts.z);
        }
    }

    // --- View direction ---
    let V = normalize(u.cameraPos.xyz - worldPos);
    let baseRGB = color.rgb;

    let shadingMode = u32(u.sceneParams.x);

    // =====================================================================
    // TOON SHADING (mode 1)
    // =====================================================================
    if (shadingMode == 1u) {
        // Read metallic/roughness so toon respects material properties
        var metallic = mtl.metallicFactor;
        var roughness = mtl.roughnessFactor;
        if ((mtl.hasTexture & 2u) != 0u) {
            roughness *= mrSample.g;
            metallic *= mrSample.b;
        }

        // Only metallic surfaces get specular; rough surfaces suppress it entirely
        let specThreshold = mix(TOON_SPEC_THRESHOLD, 0.99, roughness);
        let specStrength = metallic * (1.0 - roughness) * 0.35;

        var toonDiff = vec3f(0.0);
        var toonSpec = vec3f(0.0);

        for (var i = 0u; i < min(lightUni.count, MAX_LIGHTS); i++) {
            let light = lightUni.lights[i];
            var L: vec3f;
            var atten: f32;

            if (light.posOrDir.w < 0.5) {
                L = -light.posOrDir.xyz;
                atten = 1.0;
            } else {
                let toLight = light.posOrDir.xyz - worldPos;
                let dist = length(toLight);
                L = toLight / max(dist, 1e-6);
                atten = 1.0 / (light.attenuation.x + light.attenuation.y * dist + light.attenuation.z * dist * dist);
            }

            let lc = light.color.rgb * atten;
            let NdotL = max(dot(N, L), 0.0);

            // Quantized diffuse
            toonDiff += lc * toonBand(NdotL);

            // Hard specular highlight — threshold and strength driven by material
            let H = normalize(L + V);
            let NdotH = max(dot(N, H), 0.0);
            if (NdotH > specThreshold && NdotL > 0.1) {
                toonSpec += lc * specStrength;
            }
        }

        // Rim lighting — suppressed on rough dielectrics
        let NdotV = max(dot(N, V), 0.0);
        let rimAmount = TOON_RIM_STRENGTH * mix(0.3, 1.0, metallic);
        let rim = select(0.0, rimAmount, NdotV < TOON_RIM_THRESHOLD);

        // Screen-space edge detection via normal derivatives
        let dNx = dpdx(N);
        let dNy = dpdy(N);
        let edgeMag = length(dNx) + length(dNy);
        let edge = select(1.0, TOON_EDGE_DARKNESS, edgeMag > TOON_EDGE_THRESHOLD);

        // Reduce diffuse for metallic surfaces (same as PBR path)
        var finalRGB = baseRGB * (1.0 - metallic) * (toonDiff + AMBIENT) + toonSpec + rim;
        finalRGB *= edge;

        var outAlpha = color.a;
        if (mtl.alphaMode == 2u) {
            let fresnel = pow(1.0 - NdotV, 5.0);
            outAlpha = clamp(color.a + fresnel * (1.0 - color.a), 0.0, 1.0);
        }

        return vec4f(clamp(finalRGB, vec3f(0.0), vec3f(1.0)), outAlpha);
    }

    // =====================================================================
    // PBR SHADING (mode 0, default)
    // =====================================================================

    // --- Metallic / Roughness ---
    var metallic = mtl.metallicFactor;
    var roughness = mtl.roughnessFactor;
    if ((mtl.hasTexture & 2u) != 0u) {
        roughness *= mrSample.g;
        metallic *= mrSample.b;
    }

    let f0 = mix(vec3f(0.04), baseRGB, metallic);

    let alpha = roughness * roughness;
    let shininess = max(1.0, 2.0 / (alpha * alpha + 1e-4) - 2.0);

    // --- Accumulate lighting ---
    var diffAcc = vec3f(AMBIENT);
    var specAcc = vec3f(0.0);

    for (var i = 0u; i < min(lightUni.count, MAX_LIGHTS); i++) {
        let light = lightUni.lights[i];
        var L: vec3f;
        var atten: f32;

        if (light.posOrDir.w < 0.5) {
            // Directional
            L = -light.posOrDir.xyz;
            atten = 1.0;
        } else {
            // Point
            let toLight = light.posOrDir.xyz - worldPos;
            let dist = length(toLight);
            L = toLight / max(dist, 1e-6);
            atten = 1.0 / (light.attenuation.x + light.attenuation.y * dist + light.attenuation.z * dist * dist);
        }

        let lc = light.color.rgb * atten;
        let NdotL = max(dot(N, L), 0.0);

        diffAcc += lc * NdotL;

        // Blinn-Phong half-vector using actual view direction
        let H = normalize(L + V);
        let NdotH = max(dot(N, H), 0.0);
        let specTerm = pow(NdotH, shininess) * NdotL;
        specAcc += lc * specTerm;
    }

    // --- Fresnel alpha boost for BLEND materials (glass effect) ---
    var outAlpha = color.a;
    if (mtl.alphaMode == 2u) {
        let NdotV = max(dot(N, V), 0.0);
        let fresnel = pow(1.0 - NdotV, 5.0);
        outAlpha = clamp(color.a + fresnel * (1.0 - color.a), 0.0, 1.0);
    }

    let finalRGB = baseRGB * (1.0 - metallic) * diffAcc + specAcc * f0;
    return vec4f(clamp(finalRGB, vec3f(0.0), vec3f(1.0)), outAlpha);
}
