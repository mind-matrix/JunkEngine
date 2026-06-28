/**
 * Abstract base for input controllers that listen to DOM events on a target element.
 *
 * Subclasses implement {@link attach} and {@link detach} to bind/unbind
 * the specific event listeners they need. The {@link poll} method allows
 * renderers or game loops to query accumulated input state each frame.
 */
export abstract class InputController {
    protected target: EventTarget | null = null;

    /** Whether this controller is currently attached and listening. */
    get attached(): boolean {
        return this.target !== null;
    }

    /**
     * Begins listening for input events on the given target.
     * Calling attach while already attached will detach from the previous target first.
     */
    attach(target: EventTarget): void {
        if (this.target) this.detach();
        this.target = target;
        this.onAttach(target);
    }

    /** Stops listening and releases the target reference. */
    detach(): void {
        if (!this.target) return;
        this.onDetach(this.target);
        this.target = null;
    }

    /** Called by {@link attach} — subclasses add event listeners here. */
    protected abstract onAttach(target: EventTarget): void;
    /** Called by {@link detach} — subclasses remove event listeners here. */
    protected abstract onDetach(target: EventTarget): void;

    /**
     * Returns the current accumulated input state.
     * Called once per frame by the engine loop.
     */
    abstract poll(): unknown;

    /** Resets any accumulated state (e.g. deltas) after a frame. */
    abstract resetFrame(): void;
}
