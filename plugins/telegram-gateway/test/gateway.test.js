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
      "**Tarefas abertas**",
      "",
      "**JOU\\-38** · _Bloqueada_",
      "Execution Reliability v1 — serialização, dedup de wakes e retomada segura",
      "",
      "**JOU\\-53** · _Em revisão_",
      "Definir a experiência de primeiro valor para um novo usuário sem campanha",
    ].join("\n"),
  });
});

test("formats /agents and /help as multiline Telegram replies", async () => {
  const f = fixture();
  const invoke = async (command) => (await executeFounderCommand(f.ctx,
    { provider: "telegram", command, assigneeAgentId: "liaison" },
    { companyId: f.companyId, actor: { type: "user", companyId: f.companyId, userId: "founder" } })).text;

  assert.equal(await invoke("agents"), "**Agentes do Paperclip**\n\n• **Founder Liaison**\n  _Estado:_ Ocioso");
  const help = await invoke("help");
  assert.match(help, /^\*\*Comandos do Telegram Gateway\*\*\n\n`\/agents`/);
  assert.match(help, /`\/tasks` — Listar tarefas abertas\n`\/credits` — Ver créditos gastos no mês por grupo\n`\/help` — Exibir esta ajuda/);
  assert.match(help, /\n\n\*\*Comandos nativos do Paperclip\*\*\n\n`\/status`/);
});

test("formats /credits from native monthly spend and rolls descendants into CEO groups", async () => {
  const f = fixture();
  f.ctx.companies.get = async () => ({ id: f.companyId, spentMonthlyCents: 1050 });
  f.ctx.agents.list = async () => [
    { id: "ceo", name: "CEO", title: "CEO / Coordenação Geral", role: "ceo", reportsTo: null, spentMonthlyCents: 200 },
    { id: "cmo", name: "CMO", title: "CMO / Marketing & Growth", role: "cmo", reportsTo: "ceo", spentMonthlyCents: 300 },
    { id: "research", name: "Research", role: "researcher", reportsTo: "cmo", spentMonthlyCents: 150 },
    { id: "cto", name: "CTO", title: "CTO / Produto & Engenharia", role: "cto", reportsTo: "ceo", spentMonthlyCents: 250 },
    { id: "dev", name: "Dev", role: "engineer", reportsTo: "cto", spentMonthlyCents: 50 },
    { id: "canary", name: "Canary", role: "general", reportsTo: null, spentMonthlyCents: 50 },
  ];

  const result = await executeFounderCommand(f.ctx,
    { provider: "telegram", command: "credits", assigneeAgentId: "liaison" },
    { companyId: f.companyId, actor: { type: "user", companyId: f.companyId, userId: "founder" } });

  assert.deepEqual(result, {
    handled: true,
    text: [
      "**Créditos do mês**",
      "",
      "**Total reportado:** US$ 10,50",
      "",
      "**Por grupo**",
      "• **Não atribuído** — US$ 0,50",
      "• **CMO / Marketing & Growth · CMO** — US$ 4,50",
      "• **CTO / Produto & Engenharia · CTO** — US$ 3,00",
      "• **CEO / Coordenação Geral · CEO** — US$ 2,00",
      "• **Fora da hierarquia** — US$ 0,50",
      "",
      "_Valores usam o gasto mensal reportado pelo Paperclip; uso não precificado ou coberto por assinatura não entra no total._",
    ].join("\n"),
  });
});

test("/credits paginates beyond 1,000 agents without dropping spend", async () => {
  const f = fixture();
  const agents = Array.from({ length: 1001 }, (_, index) => ({
    id: `agent-${index}`,
    name: `Agent ${index}`,
    role: "general",
    reportsTo: null,
    spentMonthlyCents: 1,
  }));
  f.ctx.companies.get = async () => ({ id: f.companyId, spentMonthlyCents: 1001 });
  f.ctx.agents.list = async ({ limit, offset }) => agents.slice(offset, offset + limit);

  const result = await executeFounderCommand(f.ctx,
    { provider: "telegram", command: "credits", assigneeAgentId: "liaison" },
    { companyId: f.companyId, actor: { type: "user", companyId: f.companyId, userId: "founder" } });

  assert.match(result.text, /\*\*Total reportado:\*\* US\$ 10,01/);
  assert.match(result.text, /Fora da hierarquia\*\* — US\$ 10,01/);
});

test("/credits truncates only at complete group boundaries", async () => {
  const f = fixture();
  const ceo = {
    id: "ceo", name: "CEO", title: "CEO / Coordenação Geral", role: "ceo",
    reportsTo: null, spentMonthlyCents: 1,
  };
  const leaders = Array.from({ length: 80 }, (_, index) => ({
    id: `leader-${index}`,
    name: `Leader ${index}`,
    title: `Grupo ${index} ${"x".repeat(100)}`,
    role: "general",
    reportsTo: "ceo",
    spentMonthlyCents: 1,
  }));
  f.ctx.companies.get = async () => ({ id: f.companyId, spentMonthlyCents: 81 });
  f.ctx.agents.list = async ({ limit, offset }) => [ceo, ...leaders].slice(offset, offset + limit);

  const result = await executeFounderCommand(f.ctx,
    { provider: "telegram", command: "credits", assigneeAgentId: "liaison" },
    { companyId: f.companyId, actor: { type: "user", companyId: f.companyId, userId: "founder" } });

  assert.ok(result.text.length <= 3600);
  assert.match(result.text, /_Exibindo \d+ de 81 grupos; \d+ omitidos por limite de mensagem\._/);
  assert.match(result.text, /uso não precificado ou coberto por assinatura não entra no total\._$/);
  const boldMarkers = result.text.match(/\*\*/g) ?? [];
  assert.equal(boldMarkers.length % 2, 0, "must not cut a bold group record in half");
});

test("/credits keeps unassigned spend visible when group rows are capped", async () => {
  const f = fixture();
  const ceo = {
    id: "ceo", name: "CEO", title: "CEO / Coordenação Geral", role: "ceo",
    reportsTo: null, spentMonthlyCents: 1,
  };
  const leaders = Array.from({ length: 80 }, (_, index) => ({
    id: `leader-${index}`,
    name: `Leader ${index}`,
    title: `Grupo ${index} ${"x".repeat(100)}`,
    role: "general",
    reportsTo: "ceo",
    spentMonthlyCents: 1,
  }));
  f.ctx.companies.get = async () => ({ id: f.companyId, spentMonthlyCents: 181 });
  f.ctx.agents.list = async ({ limit, offset }) => [ceo, ...leaders].slice(offset, offset + limit);

  const result = await executeFounderCommand(f.ctx,
    { provider: "telegram", command: "credits", assigneeAgentId: "liaison" },
    { companyId: f.companyId, actor: { type: "user", companyId: f.companyId, userId: "founder" } });

  assert.ok(result.text.length <= 3600);
  assert.match(result.text, /• \*\*Não atribuído\*\* — US\$ 1,00/);
  assert.match(result.text, /_Exibindo \d+ de 81 grupos; \d+ omitidos por limite de mensagem\._/);
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
  assert.equal(text.split(" · _Bloqueada_\n").length - 1, 10);
  assert.match(text, /\*\*JOU\\-0\*\* · _Bloqueada_\nTítulo extenso x+/);
  assert.doesNotMatch(text, /JOU\\-10\*\* · _Bloqueada_/);
  assert.ok(text.endsWith("…"));
});


test("escapes untrusted names, task titles and IDs before native Telegram Markdown parsing", async () => {
  const f = fixture();
  f.ctx.agents.list = async () => [{
    name: "Agent [click](https://host.invalid) *owner*",
    status: "idle",
  }];
  f.ctx.issues.list = async () => [{
    identifier: "JOU-42",
    title: "Review [click](https://host.invalid) *owner* and `code`",
    status: "in_review",
  }];
  const invoke = async (command) => (await executeFounderCommand(f.ctx,
    { provider: "telegram", command, assigneeAgentId: "liaison" },
    { companyId: f.companyId, actor: { type: "user", companyId: f.companyId, userId: "founder" } })).text;

  const agents = await invoke("agents");
  assert.ok(agents.startsWith("**Agentes do Paperclip**"));
  assert.ok(agents.includes(String.raw`Agent \[click\]\(https:`));
  assert.ok(agents.includes("\u200b"));
  assert.equal(agents.includes("[click](https://host.invalid)"), false);

  const tasks = await invoke("tasks");
  assert.ok(tasks.includes(String.raw`**JOU\-42** · _Em revisão_`));
  assert.ok(tasks.includes(String.raw`Review \[click\]\(https:`));
  assert.ok(tasks.includes(String.raw`\*owner\* and \`code\``));
  assert.ok(tasks.includes("\u200b"));
  assert.equal(tasks.includes("[click](https://host.invalid)"), false);
});

test("never slices Markdown in the middle of a task and stays under Telegram's text limit", async () => {
  const f = fixture();
  f.ctx.issues.list = async () => Array.from({ length: 16 }, (_, i) => ({
    identifier: "JOU-" + i,
    title: "*".repeat(400),
    status: "blocked",
  }));
  const { text } = await executeFounderCommand(f.ctx,
    { provider: "telegram", command: "tasks", assigneeAgentId: "liaison" },
    { companyId: f.companyId, actor: { type: "user", companyId: f.companyId, userId: "founder" } });
  assert.ok(text.length <= 3600);
  assert.ok(text.startsWith("**Tarefas abertas**"));
  assert.match(text, /_Exibindo [1-9] de 10 registros\._$/);
  assert.ok(!text.endsWith("\\"));
  assert.equal((text.match(/ · _Bloqueada_/g) ?? []).length, (text.match(/\*\*JOU/g) ?? []).length);
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
