import test from "node:test";
import assert from "node:assert/strict";
import { companyConfig, processEvent, reconcilePendingPublications } from "../src/core.js";
import { executeFounderCommand } from "../src/commands.js";

function fixture(publisher = async () => ({ state: "published" })) {
  const companyId = "company-a";
  const issue = {
    id: "chat",
    companyId,
    originKind: "chat_channel",
    originId: "source:telegram:123",
    assigneeAgentId: "liaison",
    createdByUserId: "founder",
    responsibleUserId: "founder",
    status: "open",
  };
  const comments = [];
  const wakes = [];
  const published = [];
  const errors = [];
  const state = new Map();
  const ctx = {
    config: { get: async () => ({ founderUserId: "founder", liaisonAgentId: "liaison", publicationEnabled: true }) },
    state: {
      get: async (key) => structuredClone(state.get(JSON.stringify(key))),
      set: async (key, value) => { state.set(JSON.stringify(key), structuredClone(value)); },
      delete: async (key) => state.delete(JSON.stringify(key)),
    },
    issues: {
      get: async (id) => id === "chat" ? issue : null,
      list: async () => [issue],
      listComments: async () => comments,
      createComment: async () => {},
      requestWakeup: async () => { const runId = `run-${wakes.length + 1}`; wakes.push(runId); return { queued: true, runId }; },
    },
    approvals: { get: async () => ({ id: "approval", companyId, status: "pending", type: "budget" }) },
    companies: { get: async () => ({ id: companyId }) },
    agents: {
      get: async () => ({ id: "liaison", companyId }),
      list: async () => [{ id: "liaison", name: "Founder Liaison", status: "idle" }],
    },
    access: { members: { list: async () => [{ companyId, principalType: "user", principalId: "founder", status: "active" }] } },
    projects: { get: async () => null },
    chat: { publishComment: async (commentId, scopedCompany) => {
      published.push({ commentId, scopedCompany });
      return publisher(commentId, scopedCompany);
    } },
    logger: { error: (message, details) => errors.push({ message, details }) },
  };
  return { ctx, issue, comments, wakes, published, errors, companyId };
}
async function startAlert(f) {
  await processEvent(f.ctx, {
    companyId: f.companyId, eventId: "created", eventType: "approval.created", entityId: "approval",
  });
  assert.deepEqual(f.wakes, ["run-1"]);
}
function finalComment(f, opts = {}) {
  f.comments.push({
    id: opts.id ?? "comment-final", issueId: "chat", companyId: f.companyId,
    authorType: "agent", authorAgentId: opts.authorAgentId ?? "liaison",
    createdByRunId: opts.runId ?? "run-1", createdAt: new Date().toISOString(),
    body: "O founder precisa aprovar o orçamento.",
  });
}
const finish = (f, runId = "run-1", eventId = "finished") => processEvent(f.ctx, {
  companyId: f.companyId, eventId, eventType: "agent.run.finished", entityId: runId,
  payload: { runId, agentId: "liaison", status: "succeeded", issueId: "chat" },
});

test("publishes precisely the Liaison's final comment from the plugin wake", async () => {
  const f = fixture();
  await startAlert(f);
  finalComment(f, { runId: "unrelated", id: "foreign" });
  finalComment(f);
  await finish(f, "unrelated", "unrelated-run");
  assert.equal(f.published.length, 0);
  await finish(f);
  assert.deepEqual(f.published, [{ commentId: "comment-final", scopedCompany: "company-a" }]);
  await finish(f, "run-1", "new-finish-id");
  assert.equal(f.published.length, 1);
});

test("does not publish comments from a different agent", async () => {
  const f = fixture();
  await startAlert(f);
  finalComment(f, { authorAgentId: "other-agent" });
  await finish(f);
  assert.equal(f.published.length, 0);
});

test("does not publish a partial comment before the run has completed", async () => {
  const f = fixture();
  await startAlert(f);
  finalComment(f);
  await reconcilePendingPublications(f.ctx, f.companyId, await companyConfig(f.ctx, f.companyId));
  assert.equal(f.published.length, 0);
});

test("failed delivery can be reconciled without choosing a different comment", async () => {
  let attempts = 0;
  const f = fixture(async () => { attempts++; if (attempts === 1) throw new Error("transport timeout"); return { state: "published" }; });
  await startAlert(f);
  finalComment(f);
  await assert.rejects(finish(f), /transport timeout/);
  await reconcilePendingPublications(f.ctx, f.companyId, await companyConfig(f.ctx, f.companyId));
  assert.equal(attempts, 2);
  assert.deepEqual(f.published.map((entry) => entry.commentId), ["comment-final", "comment-final"]);
  await reconcilePendingPublications(f.ctx, f.companyId, await companyConfig(f.ctx, f.companyId));
  assert.equal(attempts, 2);
});

test("direct Telegram commands enforce host-proven user identity and company", async () => {
  const f = fixture();
  const invoke = (userId, cmd = "agents", companyId = f.companyId) =>
    executeFounderCommand(f.ctx, { provider: "telegram", command: cmd, assigneeAgentId: "liaison" },
      { companyId, actor: { type: "user", companyId, userId } });
  assert.equal((await invoke("other")).text, "Este comando é restrito ao Founder vinculado no Paperclip.");
  assert.match((await invoke("founder")).text, /Founder Liaison/);
  assert.match((await invoke("founder", "tasks")).text, /Tarefas abertas/);
  assert.match((await invoke("founder", "help")).text, /\/status/);
  assert.equal((await invoke("founder", "status")).handled, false);
  assert.equal((await executeFounderCommand(f.ctx,
    { provider: "telegram", command: "agents", assigneeAgentId: "liaison" },
    { companyId: "other-company", actor: { type: "user", companyId: f.companyId, userId: "founder" } }
  )).handled, false);
});

test("formats /tasks as separate Telegram blocks with readable Portuguese states", async () => {
  const f = fixture();
  f.ctx.issues.list = async () => [
    {
      identifier: "JOU-38",
      title: "Execution Reliability v1 — serialização, dedup de wakes e retomada segura",
      status: "blocked",
    },
    {
      identifier: "JOU-53",
      title: "Definir a experiência de primeiro valor para um novo usuário sem campanha",
      status: "in_review",
    },
    { identifier: "JOU-99", title: "Concluída", status: "done" },
  ];
  const result = await executeFounderCommand(f.ctx,
    { provider: "telegram", command: "tasks", assigneeAgentId: "liaison" },
    { companyId: f.companyId, actor: { type: "user", companyId: f.companyId, userId: "founder" } });
  assert.deepEqual(result, {
    handled: true,
    text: [
      "Tarefas abertas",
      "",
      "JOU-38 · Bloqueada",
      "Execution Reliability v1 — serialização, dedup de wakes e retomada segura",
      "",
      "JOU-53 · Em revisão",
      "Definir a experiência de primeiro valor para um novo usuário sem campanha",
    ].join("\n"),
  });
});

test("formats /agents and /help as multiline Telegram replies", async () => {
  const f = fixture();
  const invoke = async (command) => (await executeFounderCommand(f.ctx,
    { provider: "telegram", command, assigneeAgentId: "liaison" },
    { companyId: f.companyId, actor: { type: "user", companyId: f.companyId, userId: "founder" } })).text;

  assert.equal(await invoke("agents"), "Agentes do Paperclip\n\n• Founder Liaison\n  Estado: Ocioso");
  const help = await invoke("help");
  assert.match(help, /^Comandos do Founder Gateway\n\n\/agents/);
  assert.match(help, /\/tasks — Listar tarefas abertas\n\/help — Exibir esta ajuda/);
  assert.match(help, /\n\nComandos nativos do Paperclip\n\n\/status/);
});

test("limits Telegram task replies without breaking records or allowing injected line breaks", async () => {
  const f = fixture();
  f.ctx.issues.list = async () => Array.from({ length: 50 }, (_, index) => ({
    identifier: "JOU-" + index,
    title: "Título extenso\n" + "x".repeat(1000),
    status: "blocked",
  }));
  const { text } = await executeFounderCommand(f.ctx,
    { provider: "telegram", command: "tasks", assigneeAgentId: "liaison" },
    { companyId: f.companyId, actor: { type: "user", companyId: f.companyId, userId: "founder" } });
  assert.ok(text.length <= 3600);
  assert.equal(text.split(" · Bloqueada\n").length - 1, 10);
  assert.match(text, /JOU-0 · Bloqueada\nTítulo extenso x+/);
  assert.doesNotMatch(text, /\nJOU-10 · Bloqueada/);
  assert.ok(text.endsWith("…"));
});

const pendingKey = (companyId) => ({ scopeKind: "company", scopeId: companyId, stateKey: "pending-publication-runs" });

test("one failed publication cannot block later pending runs", async () => {
  const f = fixture(async (commentId) => {
    if (commentId === "comment-broken") throw new Error("provider unavailable");
    return { state: "published" };
  });
  await startAlert(f);
  await processEvent(f.ctx, {
    companyId: f.companyId, eventId: "created-again",
    eventType: "approval.created", entityId: "approval",
  });
  finalComment(f, { id: "comment-broken", runId: "run-1" });
  finalComment(f, { id: "comment-healthy", runId: "run-2" });

  const key = pendingKey(f.companyId);
  const queue = await f.ctx.state.get(key);
  await f.ctx.state.set(key, queue.map((entry) => ({ ...entry, ready: true })));
  await reconcilePendingPublications(f.ctx, f.companyId, await companyConfig(f.ctx, f.companyId));

  assert.deepEqual(f.published.map((entry) => entry.commentId), ["comment-broken", "comment-healthy"]);
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].details.runId, "run-1");
  const remaining = await f.ctx.state.get(key);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].runId, "run-1");
  assert.equal(remaining[0].attempts, 1);
  assert.equal(remaining[0].terminal, false);
  assert.equal(remaining[0].lastFailure, "publication_attempt_failed");
});

test("permanently rejected publications are retained for review but never retried automatically", async () => {
  const f = fixture(async () => ({ state: "failed" }));
  await startAlert(f);
  finalComment(f);
  await assert.rejects(finish(f), /Chat publication rejected: failed/);
  const pending = (await f.ctx.state.get(pendingKey(f.companyId)))[0];
  assert.equal(pending.attempts, 1);
  assert.equal(pending.terminal, true);
  assert.equal(pending.lastFailure, "provider_rejected");

  for (let attempt = 0; attempt < 3; attempt++) {
    await reconcilePendingPublications(f.ctx, f.companyId, await companyConfig(f.ctx, f.companyId));
  }
  assert.equal(f.published.length, 1);
});

test("transient publication errors have a bounded retry budget persisted in plugin state", async () => {
  const f = fixture(async () => { throw new Error("transient transport error"); });
  await startAlert(f);
  finalComment(f);
  await assert.rejects(finish(f), /transient transport error/);
  for (let attempt = 0; attempt < 7; attempt++) {
    await reconcilePendingPublications(f.ctx, f.companyId, await companyConfig(f.ctx, f.companyId));
  }
  const pending = (await f.ctx.state.get(pendingKey(f.companyId)))[0];
  assert.equal(pending.attempts, 5);
  assert.equal(pending.terminal, true);
  assert.equal(pending.lastFailure, "publication_attempt_failed");
  assert.equal(f.published.length, 5);
  assert.equal(f.errors.filter((entry) => entry.message === "Founder publication reconciliation failed").length, 4);
  assert.equal(f.errors.filter((entry) => entry.message === "Founder comms event failed").length, 1);
});

test("an unconfigured Founder gate fails closed without a misleading restriction message", async () => {
  const f = fixture();
  const invoke = () => executeFounderCommand(f.ctx,
    { provider: "telegram", command: "agents", assigneeAgentId: "liaison" },
    { companyId: f.companyId, actor: { type: "user", companyId: f.companyId, userId: "other-user" } });
  f.ctx.config.get = async () => ({ founderUserId: "founder" });
  assert.deepEqual(await invoke(), { handled: false });
  f.ctx.config.get = async () => ({ liaisonAgentId: "liaison" });
  assert.deepEqual(await invoke(), { handled: false });
});
