/**
 * Defines a virtual camera used to compute the view-projection matrix.
 * The camera uses a look-at model: it is positioned at {@link position},
 * looks toward {@link target}, and is oriented by {@link up}.
 */
export interface Camera {
    /** World-space position of the camera eye (xyz). */
    position: Float32Array;
    /** World-space point the camera looks at (xyz). */
    target: Float32Array;
    /** Up direction vector (xyz), typically (0, 1, 0). */
    up: Float32Array;
    /** Vertical field of view in radians. */
    fov: number;
    /** Distance to the near clipping plane. */
    near: number;
    /** Distance to the far clipping plane. */
    far: number;
}

/** Creates a default camera at (0, 0, 5) looking at the origin with a 45° FOV. */
export function createDefaultCamera(): Camera {
    return {
        position: new Float32Array([0, 0, 5]),
        target: new Float32Array([0, 0, 0]),
        up: new Float32Array([0, 1, 0]),
        fov: Math.PI / 4,
        near: 0.1,
        far: 1000,
    };
}

/** Max pitch angle to prevent flipping (just under 90°). */
const MAX_PITCH = Math.PI / 2 - 0.01;

/**
 * Rotates the camera's target around its position by the given yaw/pitch deltas.
 * Pitch is clamped to avoid gimbal-lock flipping.
 *
 * @param camera     - Camera to rotate.
 * @param deltaYaw   - Horizontal rotation in radians (positive = look right).
 * @param deltaPitch - Vertical rotation in radians (positive = look up).
 */
export function rotateCamera(camera: Camera, deltaYaw: number, deltaPitch: number): void {
    const dx = (camera.target[0] ?? 0) - (camera.position[0] ?? 0);
    const dy = (camera.target[1] ?? 0) - (camera.position[1] ?? 0);
    const dz = (camera.target[2] ?? 0) - (camera.position[2] ?? 0);
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    let yaw = Math.atan2(dx, dz);
    let pitch = Math.asin(dy / dist);

    yaw += deltaYaw;
    pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch + deltaPitch));

    const cosPitch = Math.cos(pitch);
    camera.target[0] = (camera.position[0] ?? 0) + Math.sin(yaw) * cosPitch * dist;
    camera.target[1] = (camera.position[1] ?? 0) + Math.sin(pitch) * dist;
    camera.target[2] = (camera.position[2] ?? 0) + Math.cos(yaw) * cosPitch * dist;
}
