import { OutputController } from "@/engine/models/OutputController";

/** Parameters accepted by {@link VibrationOutputController.trigger}. */
export interface VibrationTriggerParams {
    /**
     * Vibration pattern in milliseconds.
     * A single number vibrates for that duration.
     * An array alternates vibrate/pause (e.g. `[200, 100, 200]` = vibrate 200ms, pause 100ms, vibrate 200ms).
     * Defaults to the controller's {@link pattern}.
     */
    pattern?: number | number[];
}

/**
 * Triggers device vibration via the Navigator Vibration API.
 *
 * Set a default {@link pattern} on construction, or override per-trigger.
 * Falls back to a no-op on devices/browsers that lack vibration support.
 */
export class VibrationOutputController extends OutputController {
    /** Default vibration pattern (ms). */
    public pattern: number | number[];

    /** `true` if the current environment supports the Vibration API. */
    static readonly supported: boolean =
        typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

    /**
     * @param pattern - Default vibration duration or pattern in ms.
     */
    constructor(pattern: number | number[] = 200) {
        super();
        this.pattern = pattern;
    }

    protected onTrigger(params?: unknown): void {
        if (!VibrationOutputController.supported) return;
        const p = (params as VibrationTriggerParams | undefined)?.pattern ?? this.pattern;
        navigator.vibrate(p);
    }

    stop(): void {
        if (!VibrationOutputController.supported) return;
        navigator.vibrate(0);
    }

    dispose(): void {
        this.stop();
    }
}
