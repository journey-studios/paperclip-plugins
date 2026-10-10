import test from "node:test";
import assert from "node:assert/strict";
import { executeFounderCommand, listBuiltinTelegramCommands } from "../src/commands.js";
import { renderBlocked, renderToday, renderInbox, renderIssue } from "../src/operational-commands.js";

function fixture() {
  const companyId = "company-a";
  const founderUserId = "founder";
  const issues = [
    { id: "i-1", companyId, identifier: "JOU-38", title: "Reliability v1",
      status: "blocked", priority: "high", blockedByIssueIds: ["i-9"],
      assigneeUserId: founderUserId, description: "Aguardando confirmação" },
    { id: "i-2", companyId, identifier: "JOU-53", title: "Primeiro valor",
      status: "in_review", assigneeUserId: "someone-else", priority: "medium" },
    { id: "i-3", companyId, identifier: "JOU-46", title: "Aquisição",
      status: "in_progress", assigneeUserId: founderUserId },
    { id: "i-4", companyId, identifier: "JOU-66", title: "Sem atribuição",
      status: "blocked", assigneeAgentId: "agent-x" },
    { id: "i-secret", companyId: "company-b", identifier: "JOU-99", title: "Segredo",
      status: "blocked", assigneeUserId: founderUserId },
  ];
  const approvals = [
    { id: "ap-1", companyId, status: "pending", type: "budget_override_required" },
    { id: "ap-other", companyId: "company-b", status: "pending", type: "private" },
    { id: "ap-done", companyId, status: "approved", type: "old" },
  ];
  const ctx = {
    config: { get: async () => ({
      liaisonAgentId: "liaison", founderUserId, commandsEnabled: true,
      chatChannels: ["telegram"], commandProviderIds: [],
    }) },
    issues: {
      list: async (query) => issues.filter((issue) =>
        !query.status || issue.status === query.status).slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 100)),
      get: async (id) => issues.find((issue) => issue.id === id) ?? null,
    },
    approvals: { list: async () => approvals },
  };
  const invoke = (command, args = "", actor = founderUserId, scopedCompany = companyId) =>
    executeFounderCommand(ctx,
      { provider: "telegram", command, args, assigneeAgentId: "liaison" },
      { companyId: scopedCompany,
        actor: { type: "user", companyId: scopedCompany, userId: actor } });
  return { ctx, invoke, companyId };
}

test("operational commands are registered and cannot replace native controls", () => {
  const names = listBuiltinTelegramCommands().map((entry) => entry.name);
  for (const name of ["today", "inbox", "blocked", "issue"]) assert.ok(names.includes(name));
  for (const name of ["status", "task", "new", "close"]) assert.ok(!names.includes(name));
});

test("/today reports scoped bounded counts without inventing runs or costs", async () => {
  const f = fixture();
  const text = (await f.invoke("today")).text;
  assert.match(text, /Resumo operacional/);
  assert.match(text, /Em andamento: \*\*1\*\*/);
  assert.match(text, /Em revisão: \*\*1\*\*/);
  assert.match(text, /Bloqueadas: \*\*2\*\*/);
  assert.match(text, /Aprovações pendentes: \*\*1\*\*/);
  assert.doesNotMatch(text, /Segredo|private/);
  assert.match(text, /\/runs/);
});

test("/inbox shows pending approvals and only founder-assigned issues", async () => {
  const f = fixture();
  const text = (await f.invoke("inbox")).text;
  assert.match(text, /Sua atenção/);
  assert.match(text, /budget\\_override\\_required/);
  assert.match(text, /JOU\\-38/);
  assert.doesNotMatch(text, /JOU\\-53|Segredo|JOU\\-66/);
});

test("/blocked shows real blocker count and explicit absence of reason", async () => {
  const f = fixture();
  const text = await renderBlocked(f.ctx, f.companyId);
  assert.match(text, /JOU\\-38/);
  assert.match(text, /Dependências: 1/);
  assert.match(text, /Motivo não informado/);
  assert.doesNotMatch(text, /Segredo/);
});

test("/issue resolves exact identifier only inside the authenticated company", async () => {
  const f = fixture();
  const text = (await f.invoke("issue", "JOU-38")).text;
  assert.match(text, /Reliability v1/);
  assert.match(text, /Prioridade/);
  assert.match(text, /Aguardando confirmação/);
  assert.match((await f.invoke("issue", "JOU-99")).text, /não encontrada/);
  assert.match((await f.invoke("issue", "JOU-38; DROP TABLE")).text, /Uso/);
});

test("all operational commands fail closed for non-founder and invalid host identity", async () => {
  const f = fixture();
  for (const name of ["today", "inbox", "blocked", "issue"]) {
    const args = name === "issue" ? "JOU-38" : "";
    const denied = await f.invoke(name, args, "someone-else");
    assert.match(denied.text, /restrito ao Founder/);
    const invalid = await executeFounderCommand(f.ctx,
      { provider: "telegram", command: name, args, assigneeAgentId: "liaison" },
      { companyId: f.companyId, actor: { type: "agent", companyId: f.companyId, userId: "founder" } });
    assert.deepEqual(invalid, { handled: false });
  }
});

test("issue lookup distinguishes a bounded scan from verified not-found", async () => {
  const f = fixture();
  f.ctx.issues.list = async ({ companyId, limit }) =>
    Array.from({ length: limit }, (_, i) => ({
      id: "i-" + i, companyId, identifier: "JOU-" + (i + 1000), status: "todo",
    }));
  assert.match(await renderIssue(f.ctx, f.companyId, "JOU-38"), /primeiras 500/);
});

test("dashboard does not report a full count from capped pages", async () => {
  const f = fixture();
  f.ctx.issues.list = async ({ companyId, status, limit }) =>
    Array.from({ length: limit }, (_, i) => ({
      id: "i-" + i, companyId, identifier: "JOU-" + (i + 1000),
      status, title: "Tarefa",
    }));
  const text = await renderToday(f.ctx, f.companyId);
  assert.match(text, /Em andamento: \*\*100\+\*\*/);
  assert.match(text, /Bloqueadas: \*\*100\+\*\*/);
  assert.ok(text.length <= 3500);
});
