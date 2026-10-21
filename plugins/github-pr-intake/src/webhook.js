import { loadConfig } from "./company-config.js";
import { normalizeWebhook } from "./events.js";
import { headerValue, verifyGithubSignature } from "./signature.js";

/**
 * Finds the company whose webhook secret signed this delivery. Secrets are resolved per delivery and
 * never cached or logged. Every configured secret is tried so one company's secret can never be used
 * to act on another company's repositories.
 */
async function signingCompany(ctx, config, input) {
  const signature = headerValue(input.headers, "x-hub-signature-256");
  for (const { companyId, ref } of config.webhookSecrets) {
    const secret = await ctx.secrets.resolve(ref, { companyId, configPath: "webhookSecretRef" });
    if (verifyGithubSignature(input.rawBody, signature, secret)) return companyId;
  }
  return null;
}

/**
 * GitHub webhook entry point. Validates the signature, dedupes and enqueues, then returns:
 * GitHub waits ~10s and the host does not retry, so heavy work is left to the engine.
 */
export async function handleWebhook(ctx, engine, input) {
  if (input?.endpointKey !== "github") return;

  const config = await loadConfig(ctx);
  const companyId = await signingCompany(ctx, config, input);
  if (!companyId) {
    ctx.logger.warn("github-pr-intake: rejected webhook with an invalid signature", { requestId: input.requestId });
    throw new Error("invalid webhook signature");
  }

  const event = normalizeWebhook(input);
  if (event.kind === "ping") {
    ctx.logger.info("github-pr-intake: webhook ping received", { deliveryId: event.deliveryId });
    return;
  }
  if (event.kind !== "pull_request") return;

  const result = await engine.onPullEvent(event, { companyId });
  ctx.logger.info("github-pr-intake: pull_request handled", {
    deliveryId: event.deliveryId,
    repo: event.repo,
    number: event.pull.number,
    action: event.action,
    result: result.status,
    reason: result.reason,
  });
  if (result.status === "queued") engine.kick();
}
