import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { validateConfig } from "./config.js";
import { handleIssueUpdated } from "./publisher.js";

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
    ctx.events.on("issue.updated", (event) =>
      serializeCompany(event?.companyId, async () => {
        try {
          await handleIssueUpdated(ctx, event);
        } catch (error) {
          ctx.logger.error("github-pr-review-sync: issue.updated handler failed", {
            eventId: event?.eventId,
            issueId: event?.entityId,
            companyId: event?.companyId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
    ctx.logger.info("github-pr-review-sync: worker ready");
  },

  async onValidateConfig(config) {
    return validateConfig(config);
  },

  async onHealth() {
    return { status: "ok", message: "GitHub PR review sync listener active" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
