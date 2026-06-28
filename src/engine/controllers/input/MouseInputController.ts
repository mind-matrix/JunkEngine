import { InputController } from "@/engine/models/InputController";

/** Snapshot of mouse state returned by {@link MouseInputController.poll}. */
export interface MouseState {
    /** Current cursor position relative to the target element. */
    readonly x: number;
    readonly y: number;
    /** Cursor movement since last {@link resetFrame}. */
    readonly deltaX: number;
    readonly deltaY: number;
    /** Scroll wheel delta since last {@link resetFrame}. */
    readonly scrollDelta: number;
    /** Set of mouse buttons currently held (0=left, 1=middle, 2=right). */
    readonly buttons: ReadonlySet<number>;
    /** Whether any button is held and the cursor has moved (drag in progress). */
    readonly dragging: boolean;
}

/**
 * Tracks mouse position, button state, movement deltas, and scroll on a DOM target.
 *
 * Attach to a `HTMLCanvasElement` or any `EventTarget`.
 * Call {@link poll} each frame to read state, then {@link resetFrame} to clear deltas.
 */
export class MouseInputController extends InputController {
    private x = 0;
    private y = 0;
    private deltaX = 0;
    private deltaY = 0;
    private scrollDelta = 0;
    private buttons = new Set<number>();
    private dragging = false;

    private onMouseMove = (e: Event): void => {
        const me = e as MouseEvent;
        this.deltaX += me.movementX;
        this.deltaY += me.movementY;
        this.x = me.offsetX;
        this.y = me.offsetY;
        if (this.buttons.size > 0) this.dragging = true;
    };

    private onMouseDown = (e: Event): void => {
        this.buttons.add((e as MouseEvent).button);
    };

    private onMouseUp = (e: Event): void => {
        this.buttons.delete((e as MouseEvent).button);
        if (this.buttons.size === 0) this.dragging = false;
    };

    private onWheel = (e: Event): void => {
        this.scrollDelta += (e as WheelEvent).deltaY;
    };

    private onContextMenu = (e: Event): void => {
        e.preventDefault();
    };

    protected onAttach(target: EventTarget): void {
        target.addEventListener("mousemove", this.onMouseMove);
        target.addEventListener("mousedown", this.onMouseDown);
        target.addEventListener("mouseup", this.onMouseUp);
        target.addEventListener("wheel", this.onWheel, { passive: true });
        target.addEventListener("contextmenu", this.onContextMenu);
    }

    protected onDetach(target: EventTarget): void {
        target.removeEventListener("mousemove", this.onMouseMove);
        target.removeEventListener("mousedown", this.onMouseDown);
        target.removeEventListener("mouseup", this.onMouseUp);
        target.removeEventListener("wheel", this.onWheel);
        target.removeEventListener("contextmenu", this.onContextMenu);
        this.buttons.clear();
        this.dragging = false;
    }

    poll(): MouseState {
        return {
            x: this.x,
            y: this.y,
            deltaX: this.deltaX,
            deltaY: this.deltaY,
            scrollDelta: this.scrollDelta,
            buttons: this.buttons,
            dragging: this.dragging,
        };
    }

    resetFrame(): void {
        this.deltaX = 0;
        this.deltaY = 0;
        this.scrollDelta = 0;
    }
}
