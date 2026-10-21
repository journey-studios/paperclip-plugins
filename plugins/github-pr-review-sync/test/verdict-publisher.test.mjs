import test from "node:test";
import assert from "node:assert/strict";
import { resolveReviewBotToken } from "../src/config.js";
import { INTAKE_ORIGIN_KIND } from "../src/verdict.js";
import { handleVerdictComment, processVerdictComment, retryFailedVerdicts } from "../src/verdict-publisher.js";

const COMPANY = "company-a";
const ISSUE = "issue-1";
const THERMO = "agent-thermo";
const SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

const header = (authority = "approve") =>
  `<!-- paperclip-pr-intake {"v":1,"repo":"o/r","number":5,"headSha":"${SHA}","authority":"${authority}","round":1} -->\n# Review`;
const verdictBody = (overrides = {}) =>
  `Done.\n<!-- paperclip-review-verdict\n${JSON.stringify({ v: 1, repo: "o/r", number: 5, headSha: SHA, outcome: "approve", summary: "Fine.", findings: [], ...overrides })}\n-->`;

function fixture({ authority = "approve", comment = {}, issue = {}, pull = {}, botLogin = "review-bot", token = "tok", submit } = {}) {
  const posted = [];
  const notes = [];
  const receipts = new Map();
  const issueRecord = {
    id: ISSUE,
    companyId: COMPANY,
    originKind: INTAKE_ORIGIN_KIND,
    originId: "o/r#5",
    assigneeAgentId: THERMO,
    status: "in_progress",
    identifier: "JOU-700",
    description: header(authority),
    ...issue,
  };
  const comments = [
    { id: "internal", authorAgentId: "agent-cto", body: "INTERNAL-SECRET: do not leak" },
    { id: "c1", authorAgentId: THERMO, body: verdictBody(), ...comment },
  ];
  const ctx = {
    issues: {
      get: async () => structuredClone(issueRecord),
      listComments: async () => comments,
      createComment: async (_id, body) => { notes.push(body); },
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  const deps = {
    resolveToken: async () => token,
    publicOrigin: async () => null,
    fetchPull: async () => ({ state: "open", head: { sha: SHA }, user: { login: "wallynm" }, ...pull }),
    fetchLogin: async () => botLogin,
    submitReview: submit ?? (async (_ctx, input) => { posted.push(input); return { id: "900", url: "https://github.com/o/r/pull/5#pullrequestreview-900" }; }),
    getReceipt: async (_ctx, key) => receipts.get(key) ?? null,
    upsertReceipt: async (_ctx, row) => { receipts.set(row.receiptKey, { ...row, status: row.status, github_review_id: row.githubReviewId }); },
    listRetryableReceipts: async () =>
      [...receipts.values()].filter((r) => r.status === "failed").map((r) => ({ receipt_key: r.receiptKey, company_id: r.companyId, issue_id: r.issueId, decision_id: r.decisionId })),
  };
  const run = (commentId = "c1") => processVerdictComment(ctx, { companyId: COMPANY, issueId: ISSUE, commentId }, deps);
  return { ctx, deps, posted, notes, receipts, run, comments };
}

test("an approve verdict from the assigned reviewer is published with a receipt", async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.status, "published");
  assert.equal(f.posted.length, 1);
  assert.equal(f.posted[0].event, "APPROVE");
  assert.equal(f.posted[0].headSha, SHA);
  assert.equal(f.posted[0].owner, "o");
  assert.equal(f.posted[0].number, 5);
  assert.match(f.posted[0].marker, /paperclip-github-pr-review-sync/);
  assert.equal([...f.receipts.values()][0].status, "published");
  assert.match(f.notes.at(-1), /pullrequestreview-900/);
});

test("the public review never contains the issue's internal comments", async () => {
  const f = fixture();
  await f.run();
  assert.doesNotMatch(f.posted[0].body, /INTERNAL-SECRET/);
  assert.match(f.posted[0].body, /Fine\./);
});

test("only the assigned reviewer's comment counts", async () => {
  const f = fixture({ comment: { authorAgentId: "agent-someone-else" } });
  assert.equal((await f.run()).skipped, "not_from_reviewer");
  const g = fixture({ comment: { authorAgentId: null } });
  assert.equal((await g.run()).skipped, "not_from_reviewer");
  assert.equal(f.posted.length + g.posted.length, 0);
});

test("issues that were not created by the intake plugin are left to the native flow", async () => {
  const f = fixture({ issue: { originKind: "manual" } });
  assert.equal((await f.run()).skipped, "not_intake_issue");
  assert.equal(f.posted.length, 0);
});

test("comments without a verdict are ignored, malformed ones are reported", async () => {
  const none = fixture({ comment: { body: "Working on it." } });
  assert.equal((await none.run()).skipped, "no_verdict");
  assert.equal(none.notes.length, 0);

  const bad = fixture({ comment: { body: verdictBody({ headSha: "short" }) } });
  assert.equal((await bad.run()).rejected, "invalid_head_sha");
  assert.match(bad.notes[0], /rejected/);
  assert.equal(bad.posted.length, 0);
});

test("a verdict for another PR than the issue's is rejected", async () => {
  const f = fixture({ comment: { body: verdictBody({ number: 6 }) } });
  assert.equal((await f.run()).rejected, "verdict_mismatch");
  const g = fixture({ comment: { body: verdictBody({ repo: "evil/repo" }) } });
  assert.equal((await g.run()).rejected, "verdict_mismatch");
  assert.equal(f.posted.length + g.posted.length, 0);
});

test("the PR comes from the issue origin, never from URLs in the thread", async () => {
  const f = fixture({ comment: { body: `See https://github.com/victim/repo/pull/99\n${verdictBody()}` } });
  await f.run();
  assert.equal(f.posted.length, 1);
  assert.equal(`${f.posted[0].owner}/${f.posted[0].repo}#${f.posted[0].number}`, "o/r#5");
});

test("a verdict for an old head SHA is not published", async () => {
  const f = fixture({ pull: { head: { sha: NEW_SHA } } });
  assert.equal((await f.run()).status, "skipped_stale");
  assert.equal(f.posted.length, 0);
  assert.equal([...f.receipts.values()][0].errorCode, "stale_verdict");
  assert.match(f.notes[0], /review the new head/);
});

test("a closed PR is not reviewed", async () => {
  const f = fixture({ pull: { state: "closed" } });
  assert.equal((await f.run()).status, "skipped_stale");
  assert.equal(f.posted.length, 0);
});

test("authority caps the published event and blockers prevent approval", async () => {
  const capped = fixture({ authority: "comment" });
  await capped.run();
  assert.equal(capped.posted[0].event, "COMMENT");
  assert.match(capped.posted[0].body, /exceeds the authority/);

  const mid = fixture({ authority: "request_changes" });
  await mid.run();
  assert.equal(mid.posted[0].event, "REQUEST_CHANGES");

  const blocker = fixture({ comment: { body: verdictBody({ findings: [{ severity: "blocker", path: "a.ts", line: 1, message: "Crash." }] }) } });
  await blocker.run();
  assert.equal(blocker.posted[0].event, "REQUEST_CHANGES");
  assert.match(blocker.posted[0].body, /Approval withheld/);
});

test("the bot cannot approve or request changes on its own PR, but may comment", async () => {
  const self = fixture({ botLogin: "wallynm" });
  assert.equal((await self.run()).status, "pending_identity");
  assert.equal(self.posted.length, 0);
  assert.match(self.notes[0], /bot is the pull request author/);

  const comment = fixture({ botLogin: "wallynm", comment: { body: verdictBody({ outcome: "comment" }) } });
  assert.equal((await comment.run()).status, "published");
  assert.equal(comment.posted[0].event, "COMMENT");
});

test("publishing is idempotent per verdict comment", async () => {
  const f = fixture();
  await f.run();
  assert.equal((await f.run()).status, "already_published");
  assert.equal(f.posted.length, 1);
});

test("a missing token publishes nothing and says why", async () => {
  const f = fixture({ token: null });
  assert.equal((await f.run()).skipped, "missing_token");
  assert.equal(f.posted.length, 0);
  assert.match(f.notes[0], /token is not configured/);
});

test("a transient GitHub failure is recorded and retried later", async () => {
  let attempts = 0;
  const f = fixture({
    submit: async (_ctx, input) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("502 Bad Gateway"), { status: 502 });
      return { id: "901", url: "https://github.com/o/r/pull/5#pullrequestreview-901" };
    },
  });
  assert.equal((await f.run()).status, "failed");
  assert.equal([...f.receipts.values()][0].status, "failed");

  const retried = await retryFailedVerdicts(f.ctx, f.deps);
  assert.equal(retried[0].status, "published");
  assert.equal([...f.receipts.values()][0].status, "published");
  assert.equal(attempts, 2);
});

test("handleVerdictComment needs the event ids", async () => {
  const f = fixture();
  assert.equal((await handleVerdictComment(f.ctx, { entityId: ISSUE, companyId: COMPANY, payload: {} }, f.deps)).skipped, "no_ids");
  const ok = await handleVerdictComment(f.ctx, { entityId: ISSUE, companyId: COMPANY, payload: { commentId: "c1" } }, f.deps);
  assert.equal(ok.status, "published");
});

test("a configured token reference that resolves to nothing fails closed instead of using the environment", async () => {
  const previous = process.env.GITHUB_REVIEW_BOT_TOKEN;
  process.env.GITHUB_REVIEW_BOT_TOKEN = "from-env";
  try {
    const ref = { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000009" };
    const empty = { config: { get: async () => ({ reviewBotTokenRef: ref }) }, secrets: { resolve: async () => "  " } };
    assert.equal(await resolveReviewBotToken(empty, COMPANY), null);
    const none = { config: { get: async () => ({}) }, secrets: { resolve: async () => "" } };
    assert.equal(await resolveReviewBotToken(none, COMPANY), "from-env", "without a reference the environment still works");
  } finally {
    if (previous === undefined) delete process.env.GITHUB_REVIEW_BOT_TOKEN;
    else process.env.GITHUB_REVIEW_BOT_TOKEN = previous;
  }
});
