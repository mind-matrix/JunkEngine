export { createTankScene } from "./tank";

import { registerDemo } from "@/examples/registry";
import { createTankScene } from "./tank";

registerDemo({
    id: "tank",
    name: "Tank",
    description: "PBR-lit tank model with FXAA post-processing and background music.",
    tags: ["WebGPU", "PBR"],
    create: () => createTankScene(),
});
