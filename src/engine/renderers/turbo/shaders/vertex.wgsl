struct SceneUniforms {
    vp:          mat4x4f,
    cameraPos:   vec4f,   // xyz = world-space camera position, w = unused
    sceneParams: vec4f,   // x = shadingMode (0=PBR, 1=Toon), yzw = reserved
};

struct InstanceData {
    model:      mat4x4f,
    normalMat0: vec4f,   // row 0 of 3×3 normal matrix (xyz used)
    normalMat1: vec4f,   // row 1
    normalMat2: vec4f,   // row 2
    params:     vec4f,   // x = normalSign (+1 or -1), yzw = reserved
};

@group(0) @binding(0) var<uniform> scene: SceneUniforms;
@group(0) @binding(3) var<storage, read> instances: array<InstanceData>;

struct VsOut {
    @builtin(position) clipPos: vec4f,
    @location(0) worldPos: vec3f,
    @location(1) worldNormal: vec3f,
    @location(2) uv: vec2f,
};

@vertex
fn vs(
    @location(0) pos: vec3f,
    @location(1) normal: vec3f,
    @location(2) uv: vec2f,
    @builtin(instance_index) instanceIdx: u32,
) -> VsOut {
    let inst = instances[instanceIdx];
    var out: VsOut;
    let worldPos4 = inst.model * vec4f(pos, 1.0);
    out.clipPos = scene.vp * worldPos4;
    out.worldPos = worldPos4.xyz;
    let nm = mat3x3f(inst.normalMat0.xyz, inst.normalMat1.xyz, inst.normalMat2.xyz);
    out.worldNormal = normalize(nm * normal) * inst.params.x;
    out.uv = vec2f(uv.x, 1.0 - uv.y);
    return out;
}
