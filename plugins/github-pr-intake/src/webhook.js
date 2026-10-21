import { normalizeConfig } from "./config.js";
import { normalizeWebhook } from "./events.js";
import { headerValue, verifyGithubSignature } from "./signature.js";

/**
 * GitHub webhook entry point. Validates the signature, dedupes and enqueues, then returns:
 * GitHub waits ~10s and the host does not retry, so heavy work is left to the engine.
 */
export async function handleWebhook(ctx, engine, input) {
  if (input?.endpointKey !== "github") return;

  const config = normalizeConfig(await ctx.config.get());
  // The secret is resolved per delivery and never cached or logged.
  const secret = config.webhookSecretRef
    ? await ctx.secrets.resolve(config.webhookSecretRef, { configPath: "webhookSecretRef" })
    : null;
  if (!verifyGithubSignature(input.rawBody, headerValue(input.headers, "x-hub-signature-256"), secret)) {
    ctx.logger.warn("github-pr-intake: rejected webhook with an invalid signature", { requestId: input.requestId });
    throw new Error("invalid webhook signature");
  }

  const event = normalizeWebhook(input);
  if (event.kind === "ping") {
    ctx.logger.info("github-pr-intake: webhook ping received", { deliveryId: event.deliveryId });
    return;
  }
  if (event.kind !== "pull_request") return;

  const result = await engine.onPullEvent(event);
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
