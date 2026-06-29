import "./examples/scenes";
import { getDemos, getDemo } from "./examples/registry";

window.addEventListener("DOMContentLoaded", () => {
    const canvas = document.getElementById("canvas") as HTMLCanvasElement | null;

    if (canvas) {
        const params = new URLSearchParams(window.location.search);
        const demoId = params.get("demo");
        const entry = demoId ? getDemo(demoId) : getDemos()[0];
        if (!entry) {
            document.body.innerHTML = `<p style="color:#888;padding:40px;font-family:monospace">Demo "${demoId}" not found.</p>`;
            return;
        }
        document.title = `${entry.name} - JunkEngine`;
        const { start } = entry.create();
        start(canvas).catch((err) => console.error("Failed to start demo:", err));
    } else {
        renderLandingPage();
    }
});

function renderLandingPage(): void {
    const grid = document.getElementById("demo-grid");
    if (!grid) return;

    for (const demo of getDemos()) {
        const card = document.createElement("a");
        card.className = "demo-card";
        card.href = `demo.html?demo=${demo.id}`;
        card.innerHTML = `
            <h3>${demo.name}</h3>
            <p>${demo.description}</p>
            <div class="tags">${demo.tags.map((t) => `<span class="tag">${t}</span>`).join("")}</div>
        `;
        grid.appendChild(card);
    }
}
