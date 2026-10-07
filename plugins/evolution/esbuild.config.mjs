import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({
  pluginRoot: process.cwd(),
  uiEntry: "src/ui/index.tsx",
  sourcemap: true,
});

const worker = await esbuild.context(presets.esbuild.worker);
const manifest = await esbuild.context(presets.esbuild.manifest);
const ui = await esbuild.context(presets.esbuild.ui);

try {
  await Promise.all([worker.rebuild(), manifest.rebuild(), ui.rebuild()]);
} finally {
  await Promise.all([worker.dispose(), manifest.dispose(), ui.dispose()]);
}
