import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";
const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx", sourcemap: false });
await Promise.all([
  esbuild.build({
    ...presets.esbuild.worker,
    entryPoints: ["src/worker.js"],
    // The existing AWS SDK signer includes CommonJS Node transports.
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  }),
  esbuild.build({ ...presets.esbuild.manifest, entryPoints: ["src/manifest.js"] }),
  esbuild.build(presets.esbuild.ui),
]);
