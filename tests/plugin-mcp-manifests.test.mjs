import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

/**
 * Assert uniqueness for every plugin routeKey at source, before packaging.
 * The deployed host manifest validator is checked separately at rollout;
 * the pinned compatibility SDK does not expose all installed host tables.
 */
test("all embedded MCP routes have valid unique keys and board company scope", async () => {
  for (const plugin of ["agent-observatory", "artifact-library", "evolution"]) {
    const source = plugin === "agent-observatory" ? "manifest.js" : "manifest.ts";
    const output = await build({
      entryPoints: [`plugins/${plugin}/src/${source}`],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      logLevel: "silent",
    });
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`;
    const { default: manifest } = await import(moduleUrl);
    const declaredKeys = manifest.apiRoutes.map((route) => route.routeKey);
    assert.equal(new Set(declaredKeys).size, declaredKeys.length, `${plugin}: routeKey must be unique`);
    const routes = manifest.apiRoutes.filter((route) => route.path === "/mcp");
    assert.equal(routes.length, 2, `${plugin}: exactly GET and POST /mcp`);
    assert.deepEqual(routes.map((route) => route.method).sort(), ["GET", "POST"]);
    assert.equal(new Set(routes.map((route) => route.routeKey)).size, 2);
    assert(routes.every((route) => route.auth === "board"
      && route.capability === "api.routes.register"
      && route.companyResolution.from === "query"
      && route.companyResolution.key === "companyId"));
  }
});
