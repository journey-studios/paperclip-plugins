import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({
  uiEntry: "src/ui/index.tsx",
  sourcemap: false,
});
await Promise.all([
  esbuild.build(presets.esbuild.worker),
  esbuild.build(presets.esbuild.manifest),
  esbuild.build(presets.esbuild.ui),
]);
