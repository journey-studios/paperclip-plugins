import { executeFounderCommand } from "./commands.js";
import { createTelegramCommandRegistry } from "./command-registry.js";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { companyConfig, flushDigest, flushPendingImmediate, processEvent, reconcileKnownHumanDecisions, reconcileKnownPublications, reconcilePendingPublications, runDigestJob, validateConfig } from "./core.js";
import { retryTerminalHumanDecisionPublication } from "./human-decision-delivery.js";
import { registerTelegramCommandCatalogData } from "./settings-data.js";

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
    const registry = createTelegramCommandRegistry(ctx);
    registerTelegramCommandCatalogData(ctx, registry);
    for (const eventName of [
      "issue.created",
      "issue.updated",
      "issue.comment.created",
      "approval.created",
      "approval.decided",
      "budget.incident.opened",
      "agent.run.finished",
      "agent.run.failed",
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

    ctx.actions.register("telegram-command", (params, invocation) =>
      executeFounderCommand(ctx, params, invocation, registry));
    ctx.actions.register("reconcile-founder-publications", async (params, invocation) => {
      const companyId = invocation?.companyId;
      if (!companyId || invocation?.actor?.type !== "user") throw new Error("Authenticated company user required");
      const config = await companyConfig(ctx, companyId);
      if (invocation.actor.userId !== config.founderUserId) throw new Error("Founder access required");
      return serializeCompany(companyId, async () => {
        await reconcilePendingPublications(ctx, companyId, config);
        return { ok: true };
      });
    });
    ctx.actions.register("retry-terminal-human-decision-publication", async (params, invocation) => {
      const companyId = invocation?.companyId;
      if (!companyId || invocation?.actor?.type !== "user") throw new Error("Authenticated company user required");
      if (params?.companyId !== undefined && params.companyId !== companyId) throw new Error("Company scope mismatch");
      const config = await companyConfig(ctx, companyId);
      if (invocation.actor.userId !== config.founderUserId) throw new Error("Founder access required");
      return serializeCompany(companyId, () => retryTerminalHumanDecisionPublication(
        ctx, companyId, params?.commentId, config,
      ));
    });
    ctx.jobs.register("founder-digest", (job) => runDigestJob(ctx, job, serializeCompany));
    // Recovery uses the same per-company lock as live events, but must not
    // delay worker setup or block Telegram commands on provider publication.
    void reconcileKnownPublications(ctx, serializeCompany).catch((error) =>
      ctx.logger.error("Founder publication startup reconciliation failed", {
        error: error instanceof Error ? error.message : String(error),
      }));
    void reconcileKnownHumanDecisions(ctx, serializeCompany).catch((error) =>
      ctx.logger.error("Founder human decision startup reconciliation failed", {
        error: error instanceof Error ? error.message : String(error),
      }));
  },

  async onValidateConfig(config) {
    return validateConfig(config);
  },

  async onHealth() {
    return { status: "ok", message: "Telegram Gateway is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
