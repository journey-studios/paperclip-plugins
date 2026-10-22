import test from "node:test";
import assert from "node:assert/strict";
import { INTAKE_ORIGIN_KIND } from "../src/verdict.js";
import { MAX_REPAIRS, REPAIR_SETTLE_MS, REPAIR_WINDOW_MS, requestRepair, runRepairs } from "../src/verdict-repair.js";

const COMPANY = "company-a";
const ISSUE = "issue-1";
const THERMO = "agent-thermo";
const T0 = Date.parse("2026-10-22T12:00:00Z");
const AFTER_SETTLE = T0 + REPAIR_SETTLE_MS + 1;

const verdictText = '<!-- paperclip-review-verdict\n{"v":1}\n-->';

/** State and issues behave like the host: a scope that is not an object makes the call throw. */
function fixture({ issue = {}, pull = {}, token = "tok", extraComments = [], wakeResults = [{ queued: true }] } = {}) {
  const store = new Map();
  const calls = { update: [], comment: [], wake: [] };
  const issueRecord = {
    id: ISSUE,
    companyId: COMPANY,
    originKind: INTAKE_ORIGIN_KIND,
    originId: "o/r#5",
    assigneeAgentId: THERMO,
    status: "done",
    ...issue,
  };
  const comments = [
    { id: "c1", authorAgentId: THERMO, body: verdictText, createdAt: new Date(T0).toISOString() },
    ...extraComments,
  ];
  const keyOf = (scope) => {
    if (!scope || typeof scope !== "object" || !scope.scopeKind || !scope.stateKey) throw new Error("state scope must be an object");
    return `${scope.scopeKind}:${scope.namespace}:${scope.stateKey}`;
  };
  const wakes = [...wakeResults];
  const ctx = {
    state: {
      get: async (scope) => structuredClone(store.get(keyOf(scope)) ?? null),
      set: async (scope, value) => { store.set(keyOf(scope), structuredClone(value)); },
    },
    issues: {
      get: async () => structuredClone(issueRecord),
      listComments: async () => comments,
      update: async (id, patch, companyId) => { calls.update.push({ id, patch, companyId }); issueRecord.status = patch.status; },
      createComment: async (id, body, companyId) => { calls.comment.push({ id, body, companyId }); },
      requestWakeup: async (id, companyId, options) => {
        calls.wake.push({ id, companyId, options });
        const next = wakes.length > 1 ? wakes.shift() : wakes[0];
        if (next instanceof Error) throw next;
        return next;
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  const deps = {
    resolveToken: async () => token,
    fetchPull: async () => ({ state: "open", head: { sha: "a".repeat(40) }, ...pull }),
  };
  const request = (error = "invalid_json", now = T0) => requestRepair(ctx, { companyId: COMPANY, issueId: ISSUE, commentId: "c1", error }, now);
  const run = (now = AFTER_SETTLE) => runRepairs(ctx, deps, now);
  return { ctx, deps, calls, store, issueRecord, comments, request, run };
}

test("only a broken block is queued for correction, not a block for another pull request", async () => {
  const f = fixture();
  assert.deepEqual(await f.request("invalid_json"), { queued: true });
  assert.deepEqual(await f.request("verdict_mismatch"), { queued: false, reason: "not_repairable" });
  assert.deepEqual(await f.request("no_verdict"), { queued: false, reason: "not_repairable" });
});

test("a finished review issue is reopened, told what to fix and its reviewer is woken", async () => {
  const f = fixture();
  await f.request("invalid_json");
  const [result] = await f.run();
  assert.deepEqual(result, { issueId: ISSUE, repaired: true });
  assert.deepEqual(f.calls.update, [{ id: ISSUE, patch: { status: "todo" }, companyId: COMPANY }]);
  assert.equal(f.calls.comment.length, 1);
  assert.match(f.calls.comment[0].body, /not valid JSON/);
  assert.match(f.calls.comment[0].body, /single line/);
  assert.match(f.calls.comment[0].body, /correction 1 of 2/);
  assert.equal(f.calls.wake.length, 1);
  assert.equal(f.calls.wake[0].options.idempotencyKey, `verdict-repair:${ISSUE}:c1`);
  assert.equal(f.calls.wake[0].options.reason, "github_pr_review_requested");
  assert.deepEqual(await f.run(), [], "the issue is no longer pending");
});

test("an issue that is still open keeps its status", async () => {
  const f = fixture({ issue: { status: "in_progress" } });
  await f.request();
  await f.run();
  assert.equal(f.calls.update.length, 0);
  assert.equal(f.calls.comment.length, 1);
  assert.equal(f.calls.wake.length, 1);
});

test("the reviewer's run gets time to finish before the issue is reopened", async () => {
  const f = fixture();
  await f.request();
  assert.deepEqual(await f.run(T0 + 5_000), [{ issueId: ISSUE, waiting: "settling" }]);
  assert.equal(f.calls.update.length + f.calls.comment.length + f.calls.wake.length, 0);
  assert.equal((await f.run(AFTER_SETTLE))[0].repaired, true);
});

test("nothing is asked when the pull request is closed, the issue cancelled or the reviewer already answered", async () => {
  const closed = fixture({ pull: { state: "closed" } });
  await closed.request();
  assert.deepEqual(await closed.run(), [{ issueId: ISSUE, dropped: "pr_not_open" }]);

  const cancelled = fixture({ issue: { status: "cancelled" } });
  await cancelled.request();
  assert.deepEqual(await cancelled.run(), [{ issueId: ISSUE, dropped: "issue_cancelled" }]);

  const answered = fixture({
    extraComments: [{ id: "c2", authorAgentId: THERMO, body: verdictText, createdAt: new Date(T0 + 10_000).toISOString() }],
  });
  await answered.request();
  assert.deepEqual(await answered.run(), [{ issueId: ISSUE, dropped: "already_answered" }]);

  for (const f of [closed, cancelled, answered]) {
    assert.equal(f.calls.update.length + f.calls.comment.length + f.calls.wake.length, 0);
  }
});

test("another agent's block, or a comment before the rejected one, does not count as an answer", async () => {
  const f = fixture({
    extraComments: [
      { id: "c0", authorAgentId: THERMO, body: verdictText, createdAt: new Date(T0 - 10_000).toISOString() },
      { id: "c2", authorAgentId: "agent-other", body: verdictText, createdAt: new Date(T0 + 10_000).toISOString() },
    ],
  });
  await f.request();
  assert.equal((await f.run())[0].repaired, true);
});

test("a request that is too old is dropped", async () => {
  const f = fixture();
  await f.request();
  assert.deepEqual(await f.run(T0 + REPAIR_WINDOW_MS + 1), [{ issueId: ISSUE, dropped: "expired" }]);
});

test("a missing token keeps the request for the next run", async () => {
  const f = fixture({ token: null });
  await f.request();
  assert.deepEqual(await f.run(), [{ issueId: ISSUE, waiting: "missing_token" }]);
  assert.equal(f.calls.comment.length, 0);
  f.deps.resolveToken = async () => "tok";
  assert.equal((await f.run())[0].repaired, true);
});

test("a failed wakeup is retried without repeating the comment, then given up", async () => {
  const f = fixture({ wakeResults: [{ queued: false }] });
  await f.request();
  assert.deepEqual(await f.run(), [{ issueId: ISSUE, waiting: "wake_retry" }]);
  assert.deepEqual(await f.run(), [{ issueId: ISSUE, waiting: "wake_retry" }]);
  assert.deepEqual(await f.run(), [{ issueId: ISSUE, repaired: true }]);
  assert.equal(f.calls.comment.length, 1);
  assert.equal(f.calls.update.length, 1);
  assert.equal(f.calls.wake.length, 3);
});

test("a wakeup that throws is treated like one that was not queued", async () => {
  const f = fixture({ wakeResults: [new Error("host down"), { queued: true }] });
  await f.request();
  assert.deepEqual(await f.run(), [{ issueId: ISSUE, waiting: "wake_retry" }]);
  assert.deepEqual(await f.run(), [{ issueId: ISSUE, repaired: true }]);
  assert.equal(f.calls.comment.length, 1);
});

test("a host error leaves the request pending for the next run", async () => {
  const f = fixture();
  await f.request();
  f.ctx.issues.update = async () => { throw new Error("503"); };
  assert.deepEqual(await f.run(), [{ issueId: ISSUE, failed: true }]);
  f.ctx.issues.update = async (id, patch, companyId) => { f.calls.update.push({ id, patch, companyId }); };
  assert.equal((await f.run())[0].repaired, true);
});

test("the reviewer is asked to correct a block at most MAX_REPAIRS times per issue", async () => {
  const f = fixture();
  for (let attempt = 1; attempt <= MAX_REPAIRS; attempt += 1) {
    assert.deepEqual(await f.request(), { queued: true });
    assert.equal((await f.run())[0].repaired, true);
  }
  assert.deepEqual(await f.request(), { queued: false, reason: "limit_reached" });
  assert.deepEqual(await f.run(), []);
  assert.equal(f.calls.comment.length, MAX_REPAIRS);
  assert.match(f.calls.comment[1].body, /correction 2 of 2/);
});

test("a field error names the format to follow instead of the JSON advice", async () => {
  const f = fixture();
  await f.request("invalid_head_sha");
  await f.run();
  assert.match(f.calls.comment[0].body, /verdict format from the issue description/);
  assert.doesNotMatch(f.calls.comment[0].body, /not valid JSON/);
});
