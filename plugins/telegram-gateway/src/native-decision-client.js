const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Select a canonical decision. The native host resolves the DM, audience,
 * revision, text, tokens and buttons. No vote, Telegram credential or actor ID
 * is accepted here. Errors never fall back to a second publication channel.
 */
export async function publishNativeDecisionCard(ctx, companyId, conversationIssueId, decision) {
  if (!ctx.chat?.getDecisionCardContext || !ctx.chat?.publishDecisionCard) {
    throw new Error("Native decision-card SDK/host is required");
  }
  const context = await ctx.chat.getDecisionCardContext({ decision, destinationIssueId: conversationIssueId }, companyId);
  if (!context || !UUID.test(context.destinationConversationId) || typeof context.expectedRevision !== "string" || !context.expectedRevision) {
    throw new Error("Invalid native decision-card context");
  }
  if (context.status !== "pending") return { delivered: false, reason: "decision_not_pending" };
  const result = await ctx.chat.publishDecisionCard({ decision, destinationConversationId: context.destinationConversationId, expectedRevision: context.expectedRevision }, companyId);
  if (!result || !UUID.test(result.cardId) || typeof result.linkOnly !== "boolean") {
    throw new Error("Native decision publication receipt was not confirmed");
  }
  return { delivered: true, nativeCardId: result.cardId, issueId: conversationIssueId, publication: "native", linkOnly: result.linkOnly };
}
