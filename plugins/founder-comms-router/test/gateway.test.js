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
    logger: { error() {} },
  };
  return { ctx, issue, comments, wakes, published, companyId };
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
