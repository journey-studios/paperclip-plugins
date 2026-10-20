import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { parseConfig, validateConfig, configurationForRepository } from "./config.js";
import { header, parsePullRequestDelivery, peekRepository, verifyGithubSignature } from "./github.js";
import {
  closeReview,
  dispatchQueued,
  enqueueReview,
  finishByRunId,
  finishReview,
  reconcileCompany,
} from "./queue.js";

let context = null;
const configuredCompanies = new Map();

function eventIssueId(event) {
  const payload = event?.payload;
  if (typeof payload?.issueId === "string") return payload.issueId;
  if (typeof payload?.nativeIssueId === "string") return payload.nativeIssueId;
  if (typeof payload?.issue?.id === "string") return payload.issue.id;
  if (typeof payload?.contextSnapshot?.issueId === "string") return payload.contextSnapshot.issueId;
  if (event?.eventType === "issue.updated" && typeof event.entityId === "string") return event.entityId;
  return null;
}

async function handleReviewEvent(ctx, event, outcome) {
  const companyId = event?.companyId;
  const config = configuredCompanies.get(companyId);
  if (!config?.enabled) return;
  const issueId = eventIssueId(event);
  const runId = typeof event?.entityId === "string" ? event.entityId : null;
  const result = issueId
    ? await finishReview(ctx, companyId, issueId, outcome, config.maxAttempts)
    : await finishByRunId(ctx, companyId, runId, outcome, config.maxAttempts);
  if (result.updated) {
    await dispatchQueued(ctx, companyId, { maxAttempts: config.maxAttempts });
  }
}

export const plugin = definePlugin({
  multiCompanyConfig: true,

  async setup(ctx) {
    context = ctx;
    for (const kind of ["agent.run.finished", "agent.run.failed", "agent.run.cancelled"]) {
      ctx.events.on(kind, async (event) => {
        const success = kind === "agent.run.finished";
        await handleReviewEvent(ctx, event, success);
      });
    }
    ctx.events.on("issue.updated", async (event) => {
      const issueId = eventIssueId(event);
      if (!issueId || !configuredCompanies.get(event.companyId)?.enabled) return;
      const issue = await ctx.issues.get(issueId, event.companyId);
      if (issue?.status === "done") {
        await handleReviewEvent(ctx, event, true);
      } else if (issue?.status === "cancelled") {
        await handleReviewEvent(ctx, event, false);
      }
    });

    ctx.jobs.register("reconcile", async () => {
      for (const [companyId, config] of configuredCompanies) {
        if (!config.enabled) continue;
        try {
          await reconcileCompany(ctx, companyId, { maxAttempts: config.maxAttempts });
        } catch (error) {
          ctx.logger.error("PR review queue reconciliation failed", {
            companyId,
            error: String(error?.message ?? error).slice(0, 350),
          });
          throw error;
        }
      }
    });
  },

  async onConfigChanged(raw, scope) {
    const companyId = scope?.companyId;
    if (!companyId) return;
    const result = parseConfig(raw);
    if (!result.ok) {
      configuredCompanies.delete(companyId);
      context?.logger.warn("PR review configuration rejected", {
        companyId,
        errors: result.errors,
      });
      return;
    }
    configuredCompanies.set(companyId, result.config);
    // No AI invocation on a config change. Reconciliation is event/job-driven.
  },

  async onValidateConfig(config) {
    return validateConfig(config);
  },

  async onWebhook(input) {
    if (!context || input.endpointKey !== "github") {
      throw new Error("Unsupported or uninitialized webhook");
    }
    const { repository, payload } = peekRepository(input.rawBody);
    // Use only allowlisted repository routing to resolve the correct secret.
    // No work is created until HMAC authentication succeeds.
    const target = configurationForRepository(configuredCompanies, repository);
    if (!target) throw new Error("Repository is not mapped to an enabled company");

    const signature = header(input.headers, "x-hub-signature-256");
    const secret = await context.secrets.resolve(
      target.config.githubWebhookSecretRef,
      { companyId: target.companyId, configPath: "githubWebhookSecretRef" },
    );
    if (!verifyGithubSignature(input.rawBody, signature, secret)) {
      throw new Error("Invalid GitHub webhook signature");
    }

    const event = parsePullRequestDelivery(input, payload);
    if (!event) return;
    if (event.closed || event.action === "converted_to_draft") {
      await closeReview(context, target.companyId, event, event.closed ? "closed" : "superseded");
      return;
    }
    if (target.config.ignoreDrafts && event.draft) return;

    const result = await enqueueReview(context, target.companyId, target.route, event);
    const promoted = await dispatchQueued(context, target.companyId, {
      maxAttempts: target.config.maxAttempts,
    });
    context.logger.info("GitHub PR review accepted", {
      companyId: target.companyId,
      repository,
      prNumber: event.number,
      sha: event.sha,
      created: result.created,
      dispatched: promoted.dispatched,
    });
  },

  async onHealth() {
    return {
      status: "ok",
      message: "GitHub review event router active; no polling agent required",
      details: { configuredCompanies: configuredCompanies.size },
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
