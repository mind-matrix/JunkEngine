import { SceneObject, Material, DirtyFlag } from "./SceneObject";
import { Camera, createDefaultCamera } from "./Camera";
import type { LightSource } from "./LightSource";
import { mat4Multiply, createPerspectiveMatrix, createLookAtMatrix } from "@/engine/utilities/render-utils";

/** Shading modes available to renderers. Values map directly to GPU uniform. */
export enum ShadingMode {
    PBR  = 0,
    Toon = 1,
}

const DEFAULT_CAPACITY = 1024;

/**
 * Container for all renderable entities, materials, textures, and the active camera.
 *
 * Internally maintains pooled SoA typed arrays for transforms and dirty flags
 * so renderers can batch-upload data to the GPU without per-entity allocations.
 * The pool auto-grows when capacity is exceeded.
 */
export class Scene {
    /** Human-readable scene name. */
    public name: string;
    /** Active camera used by renderers to compute the view-projection matrix. */
    public camera: Camera;
    /** Shading mode used by renderers. */
    public shadingMode: ShadingMode = ShadingMode.PBR;

    private entities: Map<number, SceneObject> = new Map();
    private materials: Map<number, Material> = new Map();
    private lights: Map<number, LightSource> = new Map();
    private textures: Map<number, ImageBitmap | ArrayBuffer> = new Map();
    private nextEntityId = 0;
    private nextMaterialId = 0;
    private nextLightId = 0;
    private nextTextureId = 0;

    private _transforms: Float32Array;
    private _dirtyFlags: Uint8Array;
    private _capacity: number;

    /**
     * @param name     - Display name for the scene.
     * @param capacity - Initial entity pool size (auto-grows as needed).
     */
    constructor(name: string, capacity: number = DEFAULT_CAPACITY) {
        this.name = name;
        this.camera = createDefaultCamera();
        this._capacity = capacity;
        this._transforms = new Float32Array(capacity * 16);
        this._dirtyFlags = new Uint8Array(capacity);
    }

    /**
     * Computes the combined view-projection matrix from the active camera.
     * @param aspectRatio - Canvas width / height.
     * @returns Row-major 4×4 VP matrix.
     */
    getViewProjectionMatrix(aspectRatio: number): Float32Array {
        const view = createLookAtMatrix(this.camera.position, this.camera.target, this.camera.up);
        const proj = createPerspectiveMatrix(this.camera.fov, aspectRatio, this.camera.near, this.camera.far);
        return mat4Multiply(proj, view);
    }

    // --- Entity management ---

    /**
     * Adds a scene object and returns its assigned entity id.
     * The object is marked fully dirty so renderers upload it on the next frame.
     */
    addObject(obj: Omit<SceneObject, "id">): number {
        const id = this.nextEntityId++;
        this.ensureCapacity(id);
        const entity: SceneObject = { ...obj, id };
        this.entities.set(id, entity);
        this._transforms.set(entity.transform, id * 16);
        this._dirtyFlags[id] = DirtyFlag.ALL as number;
        return id;
    }

    /** Removes an object by id. Returns `true` if the object existed. */
    removeObject(id: number): boolean {
        return this.entities.delete(id);
    }

    /** Retrieves an object by id, or `undefined` if not found. */
    getObject(id: number): SceneObject | undefined {
        return this.entities.get(id);
    }

    /** Returns an iterator over all scene objects. */
    getObjects(): IterableIterator<SceneObject> {
        return this.entities.values();
    }

    get objectCount(): number {
        return this.entities.size;
    }

    // --- Material management ---

    /** Registers a material and returns its assigned id. */
    addMaterial(material: Omit<Material, "id">): number {
        const id = this.nextMaterialId++;
        this.materials.set(id, { ...material, id });
        return id;
    }

    /** Retrieves a material by id, or `undefined` if not found. */
    getMaterial(id: number): Material | undefined {
        return this.materials.get(id);
    }

    // --- Light management ---

    /** Adds a light source and returns its assigned id. */
    addLight(light: Omit<LightSource, "id">): number {
        const id = this.nextLightId++;
        this.lights.set(id, { ...light, id });
        return id;
    }

    /** Removes a light by id. */
    removeLight(id: number): boolean {
        return this.lights.delete(id);
    }

    /** Retrieves a light by id. */
    getLight(id: number): LightSource | undefined {
        return this.lights.get(id);
    }

    /** Returns an iterator over all lights. */
    getLights(): IterableIterator<LightSource> {
        return this.lights.values();
    }

    // --- Texture management ---

    /** Stores a raw texture and returns its assigned id. */
    addTexture(data: ImageBitmap | ArrayBuffer): number {
        const id = this.nextTextureId++;
        this.textures.set(id, data);
        return id;
    }

    /** Retrieves a raw texture by id, or `undefined` if not found. */
    getTexture(id: number): ImageBitmap | ArrayBuffer | undefined {
        return this.textures.get(id);
    }

    // --- Transform pool ---

    /**
     * Updates an object's model transform and marks it dirty.
     * Also writes the new matrix into the pooled transform buffer.
     */
    updateTransform(id: number, transform: Float32Array): void {
        const obj = this.entities.get(id);
        if (obj === undefined) return;
        obj.transform.set(transform);
        this._transforms.set(transform, id * 16);
        obj.dirty |= DirtyFlag.TRANSFORM;
        this._dirtyFlags[id] = (this._dirtyFlags[id] ?? 0) | DirtyFlag.TRANSFORM;
    }

    /** Pooled row-major 4×4 transform matrices for all entities (16 floats each). */
    get transforms(): Float32Array {
        return this._transforms;
    }

    /** Per-entity dirty bitmask array (see {@link DirtyFlag}). */
    get dirtyFlags(): Uint8Array {
        return this._dirtyFlags;
    }

    /** Resets all dirty flags to {@link DirtyFlag.NONE}. Call after a render pass. */
    clearDirtyFlags(): void {
        this._dirtyFlags.fill(DirtyFlag.NONE);
        for (const obj of this.entities.values()) {
            obj.dirty = DirtyFlag.NONE;
        }
    }

    // --- Internal ---

    private ensureCapacity(id: number): void {
        if (id < this._capacity) return;
        const newCapacity = Math.max(this._capacity * 2, id + 1);
        const newTransforms = new Float32Array(newCapacity * 16);
        newTransforms.set(this._transforms);
        this._transforms = newTransforms;
        const newFlags = new Uint8Array(newCapacity);
        newFlags.set(this._dirtyFlags);
        this._dirtyFlags = newFlags;
        this._capacity = newCapacity;
    }
}
