import { Camera, rotateCamera } from "@/engine/models/Camera";
import { InputController } from "@/engine/models/InputController";
import { KeyboardInputController } from "@/engine/controllers/input/KeyboardInputController";
import { MouseInputController } from "@/engine/controllers/input/MouseInputController";
import { TouchInputController } from "@/engine/controllers/input/TouchInputController";
import { vec3Cross, vec3Normalize, vec3Subtract } from "@/engine/utilities/render-utils";
import { VirtualJoystick } from "./VirtualJoystick";

export interface FPSControllerOptions {
    moveSpeed?: number;
    lookSensitivity?: number;
    touchSensitivity?: number;
    joystick?: VirtualJoystick;
}

export interface FPSState {
    readonly moving: boolean;
    readonly looking: boolean;
}

export class FPSController extends InputController {
    private keyboard = new KeyboardInputController();
    private mouse = new MouseInputController();
    private touch = new TouchInputController();

    private camera: Camera;
    private moveSpeed: number;
    private lookSensitivity: number;
    private touchSensitivity: number;
    private pointerLocked = false;
    private joystick: VirtualJoystick | null;

    constructor(camera: Camera, options: FPSControllerOptions = {}) {
        super();
        this.camera = camera;
        this.moveSpeed = options.moveSpeed ?? 0.05;
        this.lookSensitivity = options.lookSensitivity ?? 0.002;
        this.touchSensitivity = options.touchSensitivity ?? 0.005;
        this.joystick = options.joystick ?? null;
    }

    protected override onAttach(target: EventTarget): void {
        this.keyboard.attach(window);
        this.mouse.attach(target);
        this.touch.attach(target);

        if (target instanceof HTMLElement) {
            target.addEventListener("click", this.requestPointerLock);
            this.joystick?.mount(target.parentElement ?? document.body);
        }
        document.addEventListener("pointerlockchange", this.onPointerLockChange);
    }

    protected override onDetach(target: EventTarget): void {
        this.keyboard.detach();
        this.mouse.detach();
        this.touch.detach();
        this.joystick?.unmount();

        if (target instanceof HTMLElement) {
            target.removeEventListener("click", this.requestPointerLock);
        }
        document.removeEventListener("pointerlockchange", this.onPointerLockChange);
        this.pointerLocked = false;
    }

    private requestPointerLock = (): void => {
        if (this.target instanceof HTMLElement) {
            this.target.requestPointerLock();
        }
    };

    private onPointerLockChange = (): void => {
        this.pointerLocked = document.pointerLockElement === this.target;
    };

    poll(): FPSState {
        let looking = false;
        let moving = false;

        // Look: mouse (when pointer-locked) or single-finger touch drag
        const mouseState = this.mouse.poll();
        const touchState = this.touch.poll();

        if (this.pointerLocked && (mouseState.deltaX !== 0 || mouseState.deltaY !== 0)) {
            rotateCamera(
                this.camera,
                -mouseState.deltaX * this.lookSensitivity,
                mouseState.deltaY * this.lookSensitivity,
            );
            looking = true;
        }

        if (touchState.pointers.length === 1 && (touchState.deltaX !== 0 || touchState.deltaY !== 0)) {
            rotateCamera(
                this.camera,
                -touchState.deltaX * this.touchSensitivity,
                touchState.deltaY * this.touchSensitivity,
            );
            looking = true;
        }

        // Move: WASD + Space/Shift
        const cam = this.camera;
        const forward = new Float32Array(3);
        vec3Subtract(forward, cam.target, cam.position);
        forward[1] = 0;
        vec3Normalize(forward, forward);

        const right = new Float32Array(3);
        vec3Cross(right, forward, cam.up);
        right[1] = 0;
        vec3Normalize(right, right);

        if (this.keyboard.isDown("KeyW")) { this.move(forward, this.moveSpeed); moving = true; }
        if (this.keyboard.isDown("KeyS")) { this.move(forward, -this.moveSpeed); moving = true; }
        if (this.keyboard.isDown("KeyA")) { this.move(right, -this.moveSpeed); moving = true; }
        if (this.keyboard.isDown("KeyD")) { this.move(right, this.moveSpeed); moving = true; }
        if (this.keyboard.isDown("Space")) { this.moveY(this.moveSpeed); moving = true; }
        if (this.keyboard.isDown("ShiftLeft") || this.keyboard.isDown("ShiftRight")) { this.moveY(-this.moveSpeed); moving = true; }

        // Virtual joystick: dy maps to forward/back, dx maps to strafe
        if (this.joystick) {
            const js = this.joystick.poll();
            if (js.active) {
                if (Math.abs(js.dy) > 0.1) { this.move(forward, -js.dy * this.moveSpeed); moving = true; }
                if (Math.abs(js.dx) > 0.1) { this.move(right, js.dx * this.moveSpeed); moving = true; }
            }
        }

        return { moving, looking };
    }

    resetFrame(): void {
        this.keyboard.resetFrame();
        this.mouse.resetFrame();
        this.touch.resetFrame();
    }

    setMoveSpeed(speed: number): void {
        this.moveSpeed = speed;
    }

    private move(dir: Float32Array, amount: number): void {
        const dx = (dir[0] ?? 0) * amount;
        const dz = (dir[2] ?? 0) * amount;
        this.camera.position[0] = (this.camera.position[0] ?? 0) + dx;
        this.camera.position[2] = (this.camera.position[2] ?? 0) + dz;
        this.camera.target[0] = (this.camera.target[0] ?? 0) + dx;
        this.camera.target[2] = (this.camera.target[2] ?? 0) + dz;
    }

    private moveY(amount: number): void {
        this.camera.position[1] = (this.camera.position[1] ?? 0) + amount;
        this.camera.target[1] = (this.camera.target[1] ?? 0) + amount;
    }
}
