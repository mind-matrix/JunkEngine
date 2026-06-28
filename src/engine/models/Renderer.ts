import { Scene } from "./Scene";

/**
 * Abstract base class for all JunkEngine renderers.
 *
 * @typeParam TContext - The rendering context type.
 *   Use `CanvasRenderingContext2D` for CPU renderers (Crank)
 *   or `GPUCanvasContext` for WebGPU renderers (Turbo).
 */
export abstract class Renderer<TContext = CanvasRenderingContext2D> {
    constructor(
        protected canvas: HTMLCanvasElement,
        protected context: TContext,
    ) {}

    /** Renders the given scene. May be synchronous or asynchronous depending on the backend. */
    abstract render(scene: Scene): Promise<void> | void;
    /** Clears the framebuffer to the default background. */
    abstract clear(): Promise<void> | void;
}
