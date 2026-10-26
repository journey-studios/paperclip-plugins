import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";
const presets = createPluginBundlerPresets({ sourcemap: false });
await Promise.all([
  esbuild.build({ ...presets.esbuild.worker, entryPoints: ["src/worker.js"] }),
  esbuild.build({ ...presets.esbuild.manifest, entryPoints: ["src/manifest.js"] }),
]);
