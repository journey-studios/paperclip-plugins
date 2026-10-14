import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.spec.ts", "src/**/*.spec.tsx"],
    // Each test builds a fresh PGlite fixture; under parallel CI load that setup can exceed
    // the 10 s default. Match the other PGlite-backed plugins.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
