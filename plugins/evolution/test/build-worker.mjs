import { build } from "esbuild";

// Bundle the actual pinned SDK/shared sources: their workspace export maps point
// at TS sources with .js imports, which Node's type stripping cannot resolve.
await build({
  entryPoints: [new URL("../src/worker.ts", import.meta.url).pathname],
  outfile: new URL("../.test-output/worker.mjs", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: "inline",
});
