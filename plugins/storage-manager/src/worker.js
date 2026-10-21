import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { getHotspots, getOverview, parseLimit } from "./service.js";

let pluginContext;
const tools = [
  { name: "vps_status", displayName: "VPS status", readOnly: true },
  { name: "storage_overview", displayName: "Storage overview", readOnly: true },
  { name: "storage_hotspots", displayName: "Storage hotspots", readOnly: true },
];
const params = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const unavailable = () => ({ error: "VPS Status could not read a company-scoped snapshot" });
const gib = (bytes) => (bytes / 1024 ** 3).toFixed(1) + " GiB";
function summarize(data) {
  const fs = data.filesystem;
  if (!fs) return "VPS status snapshot " + data.status + " (" + data.reason + ").";
  const parts = ["Disk " + fs.usedPercent + "% used, " + gib(fs.availableBytes) + " free"];
  if (data.cpu) parts.push("CPU " + data.cpu.usagePercent + "% of " + data.cpu.cores + " cores, load " + data.cpu.load1 + "/" + data.cpu.load5 + "/" + data.cpu.load15);
  if (data.memory) parts.push("memory " + data.memory.usedPercent + "% (" + gib(data.memory.usedBytes) + " of " + gib(data.memory.totalBytes) + "), swap " + gib(data.memory.swapUsedBytes) + " of " + gib(data.memory.swapTotalBytes));
  if (data.uptimeSeconds !== null) parts.push("uptime " + Math.floor(data.uptimeSeconds / 3600) + "h");
  if (data.workers?.length) parts.push("workers " + data.workers.map((worker) => worker.label + " " + worker.state + (worker.health ? " (" + worker.health + ")" : "") + (worker.cpuPercent !== null ? ", CPU " + worker.cpuPercent + "%" : "") + (worker.memoryUsedBytes !== null ? ", mem " + gib(worker.memoryUsedBytes) : "")).join("; "));
  return "VPS " + data.status + ": " + parts.join("; ") + "; collected " + data.generatedAt + ". Docker sizes may overlap.";
}

const plugin = definePlugin({
  async setup(ctx) {
    pluginContext = ctx;
    ctx.data.register("overview", async (input) => getOverview(ctx, params(input).companyId));
    ctx.data.register("hotspots", async (input) => getHotspots(ctx, params(input).companyId, parseLimit(params(input).limit)));
    ctx.tools.register("vps_status", {
      displayName: "VPS status",
      description: "Read VPS disk, CPU, memory and swap, uptime, Docker accounting, provenance and freshness; no cleanup operations.",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
    }, async (_input, runCtx) => {
      try {
        const data = await getOverview(ctx, runCtx.companyId);
        return { content: summarize(data), data };
      } catch { return unavailable(); }
    });
    ctx.tools.register("storage_overview", {
      displayName: "Storage overview",
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
      displayName: "Storage hotspots",
      description: "Read a bounded ranked list of measured storage directories. Nested directories are not additive.",
      parametersSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false },
    }, async (input, runCtx) => {
      try {
        const data = await getHotspots(ctx, runCtx.companyId, parseLimit(params(input).limit));
        return { content: data.directories.length ? "Snapshot " + data.status + " (collected " + data.generatedAt + "): " + data.directories.map((dir) => dir.label + ": " + dir.bytes + " bytes").join("; ") + ". Nested paths overlap." : "No current measured storage directories (" + data.status + ").", data };
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
      return { status: 404, body: { error: "Unknown VPS Status route" } };
    } catch (error) {
      const status = error?.status === 400 ? 400 : 500;
      pluginContext?.logger?.error("VPS Status API read failed", { routeKey: input.routeKey });
      return { status, body: { error: status === 400 ? "Invalid VPS Status request" : "VPS Status unavailable" } };
    }
  },
  async onHealth() { return { status: "ok", message: "VPS Status plugin ready; collector readiness is displayed separately" }; },
});

export default plugin;
runWorker(plugin, import.meta.url);
