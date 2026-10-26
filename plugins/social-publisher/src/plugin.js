import manifest from "./manifest.js";
import { loadConfig, validateConfig } from "./config.js";
import * as service from "./service.js";
import * as oauth from "./oauth.js";
import { updateAccount, appendAuditLog } from "./catalog.js";
import { reconcileTelegramApprovals } from "./telegram-sync.js";
import { runEditorial } from "./editorial.js";
import { collectPostMetrics } from "./metrics.js";
import { enrollMedia, listEnrolledMedia, getMediaPreview } from "./media.js";

const canonicalTool = (name) =>
  ({
    social_accounts_list: "social.accounts.list",
    social_posts_create_draft: "social.posts.createDraft",
    social_posts_validate: "social.posts.validate",
    social_posts_preview: "social.posts.preview",
    social_posts_publish: "social.posts.publish",
    social_posts_schedule: "social.posts.schedule",
    social_posts_status: "social.posts.status",
    social_posts_cancel: "social.posts.cancel",
  })[name] ?? name;
const locks = new Map();
function serial(companyId, operation) {
  const previous = locks.get(companyId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  locks.set(companyId, current);
  return current.finally(() => {
    if (locks.get(companyId) === current) locks.delete(companyId);
  });
}
function checkActor(actor, config) {
  if (actor?.actorType === "user" && actor.actorId === config.founderUserId) return;
  if (actor?.actorType === "agent" && config.allowedAgentIds?.includes(actor.actorId)) return;
  throw Object.assign(new Error("SOCIAL_ACCESS_DENIED"), { status: 403 });
}
function founder(actor, config) {
  if (actor?.actorType !== "user" || actor.actorId !== config.founderUserId)
    throw Object.assign(new Error("FOUNDER_REQUIRED"), { status: 403 });
}
async function invoke(ctx, companyId, name, args, actor, config) {
  checkActor(actor, config);
  if (name === "social.accounts.list") return service.serviceListAccounts(ctx, companyId);
  if (name === "social.posts.createDraft")
    return service.serviceCreateDraft(ctx, companyId, args, actor, config);
  if (name === "social.posts.validate")
    return service.serviceValidatePost(ctx, companyId, args, config);
  if (name === "social.posts.preview")
    return service.servicePreviewPost(ctx, companyId, args, config);
  if (name === "social.posts.requestApproval")
    return service.serviceRequestApproval(ctx, companyId, args, actor, config);
  if (name === "social.posts.publish")
    return service.servicePublishPost(ctx, companyId, args, actor, config);
  if (name === "social.posts.schedule")
    return service.serviceSchedulePost(ctx, companyId, args, actor, config);
  if (name === "social.posts.status") return service.serviceGetPostStatus(ctx, companyId, args);
  if (name === "social.posts.cancel")
    return service.serviceCancelPost(ctx, companyId, args, actor, config);
  if (name === "social.posts.revise")
    return service.serviceReviseDraft(ctx, companyId, args, actor, config);
  if (name === "social.posts.metrics")
    return collectPostMetrics(ctx, companyId, args.postId, config);
  throw Object.assign(new Error("UNKNOWN_SOCIAL_OPERATION"), { status: 404 });
}
async function tick(ctx, companyId, config) {
  const approvals = await reconcileTelegramApprovals(ctx, companyId, config);
  const publications = await service.serviceTriggerScheduledJob(ctx, companyId, config);
  const editorial = await runEditorial(ctx, companyId, config);
  return { approvals, publications, editorial };
}
let active;
const plugin = {
  async setup(ctx) {
    active = ctx;
    for (const declaration of manifest.tools) {
      ctx.tools.register(declaration.name, declaration, async (raw, run) => {
        try {
          if (!run.companyId || !run.agentId) throw new Error("AUTHENTICATED_AGENT_REQUIRED");
          const config = await loadConfig(ctx, run.companyId);
          const actor = { actorType: "agent", actorId: run.agentId, runId: run.runId };
          const data = await serial(run.companyId, () =>
            invoke(ctx, run.companyId, canonicalTool(declaration.name), raw ?? {}, actor, config),
          );
          return { content: JSON.stringify(data), data };
        } catch (error) {
          return { error: error.message };
        }
      });
    }
    let ticking = false;
    ctx.jobs.register("publish-scheduled", async () => {
      if (ticking) return;
      ticking = true;
      try {
        for (const company of await ctx.companies.list()) {
          const config = await loadConfig(ctx, company.id);
          if (!config.founderUserId) continue;
          try {
            await serial(company.id, () => tick(ctx, company.id, config));
          } catch (error) {
            ctx.logger.error("Social queue tick failed", {
              companyId: company.id,
              code: error.code ?? "SOCIAL_QUEUE_ERROR",
            });
          }
        }
      } finally {
        ticking = false;
      }
    });
  },
  async onApiRequest(input) {
    const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
    if (!active) return { status: 503, headers, body: { error: "WORKER_NOT_READY" } };
    try {
      const { companyId, routeKey, actor } = input;
      const config = await loadConfig(active, companyId);
      founder(actor, config);
      return await serial(companyId, async () => {
        let data;
        if (routeKey === "media-enroll") data = await enrollMedia(active, companyId, input.body, actor, config);
        if (routeKey === "media-list") data = await listEnrolledMedia(active, companyId);
        if (routeKey === "media-preview") data = await getMediaPreview(active, companyId, input.params.mediaId, actor, config);
        if (routeKey === "status")
          data = {
            companyId,
            version: manifest.version,
            dryRunOnly: config.dryRunOnly !== false,
            killSwitch: config.killSwitch !== false,
            policy: "approval_required",
            ...(await service.serviceListAccounts(active, companyId)),
            oauth: oauth.oauthConfigurationStatus(config, companyId),
            editorial: {
              enabled: config.editorialEnabled === true,
              time: config.editorialTime ?? "09:00",
              timezone: config.editorialTimezone ?? "America/Sao_Paulo",
            },
          };
        if (routeKey === "accounts-list")
          data = await service.serviceListAccounts(active, companyId);
        if (routeKey === "account-update") {
          const patch = {};
          for (const key of [
            "policy",
            "autonomousOptIn",
            "killSwitch",
            "dailyLimit",
            "allowedAgentIds",
            "apiCostApproved",
            "estimatedPostCostCents",
            "dailyCostLimitCents",
          ])
            if (input.body?.[key] !== undefined) patch[key] = input.body[key];
          const account = await updateAccount(active, companyId, input.params.accountId, patch);
          if (!account) throw Object.assign(new Error("ACCOUNT_NOT_FOUND"), { status: 404 });
          await appendAuditLog(active, companyId, {
            actorType: "user",
            actorId: actor.actorId,
            accountId: account.id,
            action: "account_policy_updated",
            details: patch,
          });
          data = service.sanitizeAccountForModel(account);
        }
        const accountMethods = {
          "account-verify": oauth.verifyOAuthAccount,
          "account-refresh": oauth.refreshOAuthAccount,
          "account-disconnect": oauth.disconnectOAuthAccount,
        };
        if (accountMethods[routeKey]) {
          data = await accountMethods[routeKey](active, companyId, input.params.accountId, config);
          await appendAuditLog(active, companyId, {
            actorType: "user",
            actorId: actor.actorId,
            accountId: input.params.accountId,
            action: routeKey,
          });
        }
        const postMethods = {
          "posts-create": "social.posts.createDraft",
          "posts-list": "social.posts.status",
          "post-get": "social.posts.status",
          "post-preview": "social.posts.preview",
          "post-validate": "social.posts.validate",
          "post-request-approval": "social.posts.requestApproval",
          "post-publish": "social.posts.publish",
          "post-schedule": "social.posts.schedule",
          "post-cancel": "social.posts.cancel",
          "post-revise": "social.posts.revise",
          "post-metrics": "social.posts.metrics",
        };
        if (postMethods[routeKey])
          data = await invoke(
            active,
            companyId,
            postMethods[routeKey],
            { ...(input.body ?? {}), ...(input.query ?? {}), ...(input.params ?? {}) },
            actor,
            config,
          );
        if (routeKey === "queue-tick") data = await tick(active, companyId, config);
        if (routeKey === "post-retry-authorization")
          data = await service.serviceRetryAuthorization(
            active,
            companyId,
            { postId: input.params.postId },
            actor,
            config,
          );
        if (routeKey === "post-reconcile")
          data = await service.serviceReconcilePost(
            active,
            companyId,
            { postId: input.params.postId },
            actor,
            config,
          );
        if (routeKey === "facebook-select")
          data = await oauth.selectFacebookPage(
            active,
            companyId,
            { ...input.body, actorId: actor.actorId },
            config,
          );
        const match = /^oauth-(instagram|facebook_page|threads|x)-(authorize|callback)$/.exec(
          routeKey,
        );
        if (match) {
          const provider = match[1];
          if (match[2] === "authorize")
            data = await oauth.beginOAuth(
              active,
              companyId,
              provider,
              { actorId: actor.actorId },
              config,
            );
          else {
            data = await oauth.completeOAuth(
              active,
              companyId,
              provider,
              {
                actorId: actor.actorId,
                state: input.query.state,
                code: input.query.code,
                error: input.query.error,
              },
              config,
            );
            await appendAuditLog(active, companyId, {
              actorType: "user",
              actorId: actor.actorId,
              action: "oauth_connection_completed",
              details: { provider },
            });
          }
        }
        if (data === undefined)
          return { status: 404, headers, body: { error: "UNKNOWN_SOCIAL_ROUTE" } };
        return {
          status: routeKey === "posts-create" ? 201 : 200,
          headers,
          body: { companyId, data },
        };
      });
    } catch (error) {
      const status = error.status ?? 500;
      return {
        status,
        headers,
        body: {
          error: status >= 500 ? "SOCIAL_OPERATION_UNAVAILABLE" : (error.code ?? error.message),
        },
      };
    }
  },
  async onValidateConfig(config) {
    return validateConfig(config);
  },
  async onHealth() {
    return {
      status: "ok",
      message: "Social Publisher worker active; connectivity requires account verification",
    };
  },
};
export default plugin;
