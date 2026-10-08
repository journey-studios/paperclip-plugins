import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({
  workerEntry: "src/worker.js",
  manifestEntry: "src/manifest.js",
  sourcemap: false,
});
await Promise.all([
  esbuild.build({
    ...presets.esbuild.worker,
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  }),
  esbuild.build(presets.esbuild.manifest),
]);
