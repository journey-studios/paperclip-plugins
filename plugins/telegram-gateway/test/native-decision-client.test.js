import test from "node:test";
import assert from "node:assert/strict";
import { publishNativeDecisionCard } from "../src/native-decision-client.js";
import { createHumanDecisionDelivery } from "../src/human-decision-delivery.js";
import { companyConfig } from "../src/core.js";
import manifest from "../src/manifest.js";
const companyId = "company-native-test";
const approvalId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const cardId = "33333333-3333-4333-8333-333333333333";
const issueId = "44444444-4444-4444-8444-444444444444";
function fixture() {
  const state = new Map(), calls = [];
  const context = { destinationConversationId: conversationId, expectedRevision: "canonical-revision", status: "pending", eligible: true };
  const ctx = {
    config: { get: async () => ({ liaisonAgentId: "liaison", founderUserId: "founder", publicationEnabled: true, nativeDecisionCardsEnabled: true }) },
    chat: {
      getDecisionCardContext: async (input, company) => { calls.push({ type: "context", input, company }); return context; },
      publishDecisionCard: async (input, company) => { calls.push({ type: "native", input, company }); return { cardId, linkOnly: false }; },
      publishComment: async () => { throw new Error("Legacy transport must not be called"); },
    },
    state: { get: async (key) => state.get(JSON.stringify(key)), set: async (key, value) => state.set(JSON.stringify(key), value), delete: async (key) => state.delete(JSON.stringify(key)) },
    approvals: { list: async () => [{ id: approvalId, companyId, type: "request_board_approval", status: "pending", payload: { title: "Synthetic native card" } }] },
    companies: { get: async () => ({ issuePrefix: "JOU" }) },
    issues: { listComments: async () => { throw new Error("Legacy comment must not be created"); }, createComment: async () => { throw new Error("Legacy comment must not be created"); } },
    logger: { error() {} },
  };
  return { ctx, calls, context, state };
}

test("native client sends only decision, destination selector and expected revision, never actor or callbacks", async () => {
  const f = fixture(), decision = { kind: "approval", id: approvalId };
  const answer = await publishNativeDecisionCard(f.ctx, companyId, issueId, decision);
  assert.equal(answer.nativeCardId, cardId);
  assert.deepEqual(f.calls, [
    { type: "context", company: companyId, input: { decision, destinationIssueId: issueId } },
    { type: "native", company: companyId, input: { decision, destinationConversationId: conversationId, expectedRevision: "canonical-revision" } },
  ]);
});

test("missing host or ambiguous RPC failure never falls back to a duplicate comment", async () => {
  const f = fixture();
  await assert.rejects(() => publishNativeDecisionCard({ chat: {} }, companyId, issueId, { kind: "approval", id: approvalId }), /SDK\/host/);
  f.ctx.chat.publishDecisionCard = async () => { throw new Error("response_lost"); };
  await assert.rejects(() => publishNativeDecisionCard(f.ctx, companyId, issueId, { kind: "approval", id: approvalId }), /response_lost/);
  assert.equal(f.calls.filter((x) => x.type === "legacy").length, 0);
});

test("native context is current and validates host receipts before recording delivery", async () => {
  const f = fixture(); f.context.status = "approved";
  const answer = await publishNativeDecisionCard(f.ctx, companyId, issueId, { kind: "approval", id: approvalId });
  assert.equal(answer.delivered, false); assert.equal(f.calls.length, 1);
  f.context.status = "pending"; f.ctx.chat.publishDecisionCard = async () => ({ cardId: "not-a-card" });
  await assert.rejects(() => publishNativeDecisionCard(f.ctx, companyId, issueId, { kind: "approval", id: approvalId }), /receipt/);
});

test("delivery pipeline uses native cards and deduplicates without model or raw comment", async () => {
  const f = fixture();
  const delivery = createHumanDecisionDelivery({ companyConfig, resolveConversation: async () => ({ id: issueId, companyId, assigneeAgentId: "liaison" }) });
  const config = await companyConfig(f.ctx, companyId);
  await delivery.reconcilePendingApprovals(f.ctx, companyId, config);
  await delivery.reconcilePendingApprovals(f.ctx, companyId, config);
  assert.equal(f.calls.filter((x) => x.type === "native").length, 1);
});

test("native publication requires an explicit opt-in and adds no approval/vote permissions to plugin", async () => {
  assert.equal(manifest.instanceConfigSchema.properties.nativeDecisionCardsEnabled.default, false);
  assert.ok(manifest.capabilities.includes("chat.publications.publish_decision_card"));
  assert.ok(!manifest.capabilities.includes("approvals.respond"));
  assert.ok(!manifest.capabilities.includes("issue.interactions.respond"));
  const config = await companyConfig({ config: { get: async () => ({ liaisonAgentId: "liaison", founderUserId: "founder" }) } }, companyId);
  assert.equal(config.nativeDecisionCardsEnabled, false);
});
