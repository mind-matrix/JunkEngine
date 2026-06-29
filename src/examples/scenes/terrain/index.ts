export { createTerrainScene } from "./terrain";

import { registerDemo } from "@/examples/registry";
import { createTerrainScene } from "./terrain";

registerDemo({
    id: "procedural-terrain",
    name: "Procedural Terrain",
    description: "Procedural terrain with adjustable vertex count. Toggle between Turbo (GPU) and Crank (CPU) renderers.",
    tags: ["WebGPU", "CPU", "Benchmark"],
    create: () => createTerrainScene(),
});
