import test from "node:test";
import assert from "node:assert/strict";
import {
  allowDirectApproval,
  allowDirectInteraction,
  approvalActionRef,
  interactionActionRef,
} from "../src/decision-references.js";
import { executeDecisionCommand } from "../src/decision-commands.js";
import { buildApprovalCardBody, buildInteractionCardBody } from "../src/human-decisions.js";
import { executeFounderCommand } from "../src/commands.js";

const COMPANY = "companyA";
const FOUNDER = "founderA";
const config = { founderUserId: FOUNDER, liaisonAgentId: "liaison", chatChannels: ["telegram"], commandsEnabled: true, decisionCommandsEnabled: true };
const approval = () => ({
  id: "82fa4f78-d73f-4fe8-bf56-8e9055472644", companyId: COMPANY, type: "request_board_approval", status: "pending",
  updatedAt: "2026-10-10T00:00:00.000Z", payload: { title: "Teste claro", summary: "Aprovar canário sem efeito real" },
});
const issue = () => ({ id: "issue-122", companyId: COMPANY, identifier: "JOU-122", title: "Teste operacional", status: "blocked" });
const interaction = () => ({
  id: "c97de237-490a-4a0b-89d8-15db0eb4e9ca",
  companyId: COMPANY, issueId: "issue-122",
  kind: "request_confirmation", title: "Verificar flag canário", status: "pending",
  effectiveResolverPolicy: "human_only",
  updatedAt: "2026-10-10T00:00:00.000Z",
  payload: { rejectRequiresReason: true, prompt: "Confirme somente depois de verificar" },
});

function fakeCtx(options = {}) {
  let a = options.approval ?? approval();
  let i = options.interaction ?? interaction();
  const updates = [];
  const ctx = {
    config: { get: async () => ({ ...config, decisionCommandsEnabled: options.enabled ?? true }) },
    approvals: {
      list: async () => [a],
      decide: async (id, input, companyId) => {
        updates.push({ kind: "approval", id, input, companyId });
        a = { ...a, status: input.action === "approve" ? "approved" : "rejected" };
        return { approval: a, applied: true };
      },
    },
    issues: {
      list: async () => [issue()],
      listInteractions: async () => [i],
      respondInteraction: async (issueId, id, input, companyId) => {
        updates.push({ kind: "interaction", issueId, id, input, companyId });
        i = { ...i, status: input.action === "accept" ? "accepted" : "rejected" };
        return { interaction: i, applied: true };
      },
    },
  };
  return { ctx, updates };
}

test("disabled-by-default cards remain read-only; opt-in offers only eligible direct commands", () => {
  const ctx = { baseUrl: "https://paper.example", issuePrefix: "JOU" };
  const a = approval();
  assert.doesNotMatch(buildApprovalCardBody(a, ctx), /\/aprovar/);
  const body = buildApprovalCardBody(a, { ...ctx, decisionCommandsEnabled: true });
  assert.match(body, new RegExp("/aprovar " + approvalActionRef(a)));
  assert.match(body, /\/rejeitar/);
  const i = interaction();
  const interactionCard = buildInteractionCardBody(i, issue(), { ...ctx, decisionCommandsEnabled: true });
  assert.match(interactionCard, new RegExp("/aprovar " + interactionActionRef(i, issue()).replace(".", "\\.")));
  assert.match(interactionCard, /\/rejeitar/);
  assert.doesNotMatch(interactionCard, /o Telegram não executa a resposta/);
});

test("typed secrets/tool actions/document revisions never expose direct commands", () => {
  const ctx = { baseUrl: "https://paper.example", issuePrefix: "JOU", decisionCommandsEnabled: true };
  for (const payload of [
    { secretProposal: { version: 1 } },
    { toolAction: { version: 1 } },
    { connectionAuthorization: { version: 1 } },
    { connectionIntent: { version: 1 } },
    { target: { type: "issue_document" } },
  ]) {
    const card = buildInteractionCardBody({ ...interaction(), payload: { ...payload, prompt: "SEC-TEST-ONLY" } }, issue(), ctx);
    assert.doesNotMatch(card, /\/aprovar|\/rejeitar/);
    assert.equal(allowDirectInteraction({ ...interaction(), payload }), false);
  }
  assert.equal(allowDirectApproval({ ...approval(), type: "budget_override_required" }), false);
});

test("approval direct command requires opt-in, matching human identity and explicit CONFIRMO", async () => {
  const a = approval();
  const ref = approvalActionRef(a);
  const { ctx, updates } = fakeCtx();
  assert.match(await executeDecisionCommand(ctx, COMPANY, FOUNDER, "approve", ref + " CONFIRMO", { ...config, decisionCommandsEnabled: false }), /desativadas/);
  assert.match(await executeDecisionCommand(ctx, COMPANY, "other", "approve", ref + " CONFIRMO", config), /Founder/);
  assert.match(await executeDecisionCommand(ctx, COMPANY, FOUNDER, "approve", ref, config), /Formato/);
  assert.equal(updates.length, 0);
  assert.match(await executeDecisionCommand(ctx, COMPANY, FOUNDER, "approve", ref + " CONFIRMO", config), /Aprovação registrada/);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { kind: "approval", id: a.id, companyId: COMPANY, input: { action: "approve", actorUserId: FOUNDER, decisionNote: null } });
  assert.match(await executeDecisionCommand(ctx, COMPANY, FOUNDER, "approve", ref + " CONFIRMO", config), /não está mais pendente|não foi encontrada/);
  assert.equal(updates.length, 1);
});

test("reject command captures reason and current interaction status", async () => {
  const it = interaction();
  const ref = interactionActionRef(it, issue());
  const { ctx, updates } = fakeCtx();
  assert.match(await executeDecisionCommand(ctx, COMPANY, FOUNDER, "reject", ref, config), /Motivo obrigatório/);
  assert.match(await executeDecisionCommand(ctx, COMPANY, FOUNDER, "reject", ref + " abc", config), /Formato/);
  assert.equal(updates.length, 0);
  assert.match(await executeDecisionCommand(ctx, COMPANY, FOUNDER, "reject", ref + " Sem autorizacao confirmada", config), /Recusa registrada/);
  assert.equal(updates[0].input.reason, "Sem autorizacao confirmada");
  assert.equal(updates[0].input.action, "reject");
  assert.equal(updates[0].input.actorUserId, FOUNDER);
  assert.equal(updates[0].companyId, COMPANY);
});

test("old card reference becomes invalid if source was updated", async () => {
  const original = interaction();
  const oldRef = interactionActionRef(original, issue());
  const { ctx, updates } = fakeCtx({ interaction: { ...original, updatedAt: "2026-10-11T00:00:00.000Z" } });
  assert.match(await executeDecisionCommand(ctx, COMPANY, FOUNDER, "approve", oldRef + " CONFIRMO", config), /não está mais pendente|não foi encontrada/);
  assert.equal(updates.length, 0);
});

test("company isolation and ambiguous refs fail closed", async () => {
  const ap = approval();
  const { ctx, updates } = fakeCtx();
  ctx.approvals.list = async () => [{ ...ap, companyId: "other" }];
  assert.match(await executeDecisionCommand(ctx, COMPANY, FOUNDER, "approve", approvalActionRef(ap) + " CONFIRMO", config), /não foi encontrada|não está mais pendente/);
  ctx.issues.list = async () => [{ ...issue(), companyId: "other" }];
  assert.match(await executeDecisionCommand(ctx, COMPANY, FOUNDER, "approve", interactionActionRef(interaction(), issue()) + " CONFIRMO", config), /não foi encontrada|não está mais pendente/);
  assert.equal(updates.length, 0);
});

test("host-error reply never echoes internals or pretends the decision succeeded", async () => {
  const a = approval();
  const { ctx } = fakeCtx();
  ctx.approvals.decide = async () => { throw new Error("DO_NOT_LEAK_INTERNAL_TOKEN"); };
  const text = await executeDecisionCommand(ctx, COMPANY, FOUNDER, "approve", approvalActionRef(a) + " CONFIRMO", config);
  assert.match(text, /Não foi possível confirmar/);
  assert.doesNotMatch(text, /DO_NOT_LEAK/);
});

test("gateway command actor must originate from Telegram-linked host principal", async () => {
  const { ctx, updates } = fakeCtx();
  const ap = approvalActionRef(approval());
  const params = { command: "aprovar", args: ap + " CONFIRMO", provider: "telegram", assigneeAgentId: "liaison" };
  const valid = { companyId: COMPANY, actor: { type: "user", companyId: COMPANY, userId: FOUNDER } };
  assert.deepEqual(await executeFounderCommand(ctx, params, { ...valid, actor: { ...valid.actor, userId: "other" } }), { handled: true, text: "Este comando é restrito ao Founder vinculado no Paperclip." });
  assert.deepEqual(await executeFounderCommand(ctx, params, { ...valid, actor: { ...valid.actor, type: "agent" } }), { handled: false });
  assert.deepEqual(await executeFounderCommand(ctx, { ...params, assigneeAgentId: "other" }, valid), { handled: false });
  assert.equal(updates.length, 0);
  const reply = await executeFounderCommand(ctx, params, valid);
  assert.equal(reply.handled, true);
  assert.match(reply.text, /Aprovação registrada/);
  assert.equal(updates.length, 1);
});
