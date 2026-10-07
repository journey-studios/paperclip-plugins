import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { companyConfig, flushDigest, flushPendingImmediate, processEvent, runDigestJob, validateConfig } from "./core.js";

const companyLocks = new Map();

function serializeCompany(companyId, operation) {
  if (!companyId) return operation();
  const prior = companyLocks.get(companyId) ?? Promise.resolve();
  const current = prior.catch(() => {}).then(operation);
  companyLocks.set(companyId, current);
  return current.finally(() => {
    if (companyLocks.get(companyId) === current) companyLocks.delete(companyId);
  });
}

const plugin = definePlugin({
  async setup(ctx) {
    for (const eventName of [
      "issue.created",
      "issue.updated",
      "issue.comment.created",
      "approval.created",
      "approval.decided",
      "budget.incident.opened",
    ]) {
      ctx.events.on(eventName, (event) => serializeCompany(event?.companyId, () => processEvent(ctx, event)));
    }

    ctx.actions.register("flush-founder-comms", async (params) => {
      const companyId = typeof params?.companyId === "string" ? params.companyId.trim() : "";
      if (!companyId) throw new Error("companyId is required");
      return serializeCompany(companyId, async () => {
        const config = await companyConfig(ctx, companyId);
        await flushPendingImmediate(ctx, companyId, config);
        await flushDigest(ctx, companyId);
        return { ok: true };
      });
    });

    ctx.jobs.register("founder-digest", (job) => runDigestJob(ctx, job, serializeCompany));
  },

  async onValidateConfig(config) {
    return validateConfig(config);
  },

  async onHealth() {
    return { status: "ok", message: "Founder comms router is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
