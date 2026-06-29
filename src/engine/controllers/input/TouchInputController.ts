import { InputController } from "@/engine/models/InputController";

export interface TouchPointer {
    readonly id: number;
    readonly x: number;
    readonly y: number;
    readonly startX: number;
    readonly startY: number;
}

export interface TouchState {
    readonly pointers: ReadonlyArray<TouchPointer>;
    readonly deltaX: number;
    readonly deltaY: number;
    readonly pinchDelta: number;
    readonly tapped: boolean;
}

const TAP_MAX_DISTANCE = 10;
const TAP_MAX_DURATION = 300;

export class TouchInputController extends InputController {
    private pointers: Map<number, { x: number; y: number; startX: number; startY: number; startTime: number }> = new Map();
    private deltaX = 0;
    private deltaY = 0;
    private pinchDelta = 0;
    private tapped = false;
    private lastPinchDistance = 0;

    private onTouchStart = (e: Event): void => {
        const te = e as TouchEvent;
        e.preventDefault();
        for (let i = 0; i < te.changedTouches.length; i++) {
            const t = te.changedTouches[i]!;
            this.pointers.set(t.identifier, {
                x: t.clientX,
                y: t.clientY,
                startX: t.clientX,
                startY: t.clientY,
                startTime: performance.now(),
            });
        }
        this.updatePinchBaseline();
    };

    private onTouchMove = (e: Event): void => {
        const te = e as TouchEvent;
        e.preventDefault();

        if (this.pointers.size === 1) {
            for (let i = 0; i < te.changedTouches.length; i++) {
                const t = te.changedTouches[i]!;
                const prev = this.pointers.get(t.identifier);
                if (prev) {
                    this.deltaX += t.clientX - prev.x;
                    this.deltaY += t.clientY - prev.y;
                    prev.x = t.clientX;
                    prev.y = t.clientY;
                }
            }
        } else if (this.pointers.size === 2) {
            for (let i = 0; i < te.changedTouches.length; i++) {
                const t = te.changedTouches[i]!;
                const prev = this.pointers.get(t.identifier);
                if (prev) {
                    prev.x = t.clientX;
                    prev.y = t.clientY;
                }
            }
            const pts = [...this.pointers.values()];
            const dx = pts[0]!.x - pts[1]!.x;
            const dy = pts[0]!.y - pts[1]!.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (this.lastPinchDistance > 0) {
                this.pinchDelta += dist - this.lastPinchDistance;
            }
            this.lastPinchDistance = dist;
        }
    };

    private onTouchEnd = (e: Event): void => {
        const te = e as TouchEvent;
        e.preventDefault();
        for (let i = 0; i < te.changedTouches.length; i++) {
            const t = te.changedTouches[i]!;
            const prev = this.pointers.get(t.identifier);
            if (prev) {
                const dx = t.clientX - prev.startX;
                const dy = t.clientY - prev.startY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const elapsed = performance.now() - prev.startTime;
                if (dist < TAP_MAX_DISTANCE && elapsed < TAP_MAX_DURATION) {
                    this.tapped = true;
                }
            }
            this.pointers.delete(t.identifier);
        }
        this.updatePinchBaseline();
    };

    private updatePinchBaseline(): void {
        if (this.pointers.size === 2) {
            const pts = [...this.pointers.values()];
            const dx = pts[0]!.x - pts[1]!.x;
            const dy = pts[0]!.y - pts[1]!.y;
            this.lastPinchDistance = Math.sqrt(dx * dx + dy * dy);
        } else {
            this.lastPinchDistance = 0;
        }
    }

    protected onAttach(target: EventTarget): void {
        const opts = { passive: false } as const;
        target.addEventListener("touchstart", this.onTouchStart, opts);
        target.addEventListener("touchmove", this.onTouchMove, opts);
        target.addEventListener("touchend", this.onTouchEnd, opts);
        target.addEventListener("touchcancel", this.onTouchEnd, opts);
    }

    protected onDetach(target: EventTarget): void {
        target.removeEventListener("touchstart", this.onTouchStart);
        target.removeEventListener("touchmove", this.onTouchMove);
        target.removeEventListener("touchend", this.onTouchEnd);
        target.removeEventListener("touchcancel", this.onTouchEnd);
        this.pointers.clear();
        this.lastPinchDistance = 0;
    }

    poll(): TouchState {
        const pointers: TouchPointer[] = [];
        for (const [id, p] of this.pointers) {
            pointers.push({ id, x: p.x, y: p.y, startX: p.startX, startY: p.startY });
        }
        return {
            pointers,
            deltaX: this.deltaX,
            deltaY: this.deltaY,
            pinchDelta: this.pinchDelta,
            tapped: this.tapped,
        };
    }

    resetFrame(): void {
        this.deltaX = 0;
        this.deltaY = 0;
        this.pinchDelta = 0;
        this.tapped = false;
    }
}
