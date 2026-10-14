import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import manifest, { DATABASE_NAMESPACE, PLUGIN_ID, PLUGIN_VERSION } from "../src/manifest.js";
import { API_ROUTES } from "../src/routes.js";
import { migrations } from "./harness.js";

describe("manifest", () => {
  it("passes the host manifest validator of the pinned Paperclip version", () => {
    const result = pluginManifestV1Schema.safeParse(manifest);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it("matches the package version", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(PLUGIN_VERSION).toBe(pkg.version);
  });

  it("uses the namespace the host derives from the plugin id", () => {
    const hash = createHash("sha256").update(PLUGIN_ID).digest("hex").slice(0, 10);
    expect(DATABASE_NAMESPACE).toBe(`plugin_project_hierarchy_${hash}`);
    for (const migration of migrations) {
      const schemas = new Set([...migration.matchAll(/\b(plugin_[a-z0-9_]+)\./g)].map((match) => match[1]));
      expect([...schemas]).toEqual([DATABASE_NAMESPACE]);
    }
  });

  it("declares every route the API dispatches", () => {
    expect(manifest.apiRoutes?.map((route) => route.routeKey)).toEqual(API_ROUTES.map((route) => route.routeKey));
  });
});
