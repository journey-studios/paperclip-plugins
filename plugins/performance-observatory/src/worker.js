import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { configOf, record, uuid } from "./contract.js";
import { TOOLS } from "./manifest.js";
import { reconcile } from "./engine.js";
import { enqueue, getRun, listRuns, targets } from "./store.js";

let active = null;

function operations(ctx, companyId) {
  return {
    list: (params) => listRuns(ctx, companyId, params),
    get: (params) => getRun(ctx, companyId, params.runId),
    targets: () => targets(ctx, companyId),
    request: (params, source = "command") => enqueue(ctx, companyId, params.targetKey, source, params.requestKey),
  };
}
const plugin = definePlugin({
  async setup(ctx) {
    active = ctx;
    let ticking = false;
    ctx.jobs.register("collect", async () => {
      if (ticking) return;
      ticking = true;
      try { await reconcile(ctx); } finally { ticking = false; }
    });
    ctx.data.register("runs", (params) => operations(ctx, uuid(params.companyId)).list(params));
    ctx.data.register("run", (params) => operations(ctx, uuid(params.companyId)).get(params));
    ctx.data.register("targets", (params) => operations(ctx, uuid(params.companyId)).targets());
    ctx.actions.register("request_review", (params, context) => operations(ctx, uuid(context.companyId)).request(params, "manual"));
    for (const declaration of TOOLS) {
      ctx.tools.register(declaration.name, declaration, async (raw, context) => {
        try {
          const params = record(raw);
          const ops = operations(ctx, uuid(context.companyId));
          let data;
          if (declaration.name === "request_review") data = await ops.request(params, "agent");
          if (declaration.name === "list_runs") data = await ops.list(params);
          if (declaration.name === "get_run") data = await ops.get(params);
          if (declaration.name === "list_targets") data = await ops.targets();
          return { content: JSON.stringify(data), data };
        } catch (error) { return { error: error instanceof Error ? error.message : "INVALID_REQUEST" }; }
      });
    }
  },
  async onApiRequest(input) {
    const headers = { "cache-control": "no-store" };
    if (!active) return { status: 503, headers, body: { error: "WORKER_NOT_READY" } };
    try {
      const ops = operations(active, uuid(input.companyId));
      let data;
      if (input.routeKey === "runs-list") data = await ops.list(input.query);
      if (input.routeKey === "run-get") data = await ops.get(input.params);
      if (input.routeKey === "targets-list") data = await ops.targets();
      if (input.routeKey === "review-request") data = await ops.request(record(input.body), "api");
      return { status: 200, headers, body: { data } };
    } catch (error) { return { status: 400, headers, body: { error: error instanceof Error ? error.message : "INVALID_REQUEST" } }; }
  },
  async onValidateConfig(config) {
    try { configOf(config); return { ok: true }; }
    catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : "INVALID_CONFIG"] }; }
  },
  async onHealth() { return { status: "ok", message: "Ephemeral executor; scheduled reviews and private history" }; },
});
export default plugin;
runWorker(plugin, import.meta.url);
