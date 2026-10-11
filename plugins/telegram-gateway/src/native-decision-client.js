const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Native decision publication is declarative. No button callback, actor ID,
 * Telegram credential or canonical vote is ever supplied by this plugin. */
export function nativeDecisionPublicationEnabled(ctx, config) {
  return config?.nativeDecisionCardsEnabled === true && config.publicationEnabled === true &&
    typeof ctx.chat?.getDecisionCardContext === "function" &&
    typeof ctx.chat?.publishDecisionCard === "function";
}

export async function publishNativeDecision(ctx, companyId, decision, destinationIssueId) {
  if (!ctx.chat?.getDecisionCardContext || !ctx.chat?.publishDecisionCard) throw new Error("Native decision-card SDK/host is required");
  // Context is read-only and resolves the authorized chat conversation from the
  // existing Liaison Issue. Only the host may choose the recipient and buttons.
  const context = await ctx.chat.getDecisionCardContext({ decision, destinationIssueId }, companyId);
  if (context?.status !== "pending") return { delivered: false, reason: "decision_no_longer_pending" };
  if (typeof context?.expectedRevision !== "string" || !context.expectedRevision ||
      !UUID.test(context?.destinationConversationId ?? "")) {
    throw new Error("Native decision context is incomplete");
  }
  // A timeout/error may occur AFTER the native transaction commits. Propagate
  // it; never create a legacy comment as fallback after this write was attempted.
  // The host's durable canonical revision/destination key makes retry safe.
  const published = await ctx.chat.publishDecisionCard({
    decision,
    destinationConversationId: context.destinationConversationId,
    expectedRevision: context.expectedRevision,
  }, companyId);
  if (!UUID.test(published?.cardId ?? "") || typeof published.linkOnly !== "boolean") {
    throw new Error("Native decision publication receipt was not acknowledged");
  }
  return { delivered: true, nativeCardId: published.cardId, nativeLinkOnly: published.linkOnly };
}

// Retain the existing companion PR's helper signature while sharing one path.
export function publishNativeDecisionCard(ctx, companyId, destinationIssueId, decision) {
  return publishNativeDecision(ctx, companyId, decision, destinationIssueId);
}
