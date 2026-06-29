export interface JoystickState {
    readonly dx: number;
    readonly dy: number;
    readonly active: boolean;
}

export interface VirtualJoystickOptions {
    size?: number;
    position?: "left" | "right";
    opacity?: number;
}

export class VirtualJoystick {
    private container: HTMLElement | null = null;
    private knob: HTMLElement | null = null;
    private dx = 0;
    private dy = 0;
    private active = false;
    private trackingId: number | null = null;
    private radius: number;
    private centerX = 0;
    private centerY = 0;

    private size: number;
    private position: "left" | "right";
    private opacity: number;

    constructor(options: VirtualJoystickOptions = {}) {
        this.size = options.size ?? 120;
        this.position = options.position ?? "left";
        this.opacity = options.opacity ?? 0.6;
        this.radius = this.size / 2;
    }

    mount(parent: HTMLElement): void {
        this.container = document.createElement("div");
        this.container.style.cssText = `
            position: fixed;
            bottom: 40px;
            ${this.position}: 40px;
            width: ${this.size}px;
            height: ${this.size}px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.1);
            border: 2px solid rgba(255, 255, 255, 0.25);
            touch-action: none;
            user-select: none;
            opacity: ${this.opacity};
            z-index: 100;
        `;

        this.knob = document.createElement("div");
        const knobSize = this.size * 0.4;
        this.knob.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            width: ${knobSize}px;
            height: ${knobSize}px;
            margin-top: ${-knobSize / 2}px;
            margin-left: ${-knobSize / 2}px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.4);
            transition: background 0.1s;
        `;

        this.container.appendChild(this.knob);
        parent.appendChild(this.container);

        this.container.addEventListener("touchstart", this.onTouchStart, { passive: false });
        this.container.addEventListener("touchmove", this.onTouchMove, { passive: false });
        this.container.addEventListener("touchend", this.onTouchEnd, { passive: false });
        this.container.addEventListener("touchcancel", this.onTouchEnd, { passive: false });
    }

    unmount(): void {
        if (this.container) {
            this.container.removeEventListener("touchstart", this.onTouchStart);
            this.container.removeEventListener("touchmove", this.onTouchMove);
            this.container.removeEventListener("touchend", this.onTouchEnd);
            this.container.removeEventListener("touchcancel", this.onTouchEnd);
            this.container.parentElement?.removeChild(this.container);
            this.container = null;
            this.knob = null;
        }
        this.reset();
    }

    poll(): JoystickState {
        return { dx: this.dx, dy: this.dy, active: this.active };
    }

    private onTouchStart = (e: TouchEvent): void => {
        e.preventDefault();
        if (this.trackingId !== null) return;
        const touch = e.changedTouches[0];
        if (!touch || !this.container) return;

        this.trackingId = touch.identifier;
        this.active = true;
        const rect = this.container.getBoundingClientRect();
        this.centerX = rect.left + rect.width / 2;
        this.centerY = rect.top + rect.height / 2;
        this.updateFromTouch(touch.clientX, touch.clientY);
    };

    private onTouchMove = (e: TouchEvent): void => {
        e.preventDefault();
        const touch = this.findTrackedTouch(e.changedTouches);
        if (touch) {
            this.updateFromTouch(touch.clientX, touch.clientY);
        }
    };

    private onTouchEnd = (e: TouchEvent): void => {
        e.preventDefault();
        const touch = this.findTrackedTouch(e.changedTouches);
        if (touch) {
            this.reset();
        }
    };

    private findTrackedTouch(touches: TouchList): Touch | null {
        for (let i = 0; i < touches.length; i++) {
            if (touches[i]!.identifier === this.trackingId) return touches[i]!;
        }
        return null;
    }

    private updateFromTouch(clientX: number, clientY: number): void {
        let offsetX = clientX - this.centerX;
        let offsetY = clientY - this.centerY;
        const dist = Math.sqrt(offsetX * offsetX + offsetY * offsetY);

        if (dist > this.radius) {
            offsetX = (offsetX / dist) * this.radius;
            offsetY = (offsetY / dist) * this.radius;
        }

        this.dx = offsetX / this.radius;
        this.dy = offsetY / this.radius;

        if (this.knob) {
            this.knob.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
        }
    }

    private reset(): void {
        this.dx = 0;
        this.dy = 0;
        this.active = false;
        this.trackingId = null;
        if (this.knob) {
            this.knob.style.transform = "translate(0px, 0px)";
        }
    }
}
