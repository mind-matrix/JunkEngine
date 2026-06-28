export * from "./engine";

import { createTvScene } from "@/examples/scenes/tank";

window.addEventListener("DOMContentLoaded", () => {
    const canvas = document.getElementById("canvas") as HTMLCanvasElement | null;
    if (canvas === null) throw new Error("Canvas element not found");
    const { start } = createTvScene();
    start(canvas).catch((err) => { console.error("Failed to start TV scene:", err); });
});
