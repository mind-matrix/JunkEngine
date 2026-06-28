/** Type of light emission. */
export type LightType = "directional" | "point";

/** A light source in the scene. */
export interface LightSource {
    /** Unique id assigned by the Scene. */
    id: number;
    /** Human-readable name. */
    name: string;
    /** "directional" uses `direction`; "point" uses `position` with attenuation. */
    type: LightType;
    /** World-space position (used by point lights). */
    position: Float32Array;
    /** Normalized direction the light shines toward (used by directional lights). */
    direction: Float32Array;
    /** RGB color in 0–1 range. */
    color: Float32Array;
    /** Brightness multiplier (default 1). */
    intensity: number;
    /** Constant + linear + quadratic attenuation for point lights. */
    attenuation: { constant: number; linear: number; quadratic: number };
}

/** Creates a directional light with sensible defaults. */
export function createDirectionalLight(
    direction: [number, number, number],
    opts?: { color?: [number, number, number]; intensity?: number; name?: string },
): Omit<LightSource, "id"> {
    const len = Math.sqrt(direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2);
    const inv = len > 0 ? 1 / len : 0;
    return {
        name: opts?.name ?? "directional",
        type: "directional",
        position: new Float32Array(3),
        direction: new Float32Array([direction[0] * inv, direction[1] * inv, direction[2] * inv]),
        color: new Float32Array(opts?.color ?? [1, 1, 1]),
        intensity: opts?.intensity ?? 1,
        attenuation: { constant: 1, linear: 0, quadratic: 0 },
    };
}

/** Creates a point light with sensible defaults. */
export function createPointLight(
    position: [number, number, number],
    opts?: { color?: [number, number, number]; intensity?: number; name?: string;
             attenuation?: { constant?: number; linear?: number; quadratic?: number } },
): Omit<LightSource, "id"> {
    return {
        name: opts?.name ?? "point",
        type: "point",
        position: new Float32Array(position),
        direction: new Float32Array(3),
        color: new Float32Array(opts?.color ?? [1, 1, 1]),
        intensity: opts?.intensity ?? 1,
        attenuation: {
            constant: opts?.attenuation?.constant ?? 1,
            linear: opts?.attenuation?.linear ?? 0.09,
            quadratic: opts?.attenuation?.quadratic ?? 0.032,
        },
    };
}
