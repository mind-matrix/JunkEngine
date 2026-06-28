/**
 * Abstract base for output controllers that produce side-effects
 * (audio playback, haptic feedback, etc.).
 *
 * Subclasses implement {@link trigger} to fire the effect and
 * {@link stop} to cancel any ongoing output. The controller can
 * be enabled/disabled without losing configuration.
 */
export abstract class OutputController {
    /** When `false`, calls to {@link trigger} are silently ignored. */
    public enabled = true;

    /** Fires the output effect. No-op when {@link enabled} is `false`. */
    trigger(params?: unknown): void {
        if (!this.enabled) return;
        this.onTrigger(params);
    }

    /** Immediately cancels any ongoing output effect. */
    abstract stop(): void;

    /** Releases any held resources (audio contexts, buffers, etc.). */
    abstract dispose(): void;

    /** Subclass implementation of the trigger logic. */
    protected abstract onTrigger(params?: unknown): void;
}
