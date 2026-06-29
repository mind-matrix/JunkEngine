import { createDirectionalLight, createPointLight, GltfImporter, Scene, ShadingMode } from "@/engine";
import { AudioOutputController } from "@/engine/controllers";
import { AntialiasingPostProcessor, AAMethod } from "@/engine/postprocessors";
import { TurboRenderer } from "@/engine/renderers";
import { transformBoundingSphere } from "@/engine/utilities/render-utils";
import { FPSController } from "@/examples/commons/FPSController";
import { VirtualJoystick } from "@/examples/commons/VirtualJoystick";

const SCENE_NAME = "Tank";
const GLB_PATH = "models/tank/source/tank.glb";
const AUDIO_PATHS = [
    "audio/oceanking-sky-farm-219728.mp3",
    "audio/dstechnician-green-sky-125179.mp3"
];

export function createTankScene(): { start: (canvas: HTMLCanvasElement) => Promise<void> } {
    const scene = new Scene(SCENE_NAME);
    scene.shadingMode = ShadingMode.PBR;

    async function start(canvas: HTMLCanvasElement): Promise<void> {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(canvas.clientWidth * dpr);
        canvas.height = Math.round(canvas.clientHeight * dpr);

        const renderer = await TurboRenderer.create(canvas);

        const fxaa = new AntialiasingPostProcessor(
            renderer.getDevice(),
            canvas.width,
            canvas.height,
            renderer.getCanvasFormat(),
            { method: AAMethod.FXAA },
        );
        renderer.postProcessor = fxaa;

        // Background music — alternate two tracks with crossfade
        const music = new AudioOutputController(0.5);
        music.loop = true;
        const FADE = 60;
        const TRACK_DURATION = 30;
        Promise.all(
            AUDIO_PATHS.map(audio => fetch(audio).then((r) => r.arrayBuffer()).then((b) => music.decode(b)))
        ).then(([trackA, trackB]) => {
            const tracks = [trackA, trackB];
            let current = 0;
            let started = false;

            function startMusic(): void {
                if (started) return;
                started = true;
                music.crossfadeTo(tracks[current]!, FADE);
                setInterval(() => {
                    current = 1 - current;
                    music.crossfadeTo(tracks[current]!, FADE);
                }, TRACK_DURATION * 1000);
            }

            // Defer playback until first user gesture (autoplay policy)
            document.addEventListener("click", startMusic, { once: true });
            document.addEventListener("keydown", startMusic, { once: true });
        }).catch((err) => console.warn("Failed to load music:", err));

        const resizeObserver = new ResizeObserver(() => {
            const w = Math.round(canvas.clientWidth * dpr);
            const h = Math.round(canvas.clientHeight * dpr);
            if (w !== canvas.width || h !== canvas.height) {
                renderer.resize(w, h);
                fxaa.resize(w, h);
            }
        });
        resizeObserver.observe(canvas);

        const joystick = new VirtualJoystick({ position: "left", size: 120 });
        const fps = new FPSController(scene.camera, { joystick });
        fps.attach(canvas);

        let loaded = false;

        // Fetch and import the GLB asynchronously
        fetch(GLB_PATH)
            .then((res) => {
                if (!res.ok) throw new Error(`Failed to fetch ${GLB_PATH}: ${res.status}`);
                return res.arrayBuffer();
            })
            .then((glb) => new GltfImporter().importAsync(glb))
            .then((imported) => {
                // Merge imported objects and materials into our scene
                for (const obj of imported.getObjects()) {
                    const importedMat = imported.getMaterial(obj.materialId);
                    // Skip meshes whose diffuse texture is nearly empty (Sketchfab export artifact)
                    if (importedMat?.diffuseTexture && isTextureEmpty(importedMat.diffuseTexture)) continue;
                    const matId = scene.addMaterial({
                        baseColor: importedMat?.baseColor ?? new Float32Array([0.8, 0.8, 0.8, 1.0]),
                        diffuseTexture: importedMat?.diffuseTexture ?? null,
                        metallicRoughnessTexture: importedMat?.metallicRoughnessTexture ?? null,
                        metallicFactor: importedMat?.metallicFactor ?? 1,
                        roughnessFactor: importedMat?.roughnessFactor ?? 1,
                        alphaMode: importedMat?.alphaMode ?? "OPAQUE",
                        alphaCutoff: importedMat?.alphaCutoff ?? 0.5,
                        normalTexture: importedMat?.normalTexture ?? null,
                        normalScale: importedMat?.normalScale ?? 1,
                    });
                    scene.addObject({
                        name: obj.name,
                        mesh: obj.mesh,
                        transform: obj.transform,
                        materialId: matId,
                        dirty: obj.dirty,
                    });
                }
                fps.setMoveSpeed(frameCameraToScene(scene));
                loaded = true;
            })
            .catch((err) => { console.error("Failed to load tank model:", err); });

        function loop(): void {
            if (loaded) {
                fps.poll();
            }
            fps.resetFrame();
            renderer.render(scene);
            requestAnimationFrame(loop);
        }

        requestAnimationFrame(loop);
    }

    return { start };
}


/** Returns true if a texture is nearly all black (< 1% non-black pixels). */
function isTextureEmpty(tex: { pixels: Uint8ClampedArray; width: number; height: number }): boolean {
    const step = Math.max(1, Math.floor(tex.pixels.length / (4 * 2000))); // sample ~2000 pixels
    let bright = 0, sampled = 0;
    for (let i = 0; i < tex.pixels.length; i += step * 4) {
        sampled++;
        if ((tex.pixels[i] ?? 0) + (tex.pixels[i + 1] ?? 0) + (tex.pixels[i + 2] ?? 0) > 30) bright++;
    }
    return sampled > 0 && bright / sampled < 0.05;
}

function frameCameraToScene(scene: Scene): number {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const obj of scene.getObjects()) {
        const wb = transformBoundingSphere(obj.mesh.bounds, obj.transform);
        minX = Math.min(minX, wb.cx - wb.radius);
        minY = Math.min(minY, wb.cy - wb.radius);
        minZ = Math.min(minZ, wb.cz - wb.radius);
        maxX = Math.max(maxX, wb.cx + wb.radius);
        maxY = Math.max(maxY, wb.cy + wb.radius);
        maxZ = Math.max(maxZ, wb.cz + wb.radius);
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const sx = maxX - minX;
    const sy = maxY - minY;
    const sz = maxZ - minZ;

    // --- Camera: fit model to viewport using FOV ---
    // Use the largest axis extent so the model fills the frame regardless of shape
    const maxExtent = Math.max(sx, sy, sz);
    const halfFov = scene.camera.fov / 2;
    const fitDist = (maxExtent / 2) / Math.tan(halfFov) * 1.1; // 1.1 = small margin
    const dist = Math.max(fitDist, 0.1);

    scene.camera.position = new Float32Array([cx + dist * 0.6, cy + dist * 0.3, cz + dist * 0.7]);
    scene.camera.target = new Float32Array([cx, cy, cz]);
    scene.camera.near = dist * 0.005;
    scene.camera.far = dist * 50;

    const cameraSpeed = dist * 0.003;

    // --- Lighting: scaled to model bounds ---
    // Key light — moderate intensity for clean toon bands
    scene.addLight(createDirectionalLight([-0.6, -0.7, 0.4], { intensity: 0.55, color: [1, 0.98, 0.95] }));
    // Fill — very subtle
    scene.addLight(createDirectionalLight([0.7, -0.1, -0.3], { intensity: 0.1, color: [0.85, 0.9, 1.0] }));
    // Rim — gentle back light
    scene.addLight(createDirectionalLight([0.2, 0.3, -1], { intensity: 0.25, color: [1, 0.95, 0.85] }));
    // Point light above model, attenuation tuned to bounding size
    const attLin = 2 / Math.max(maxExtent, 0.1);
    const attQuad = 4 / Math.max(maxExtent * maxExtent, 0.01);
    scene.addLight(createPointLight(
        [cx, cy + maxExtent * 0.8, cz],
        { intensity: maxExtent * 0.3, color: [1, 0.97, 0.93], attenuation: { constant: 1, linear: attLin, quadratic: attQuad } },
    ));

    return cameraSpeed;
}
