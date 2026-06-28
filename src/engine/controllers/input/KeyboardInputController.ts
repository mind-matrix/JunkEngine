import { InputController } from "@/engine/models/InputController";

/** Snapshot of keyboard state returned by {@link KeyboardInputController.poll}. */
export interface KeyboardState {
    /** Set of keys currently held down (by `KeyboardEvent.code`). */
    readonly held: ReadonlySet<string>;
    /** Keys pressed this frame (down edge). */
    readonly pressed: ReadonlySet<string>;
    /** Keys released this frame (up edge). */
    readonly released: ReadonlySet<string>;
}

/**
 * Tracks keyboard key-down / key-up state against a DOM target.
 *
 * - `held` — keys currently down.
 * - `pressed` — keys that went down since the last {@link resetFrame}.
 * - `released` — keys that went up since the last {@link resetFrame}.
 */
export class KeyboardInputController extends InputController {
    private held = new Set<string>();
    private pressed = new Set<string>();
    private released = new Set<string>();

    private onKeyDown = (e: Event): void => {
        const code = (e as KeyboardEvent).code;
        if (!this.held.has(code)) this.pressed.add(code);
        this.held.add(code);
    };

    private onKeyUp = (e: Event): void => {
        const code = (e as KeyboardEvent).code;
        this.held.delete(code);
        this.released.add(code);
    };

    private onBlur = (): void => {
        this.held.clear();
    };

    protected onAttach(target: EventTarget): void {
        target.addEventListener("keydown", this.onKeyDown);
        target.addEventListener("keyup", this.onKeyUp);
        target.addEventListener("blur", this.onBlur);
    }

    protected onDetach(target: EventTarget): void {
        target.removeEventListener("keydown", this.onKeyDown);
        target.removeEventListener("keyup", this.onKeyUp);
        target.removeEventListener("blur", this.onBlur);
        this.held.clear();
    }

    poll(): KeyboardState {
        return { held: this.held, pressed: this.pressed, released: this.released };
    }

    resetFrame(): void {
        this.pressed.clear();
        this.released.clear();
    }

    /** Convenience: returns `true` if the key is currently held. */
    isDown(code: string): boolean {
        return this.held.has(code);
    }
}
