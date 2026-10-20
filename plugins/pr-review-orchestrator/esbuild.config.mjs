import esbuild from "esbuild";

await Promise.all([
  esbuild.build({
    entryPoints: ["src/worker.js"],
    outfile: "dist/worker.js",
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    packages: "external",
    sourcemap: false,
  }),
  esbuild.build({
    entryPoints: ["src/manifest.js"],
    outfile: "dist/manifest.js",
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    packages: "external",
    sourcemap: false,
  }),
]);
