#!/usr/bin/env node
// Reports engine bundle size and enforces a budget.
// Usage: node scripts/check-bundle-size.mjs [--update]
//   --update  saves current size as the new baseline

import { buildSync } from "esbuild";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = resolve(ROOT, ".bundle-size-baseline");
const BUDGET_KB = 200;
const TOP_N = 10;

const result = buildSync({
    entryPoints: [resolve(ROOT, "src/engine/index.ts")],
    bundle: true,
    format: "esm",
    minify: true,
    write: false,
    metafile: true,
    tsconfig: resolve(ROOT, "tsconfig.json"),
    loader: { ".wgsl": "text" },
});

const output = result.outputFiles[0];
const totalBytes = output.contents.byteLength;
const totalKB = totalBytes / 1024;

// Per-module breakdown
const outputKey = Object.keys(result.metafile.outputs)[0];
const inputs = result.metafile.outputs[outputKey]?.inputs ?? {};
const sorted = Object.entries(inputs)
    .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput)
    .slice(0, TOP_N);

console.log(`\n  Engine bundle: ${totalKB.toFixed(1)} KB (minified)\n`);
console.log("  Top modules:");
for (const [file, { bytesInOutput }] of sorted) {
    console.log(`    ${(bytesInOutput / 1024).toFixed(1).padStart(7)} KB  ${file}`);
}
console.log();

// Compare to baseline
if (existsSync(BASELINE_PATH)) {
    const baseline = parseFloat(readFileSync(BASELINE_PATH, "utf-8"));
    const delta = totalKB - baseline;
    const sign = delta >= 0 ? "+" : "";
    console.log(`  Δ baseline: ${sign}${delta.toFixed(1)} KB (was ${baseline.toFixed(1)} KB)`);
} else {
    console.log("  No baseline found. Run with --update to save one.");
}

// Save baseline if requested
if (process.argv.includes("--update")) {
    writeFileSync(BASELINE_PATH, totalKB.toFixed(2));
    console.log(`  Baseline saved: ${totalKB.toFixed(1)} KB`);
}

// Budget check
if (totalKB > BUDGET_KB) {
    console.error(`\n  ✗ OVER BUDGET: ${totalKB.toFixed(1)} KB > ${BUDGET_KB} KB limit\n`);
    process.exit(1);
} else {
    console.log(`  ✓ Within budget (${BUDGET_KB} KB)\n`);
}
