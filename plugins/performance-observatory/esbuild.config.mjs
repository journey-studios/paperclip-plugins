import esbuild from "esbuild";
import { rmSync } from "node:fs";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";
const presets = createPluginBundlerPresets({ workerEntry: "src/worker.js", manifestEntry: "src/manifest.js", uiEntry: "src/ui/index.tsx", sourcemap: false });
rmSync("dist", { recursive: true, force: true });
await Promise.all([esbuild.build(presets.esbuild.worker), esbuild.build(presets.esbuild.manifest), esbuild.build(presets.esbuild.ui), esbuild.build({ entryPoints: ["src/ui/chart-library.ts"], outfile: "dist/ui/echarts.js", bundle: true, format: "iife", platform: "browser", minify: true })]);
