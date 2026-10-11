import test from "node:test";
import assert from "node:assert/strict";
import { nativeDecisionPublicationEnabled, publishNativeDecision } from "../src/native-decision-client.js";
import { createHumanDecisionDelivery } from "../src/human-decision-delivery.js";
import { companyConfig, validateConfig } from "../src/core.js";
import manifest from "../src/manifest.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const issueId = "00000000-0000-4000-8000-000000000002";
const approvalId = "00000000-0000-4000-8000-000000000003";
const cardId = "00000000-0000-4000-8000-000000000004";
const conversationId = "00000000-0000-4000-8000-000000000005";
const config = { nativeDecisionCardsEnabled: true, publicationEnabled: true, immediateEnabled: true,
  liaisonAgentId: "liaison", founderUserId: "founder", webBaseUrl: "https://paper.example" };
function fixture() {
  const entries = new Map(), calls = [], comments = [], logs = [];
  const approval = { id: approvalId, companyId, type: "request_board_approval", status: "pending", updatedAt: "2026-10-11T00:00:00Z", payload: { title: "Synthetic card" } };
  const scopeKey = (s) => JSON.stringify(s);
  const ctx = {
    state: { get: async (s) => entries.get(scopeKey(s)), set: async (s,v) => entries.set(scopeKey(s),structuredClone(v)), delete: async(s) => entries.delete(scopeKey(s)) },
    companies: { get: async () => ({ id: companyId, issuePrefix: "JOU" }) },
    approvals: { get: async () => approval, list: async () => [approval] },
    issues: { listComments: async () => [], createComment: async (...args) => { comments.push(args); return { id: "legacy-comment" }; } },
    logger: { error: (...args) => logs.push(args) },
    chat: {
      getDecisionCardContext: async (input, company) => { calls.push({ method: "context", input, company }); return { destinationConversationId: conversationId, expectedRevision: "rev-1", status: "pending", eligible: true }; },
      publishDecisionCard: async (input, company) => { calls.push({ method: "native", input, company }); return { cardId, linkOnly: false }; },
      publishComment: async (...args) => { calls.push({ method: "legacy", args }); return { state: "published" }; },
    },
  };
  const delivery = createHumanDecisionDelivery({ companyConfig: async () => config,
    resolveConversation: async () => ({ id: issueId, companyId, assigneeAgentId: "liaison" }) });
  return { ctx, delivery, approval, calls, comments, logs, entries };
}

test("native buttons are opt-in and add publication authority only", async () => {
  const { ctx } = fixture();
  assert.equal(nativeDecisionPublicationEnabled(ctx, config), true);
  for (const patch of [{ nativeDecisionCardsEnabled: false }, { publicationEnabled: false }])
    assert.equal(nativeDecisionPublicationEnabled(ctx, { ...config, ...patch }), false);
  assert.equal(nativeDecisionPublicationEnabled({ chat: {} }, config), false);
  assert.equal(manifest.instanceConfigSchema.properties.nativeDecisionCardsEnabled.default, false);
  assert.ok(manifest.capabilities.includes("chat.publications.publish_decision_card"));
  assert.ok(!manifest.capabilities.includes("approvals.respond"));
  assert.ok(!manifest.capabilities.includes("issue.interactions.respond"));
  assert.equal((await companyConfig({ config: { get: async () => ({ liaisonAgentId: "liaison", founderUserId: "founder" }) } }, companyId)).nativeDecisionCardsEnabled, false);
  assert.equal(validateConfig({ liaisonAgentId: "liaison", founderUserId: "founder", nativeDecisionCardsEnabled: "true" }).errors.length > 0, true);
});

test("requests only canonical selectors and revision, never actor or arbitrary buttons", async () => {
  const { ctx, calls } = fixture();
  const decision = { kind: "approval", id: approvalId };
  const result = await publishNativeDecision(ctx, companyId, decision, issueId);
  assert.equal(result.nativeCardId, cardId);
  assert.deepEqual(calls, [
    { method: "context", input: { decision, destinationIssueId: issueId }, company: companyId },
    { method: "native", input: { decision, destinationConversationId: conversationId, expectedRevision: "rev-1" }, company: companyId },
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /actorUserId|callback_data|token|shell/);
});

test("native mode revalidates after restart and leaves transport dedup to the host", async () => {
  const { ctx, delivery, calls, comments } = fixture();
  const event = { companyId, entityId: approvalId };
  await delivery.handleApproval(ctx, event, config);
  await delivery.handleApproval(ctx, event, config);
  const afterRestart = createHumanDecisionDelivery({ companyConfig: async () => config,
    resolveConversation: async () => ({ id: issueId, companyId, assigneeAgentId: "liaison" }) });
  await afterRestart.reconcilePendingApprovals(ctx, companyId, config);
  assert.equal(comments.length, 0);
  assert.equal(calls.filter((c) => c.method === "native").length, 3);
  assert.equal(new Set(calls.filter((c) => c.method === "native").map((c) => JSON.stringify(c.input))).size, 1);
  assert.equal(calls.filter((c) => c.method === "legacy").length, 0);
});

test("ambiguous native error cannot produce a duplicate legacy message or success record", async () => {
  const { ctx, delivery, calls, comments, logs } = fixture();
  const original = ctx.chat.publishDecisionCard;
  ctx.chat.publishDecisionCard = async (...args) => { await original(...args); throw new Error("SYNTHETIC_NETWORK_FAILURE_AFTER_COMMIT"); };
  await assert.rejects(delivery.handleApproval(ctx, { companyId, entityId: approvalId }, config), (error) => {
    assert.equal(error.message, "Human decision delivery failed");
    assert.doesNotMatch(error.message, /SYNTHETIC_NETWORK_FAILURE_AFTER_COMMIT/);
    return true;
  });
  assert.equal(comments.length, 0);
  ctx.chat.publishDecisionCard = original;
  await delivery.handleApproval(ctx, { companyId, entityId: approvalId }, config);
  assert.equal(calls.filter((c) => c.method === "native").length, 2);
  assert.equal(calls.filter((c) => c.method === "legacy").length, 0);
});

test("disabled or missing client uses the original read-only publication path", async () => {
  for (const missing of [false, true]) {
    const { ctx, delivery, calls, comments } = fixture();
    if (missing) delete ctx.chat.getDecisionCardContext;
    await delivery.handleApproval(ctx, { companyId, entityId: approvalId }, { ...config, nativeDecisionCardsEnabled: missing });
    assert.equal(comments.length, 1);
    assert.equal(calls.filter((c) => c.method === "legacy").length, 1);
    assert.equal(calls.filter((c) => c.method === "native").length, 0);
  }
});

test("closed decisions, stale contexts and failed acknowledgments never fall back after write", async () => {
  const { ctx, calls } = fixture();
  ctx.chat.getDecisionCardContext = async () => ({ status: "approved" });
  assert.equal((await publishNativeDecision(ctx, companyId, { kind: "approval", id: approvalId }, issueId)).delivered, false);
  assert.equal(calls.length, 0);
  ctx.chat.getDecisionCardContext = async () => ({ status: "pending", destinationConversationId: conversationId });
  await assert.rejects(publishNativeDecision(ctx, companyId, { kind: "approval", id: approvalId }, issueId), /incomplete/);
  assert.equal(calls.length, 0);
});
