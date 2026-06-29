import { createDirectionalLight, createMeshData, createIdentityTransform, Scene, ShadingMode } from "@/engine";
import { TurboRenderer } from "@/engine/renderers";
import { CrankRenderer } from "@/engine/renderers/crank";
import { MeshData } from "@/engine/models/SceneObject";
import { FPSController } from "@/examples/commons/FPSController";
import { VirtualJoystick } from "@/examples/commons/VirtualJoystick";

type ActiveRenderer = TurboRenderer | CrankRenderer;

const SCENE_NAME = "Procedural Terrain";
const MIN_VERTICES = 100;
const MAX_VERTICES = 1_000_000;
const DEFAULT_VERTICES = 10_000;
const TERRAIN_SIZE = 50;

export function createTerrainScene(): { start: (canvas: HTMLCanvasElement) => Promise<void> } {
    const scene = new Scene(SCENE_NAME);
    scene.shadingMode = ShadingMode.PBR;

    async function start(initialCanvas: HTMLCanvasElement): Promise<void> {
        const dpr = window.devicePixelRatio || 1;
        let canvas = initialCanvas;
        canvas.width = Math.round(canvas.clientWidth * dpr);
        canvas.height = Math.round(canvas.clientHeight * dpr);

        let renderer: ActiveRenderer = await TurboRenderer.create(canvas);
        let usingTurbo = true;
        let resolutionScale = 0.25;

        function replaceCanvas(): HTMLCanvasElement {
            const parent = canvas.parentElement!;
            const w = canvas.clientWidth;
            const h = canvas.clientHeight;
            const newCanvas = document.createElement("canvas");
            newCanvas.id = canvas.id;
            parent.replaceChild(newCanvas, canvas);
            canvas = newCanvas;
            const scale = usingTurbo ? dpr : resolutionScale;
            canvas.width = Math.round(w * scale);
            canvas.height = Math.round(h * scale);
            fps.detach();
            fps.attach(canvas);
            return newCanvas;
        }

        scene.addLight(createDirectionalLight([-0.5, -0.8, 0.3], { intensity: 0.7, color: [1, 0.98, 0.95] }));
        scene.addLight(createDirectionalLight([0.5, -0.3, -0.6], { intensity: 0.3, color: [0.85, 0.9, 1.0] }));

        const matId = scene.addMaterial({
            baseColor: new Float32Array([0.4, 0.65, 0.3, 1.0]),
            diffuseTexture: null,
            metallicRoughnessTexture: null,
            metallicFactor: 0,
            roughnessFactor: 0.85,
            alphaMode: "OPAQUE",
            alphaCutoff: 0.5,
            normalTexture: null,
            normalScale: 1,
        });

        let terrainObjectId: number | null = null;
        let wireframeMode = false;
        let currentVertexCount = DEFAULT_VERTICES;
        let currentSeed = 0;

        function updateTerrain(): void {
            try {
                const mesh = generateTerrain(currentVertexCount, currentSeed);
                if (wireframeMode && usingTurbo) {
                    const wireIndices = trianglesToWireframeIndices(mesh.indices);
                    mesh.indices = wireIndices;
                    mesh.indexCount = wireIndices.length;
                }
                if (terrainObjectId !== null) {
                    scene.removeObject(terrainObjectId);
                }
                terrainObjectId = scene.addObject({
                    name: "terrain",
                    mesh,
                    transform: createIdentityTransform(),
                    materialId: matId,
                    dirty: 0b111,
                });
                ui.errorLabel.style.display = "none";
            } catch (e) {
                ui.errorLabel.style.display = "block";
                ui.errorLabel.textContent = e instanceof Error ? e.message : "Allocation failed — try fewer vertices";
            }
        }

        function setTerrain(vertexCount: number): void {
            currentVertexCount = vertexCount;
            updateTerrain();

            // Frame camera to terrain
            const halfSize = TERRAIN_SIZE / 2;
            const dist = TERRAIN_SIZE * 0.9;
            scene.camera.position = new Float32Array([halfSize, dist * 0.5, halfSize + dist * 0.6]);
            scene.camera.target = new Float32Array([halfSize, 0, halfSize]);
            scene.camera.near = 0.1;
            scene.camera.far = TERRAIN_SIZE * 5;
        }

        // --- Controls ---
        const joystick = new VirtualJoystick({ position: "left", size: 120 });
        const fps = new FPSController(scene.camera, { joystick, moveSpeed: 0.3 });
        fps.attach(canvas);

        // --- UI ---
        const ui = createUI(canvas.parentElement ?? document.body);

        setTerrain(DEFAULT_VERTICES);

        ui.slider.value = String(DEFAULT_VERTICES);
        ui.vertexInput.value = formatNumber(DEFAULT_VERTICES);

        ui.slider.addEventListener("input", () => {
            const count = parseInt(ui.slider.value, 10);
            ui.vertexInput.value = formatNumber(count);
            setTerrain(count);
        });

        ui.vertexInput.addEventListener("change", () => {
            let count = parseVertexInput(ui.vertexInput.value);
            if (isNaN(count) || count < MIN_VERTICES) count = MIN_VERTICES;
            ui.slider.value = String(Math.min(count, MAX_VERTICES));
            ui.vertexInput.value = formatNumber(count);
            setTerrain(count);
        });

        ui.seedRow.querySelector("div:last-child")!.addEventListener("seeddelta", ((e: CustomEvent) => {
            currentSeed += e.detail as number;
            ui.seedLabel.textContent = currentSeed.toFixed(2);
            updateTerrain();
        }) as EventListener);

        ui.rendererToggle.addEventListener("click", () => {
            if (usingTurbo) {
                usingTurbo = false;
                const newCanvas = replaceCanvas();
                const ctx = newCanvas.getContext("2d");
                if (!ctx) return;
                const crank = new CrankRenderer(newCanvas, ctx);
                crank.wireframe = wireframeMode;
                renderer = crank;
                ui.rendererToggle.textContent = "Crank (CPU)";
                ui.resRow.style.display = "flex";
            } else {
                usingTurbo = true;
                const newCanvas = replaceCanvas();
                TurboRenderer.create(newCanvas).then((r) => {
                    r.wireframe = wireframeMode;
                    renderer = r;
                    ui.rendererToggle.textContent = "Turbo (GPU)";
                    ui.resRow.style.display = "none";
                });
            }
        });

        ui.resSlider.addEventListener("input", () => {
            resolutionScale = parseFloat(ui.resSlider.value);
            ui.resLabel.textContent = `${resolutionScale.toFixed(2)}x`;
            if (!usingTurbo) {
                const newCanvas = replaceCanvas();
                const ctx = newCanvas.getContext("2d");
                if (ctx) {
                    const crank = new CrankRenderer(newCanvas, ctx);
                    crank.wireframe = wireframeMode;
                    renderer = crank;
                }
            }
        });

        ui.wireframeToggle.addEventListener("click", () => {
            wireframeMode = !wireframeMode;
            ui.wireframeToggle.textContent = `Wireframe: ${wireframeMode ? "On" : "Off"}`;
            if (usingTurbo && renderer instanceof TurboRenderer) {
                renderer.wireframe = wireframeMode;
            } else if (!usingTurbo && renderer instanceof CrankRenderer) {
                renderer.wireframe = wireframeMode;
            }
            setTerrain(currentVertexCount);
        });

        // --- FPS counter ---
        let frameCount = 0;
        let lastFpsTime = performance.now();

        function loop(): void {
            fps.poll();
            fps.resetFrame();
            renderer.render(scene);

            frameCount++;
            const now = performance.now();
            const elapsed = now - lastFpsTime;
            if (elapsed >= 500) {
                const currentFps = (frameCount / elapsed) * 1000;
                ui.fpsLabel.textContent = `${Math.round(currentFps)} FPS`;
                frameCount = 0;
                lastFpsTime = now;
            }

            requestAnimationFrame(loop);
        }

        requestAnimationFrame(loop);
    }

    return { start };
}

function generateTerrain(targetVertices: number, seed = 0): MeshData {
    const gridSize = Math.max(2, Math.floor(Math.sqrt(targetVertices)));
    const actualVertices = gridSize * gridSize;
    const step = TERRAIN_SIZE / (gridSize - 1);

    const positions = new Float32Array(actualVertices * 3);
    const normals = new Float32Array(actualVertices * 3);
    const uvs = new Float32Array(actualVertices * 2);

    // Generate heightmap using layered sine waves for organic terrain
    for (let z = 0; z < gridSize; z++) {
        for (let x = 0; x < gridSize; x++) {
            const i = z * gridSize + x;
            const px = x * step;
            const pz = z * step;

            const nx = px / TERRAIN_SIZE;
            const nz = pz / TERRAIN_SIZE;
            const height =
                Math.sin(nx * 3.0 + seed * 0.8) * Math.cos(nz * 2.5 + seed * 0.5) * 3.0 +
                Math.sin(nx * 7.1 + 1.3 + seed * 1.2) * Math.cos(nz * 6.7 + 0.8) * 1.5 +
                Math.sin(nx * 13.0 + 2.7) * Math.cos(nz * 11.3 + 1.5 + seed * 0.6) * 0.6 +
                Math.sin((nx + nz) * 5.0 + seed) * 2.0;

            positions[i * 3] = px;
            positions[i * 3 + 1] = height;
            positions[i * 3 + 2] = pz;

            uvs[i * 2] = nx;
            uvs[i * 2 + 1] = nz;
        }
    }

    // Compute normals via finite differences
    for (let z = 0; z < gridSize; z++) {
        for (let x = 0; x < gridSize; x++) {
            const i = z * gridSize + x;
            const left = x > 0 ? positions[(z * gridSize + (x - 1)) * 3 + 1]! : positions[i * 3 + 1]!;
            const right = x < gridSize - 1 ? positions[(z * gridSize + (x + 1)) * 3 + 1]! : positions[i * 3 + 1]!;
            const down = z > 0 ? positions[((z - 1) * gridSize + x) * 3 + 1]! : positions[i * 3 + 1]!;
            const up = z < gridSize - 1 ? positions[((z + 1) * gridSize + x) * 3 + 1]! : positions[i * 3 + 1]!;

            const dx = right - left;
            const dz = up - down;
            const len = Math.sqrt(dx * dx + 4 + dz * dz);
            normals[i * 3] = -dx / len;
            normals[i * 3 + 1] = 2 / len;
            normals[i * 3 + 2] = -dz / len;
        }
    }

    // Generate triangle indices
    const quads = (gridSize - 1) * (gridSize - 1);
    const indices = new Uint32Array(quads * 6);
    let idx = 0;
    for (let z = 0; z < gridSize - 1; z++) {
        for (let x = 0; x < gridSize - 1; x++) {
            const tl = z * gridSize + x;
            const tr = tl + 1;
            const bl = (z + 1) * gridSize + x;
            const br = bl + 1;
            indices[idx++] = tl;
            indices[idx++] = bl;
            indices[idx++] = tr;
            indices[idx++] = tr;
            indices[idx++] = bl;
            indices[idx++] = br;
        }
    }

    return createMeshData(positions, indices, normals, uvs);
}

function trianglesToWireframeIndices(indices: Uint32Array): Uint32Array {
    const numTriangles = indices.length / 3;
    const wireIndices = new Uint32Array(numTriangles * 6);
    for (let i = 0; i < numTriangles; i++) {
        const a = indices[i * 3]!;
        const b = indices[i * 3 + 1]!;
        const c = indices[i * 3 + 2]!;
        wireIndices[i * 6] = a;
        wireIndices[i * 6 + 1] = b;
        wireIndices[i * 6 + 2] = b;
        wireIndices[i * 6 + 3] = c;
        wireIndices[i * 6 + 4] = c;
        wireIndices[i * 6 + 5] = a;
    }
    return wireIndices;
}

interface StressUI {
    slider: HTMLInputElement;
    vertexInput: HTMLInputElement;
    fpsLabel: HTMLElement;
    errorLabel: HTMLElement;
    seedRow: HTMLElement;
    seedLabel: HTMLElement;
    rendererToggle: HTMLButtonElement;
    wireframeToggle: HTMLButtonElement;
    resRow: HTMLElement;
    resSlider: HTMLInputElement;
    resLabel: HTMLElement;
}

function createUI(parent: HTMLElement): StressUI {
    const container = document.createElement("div");
    container.style.cssText = `
        position: fixed;
        top: 56px;
        left: 16px;
        z-index: 100;
        display: flex;
        flex-direction: column;
        gap: 10px;
        font-family: 'Courier New', monospace;
        font-size: 0.8rem;
        color: #fff;
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(4px);
        padding: 16px;
        border-radius: 8px;
        min-width: 220px;
    `;

    const fpsLabel = document.createElement("div");
    fpsLabel.style.cssText = "font-size: 1.4rem; font-weight: 700;";
    fpsLabel.textContent = "-- FPS";

    const sliderRow = document.createElement("div");
    sliderRow.style.cssText = "display: flex; flex-direction: column; gap: 4px;";

    const sliderLabel = document.createElement("div");
    sliderLabel.style.cssText = "display: flex; justify-content: space-between; align-items: center; color: #aaa;";
    const labelLeft = document.createElement("span");
    labelLeft.textContent = "Vertices";
    const vertexInput = document.createElement("input");
    vertexInput.type = "text";
    vertexInput.style.cssText = `
        width: 70px;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 3px;
        color: #fff;
        font-family: inherit;
        font-size: 0.75rem;
        padding: 2px 6px;
        text-align: right;
    `;
    sliderLabel.appendChild(labelLeft);
    sliderLabel.appendChild(vertexInput);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(MIN_VERTICES);
    slider.max = String(MAX_VERTICES);
    slider.step = "100";
    slider.style.cssText = "width: 100%; cursor: pointer; accent-color: #c45e2c;";

    sliderRow.appendChild(sliderLabel);
    sliderRow.appendChild(slider);

    const buttonStyle = `
        padding: 6px 12px;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        color: #fff;
        font-family: inherit;
        font-size: 0.75rem;
        cursor: pointer;
        transition: background 0.2s;
    `;

    const rendererToggle = document.createElement("button");
    rendererToggle.textContent = "Turbo (GPU)";
    rendererToggle.style.cssText = buttonStyle;
    rendererToggle.addEventListener("mouseenter", () => { rendererToggle.style.background = "rgba(255,255,255,0.2)"; });
    rendererToggle.addEventListener("mouseleave", () => { rendererToggle.style.background = "rgba(255,255,255,0.1)"; });

    const wireframeToggle = document.createElement("button");
    wireframeToggle.textContent = "Wireframe: Off";
    wireframeToggle.style.cssText = buttonStyle;
    wireframeToggle.addEventListener("mouseenter", () => { wireframeToggle.style.background = "rgba(255,255,255,0.2)"; });
    wireframeToggle.addEventListener("mouseleave", () => { wireframeToggle.style.background = "rgba(255,255,255,0.1)"; });

    const resRow = document.createElement("div");
    resRow.style.cssText = "display: none; flex-direction: column; gap: 4px;";

    const resLabelRow = document.createElement("div");
    resLabelRow.style.cssText = "display: flex; justify-content: space-between; color: #aaa;";
    const resLabelLeft = document.createElement("span");
    resLabelLeft.textContent = "Resolution";
    const resLabel = document.createElement("span");
    resLabel.style.color = "#fff";
    resLabel.textContent = "0.25x";
    resLabelRow.appendChild(resLabelLeft);
    resLabelRow.appendChild(resLabel);

    const resSlider = document.createElement("input");
    resSlider.type = "range";
    resSlider.min = "0.1";
    resSlider.max = "1";
    resSlider.step = "0.05";
    resSlider.value = "0.25";
    resSlider.style.cssText = "width: 100%; cursor: pointer; accent-color: #c45e2c;";

    resRow.appendChild(resLabelRow);
    resRow.appendChild(resSlider);

    const seedRow = document.createElement("div");
    seedRow.style.cssText = "display: flex; flex-direction: column; gap: 4px;";

    const seedLabelRow = document.createElement("div");
    seedLabelRow.style.cssText = "display: flex; justify-content: space-between; color: #aaa;";
    const seedLabelLeft = document.createElement("span");
    seedLabelLeft.textContent = "Seed";
    const seedLabel = document.createElement("span");
    seedLabel.style.color = "#fff";
    seedLabel.textContent = "0.00";
    seedLabelRow.appendChild(seedLabelLeft);
    seedLabelRow.appendChild(seedLabel);

    const seedTrack = document.createElement("div");
    seedTrack.style.cssText = `
        width: 100%;
        height: 24px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        cursor: ew-resize;
        position: relative;
        overflow: hidden;
    `;
    const seedIndicator = document.createElement("div");
    seedIndicator.style.cssText = `
        position: absolute;
        top: 4px;
        bottom: 4px;
        left: 50%;
        width: 2px;
        background: #c45e2c;
        transform: translateX(-50%);
    `;
    seedTrack.appendChild(seedIndicator);

    let seedDragging = false;
    let seedLastX = 0;
    seedTrack.addEventListener("mousedown", (e) => { seedDragging = true; seedLastX = e.clientX; });
    seedTrack.addEventListener("touchstart", (e) => { seedDragging = true; seedLastX = e.touches[0]!.clientX; e.preventDefault(); }, { passive: false });
    const onSeedMove = (clientX: number) => {
        if (!seedDragging) return;
        const delta = (clientX - seedLastX) * 0.02;
        seedLastX = clientX;
        seedTrack.dispatchEvent(new CustomEvent("seeddelta", { detail: delta }));
    };
    document.addEventListener("mousemove", (e) => onSeedMove(e.clientX));
    document.addEventListener("touchmove", (e) => { if (seedDragging) onSeedMove(e.touches[0]!.clientX); });
    document.addEventListener("mouseup", () => { seedDragging = false; });
    document.addEventListener("touchend", () => { seedDragging = false; });

    seedRow.appendChild(seedLabelRow);
    seedRow.appendChild(seedTrack);

    const errorLabel = document.createElement("div");
    errorLabel.style.cssText = "display: none; color: #ff6b6b; font-size: 0.7rem; word-break: break-word;";

    container.appendChild(fpsLabel);
    container.appendChild(errorLabel);
    container.appendChild(sliderRow);
    container.appendChild(seedRow);
    container.appendChild(resRow);
    container.appendChild(rendererToggle);
    container.appendChild(wireframeToggle);
    parent.appendChild(container);

    return { slider, vertexInput, fpsLabel, errorLabel, seedRow, seedLabel: seedLabel as HTMLElement, rendererToggle, wireframeToggle, resRow, resSlider, resLabel };
}

function parseVertexInput(value: string): number {
    const trimmed = value.trim().toLowerCase();
    const match = trimmed.match(/^([0-9]*\.?[0-9]+)\s*(k|m|b)?$/);
    if (!match) return NaN;
    const num = parseFloat(match[1]!);
    switch (match[2]) {
        case "b": return Math.round(num * 1_000_000_000);
        case "m": return Math.round(num * 1_000_000);
        case "k": return Math.round(num * 1_000);
        default: return Math.round(num);
    }
}

function formatNumber(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}
