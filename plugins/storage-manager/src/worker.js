import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { getHotspots, getOverview, parseLimit } from "./service.js";

let pluginContext;
const tools = [
  { name: "storage_overview", displayName: "Storage Manager overview", readOnly: true },
  { name: "storage_hotspots", displayName: "Storage Manager hotspots", readOnly: true },
];
const params = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const unavailable = () => ({ error: "Storage Manager could not read a company-scoped snapshot" });

const plugin = definePlugin({
  async setup(ctx) {
    pluginContext = ctx;
    ctx.data.register("overview", async (input) => getOverview(ctx, params(input).companyId));
    ctx.data.register("hotspots", async (input) => getHotspots(ctx, params(input).companyId, parseLimit(params(input).limit)));
    ctx.tools.register("storage_overview", {
      displayName: "Storage Manager overview",
      description: "Read host disk capacity, Docker storage accounting, provenance and freshness; no cleanup operations.",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
    }, async (_input, runCtx) => {
      try {
        const data = await getOverview(ctx, runCtx.companyId);
        const fs = data.filesystem;
        return { content: fs ? "Storage " + data.status + ": " + fs.usedPercent + "% used, " + fs.availableBytes + " bytes available; collected " + data.generatedAt + ". Docker sizes may overlap." : "Storage snapshot " + data.status + " (" + data.reason + ").", data };
      } catch { return unavailable(); }
    });
    ctx.tools.register("storage_hotspots", {
      displayName: "Storage Manager hotspots",
      description: "Read a bounded ranked list of measured storage directories. Nested directories are not additive.",
      parametersSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false },
    }, async (input, runCtx) => {
      try {
        const data = await getHotspots(ctx, runCtx.companyId, parseLimit(params(input).limit));
        return { content: data.directories.length ? data.directories.map((dir) => dir.label + ": " + dir.bytes + " bytes").join("; ") + ". Nested paths overlap." : "No current measured storage directories (" + data.status + ").", data };
      } catch { return unavailable(); }
    });
  },
  async onApiRequest(input) {
    if (input.method !== "GET") return { status: 405, body: { error: "Method not allowed" } };
    try {
      if (input.routeKey === "tools") {
        await getOverview(pluginContext, input.companyId);
        return { body: { tools } };
      }
      if (input.routeKey === "overview") return { body: await getOverview(pluginContext, input.companyId) };
      if (input.routeKey === "hotspots") return { body: await getHotspots(pluginContext, input.companyId, parseLimit(input.query?.limit)) };
      return { status: 404, body: { error: "Unknown Storage Manager route" } };
    } catch (error) {
      const status = error?.status === 400 ? 400 : 500;
      pluginContext?.logger?.error("Storage Manager API read failed", { routeKey: input.routeKey });
      return { status, body: { error: status === 400 ? "Invalid Storage Manager request" : "Storage Manager unavailable" } };
    }
  },
  async onHealth() { return { status: "ok", message: "Storage Manager plugin ready; collector readiness is displayed separately" }; },
});

export default plugin;
runWorker(plugin, import.meta.url);
