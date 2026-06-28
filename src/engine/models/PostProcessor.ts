/**
 * Abstract base for GPU post-processing passes.
 *
 * A post-processor reads from source textures (color, depth) and writes
 * to an output render target via a fullscreen triangle draw. Subclasses
 * provide the WGSL shader source and any additional bind group entries.
 *
 * Lifecycle:
 * 1. Construct with a {@link GPUDevice} and canvas dimensions.
 * 2. Call {@link apply} each frame inside a command encoder.
 * 3. Call {@link resize} when the canvas dimensions change.
 * 4. Call {@link dispose} to release GPU resources.
 */
export abstract class PostProcessor {
    protected device: GPUDevice;
    protected width: number;
    protected height: number;

    constructor(device: GPUDevice, width: number, height: number) {
        this.device = device;
        this.width = width;
        this.height = height;
    }

    /**
     * Encodes the post-process pass into the given command encoder.
     *
     * @param encoder       - Active command encoder for the current frame.
     * @param sourceColor   - Color texture from the scene pass.
     * @param sourceDepth   - Depth texture from the scene pass.
     * @param outputTexture - Texture to render the result into (typically the canvas texture).
     */
    abstract apply(
        encoder: GPUCommandEncoder,
        sourceColor: GPUTexture,
        sourceDepth: GPUTexture,
        outputTexture: GPUTexture,
    ): void;

    /** Recreates internal textures after a canvas resize. */
    abstract resize(width: number, height: number): void;

    /** Releases all GPU resources held by this post-processor. */
    abstract dispose(): void;
}
