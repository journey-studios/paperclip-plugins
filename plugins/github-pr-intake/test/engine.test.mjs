import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ORIGIN_KIND } from "../src/constants.js";
import { handleWebhook } from "../src/webhook.js";
import { COMPANY, THERMO, CEO, WEBHOOK_SECRET, fixture, pullEvent, rawPull, repoConfig } from "./helpers.mjs";

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const SHA3 = "3".repeat(40);
const SHA4 = "4".repeat(40);

test("a new PR creates one review issue for the default reviewer and wakes it once", async () => {
  const f = fixture();
  const result = await f.open(rawPull({ number: 5, sha: SHA1 }));
  assert.equal(result.status, "queued");

  assert.equal(f.issues.length, 1);
  const [issue] = f.issues;
  assert.equal(issue.assigneeAgentId, THERMO);
  assert.equal(issue.companyId, COMPANY);
  assert.equal(issue.projectId, "project-1");
  assert.equal(issue.originKind, ORIGIN_KIND);
  assert.equal(issue.originId, "wallynm/tesselapp#5");
  assert.equal(issue.status, "todo");
  assert.match(issue.title, /^Review wallynm\/tesselapp#5: Add feature$/);
  assert.match(issue.description, new RegExp(`"headSha":"${SHA1}"`));
  assert.match(issue.description, /"authority":"approve"/);

  assert.equal(f.wakes.length, 1);
  assert.equal(f.wakes[0].issueId, issue.id);
  assert.equal(f.wakes[0].idempotencyKey, `pr-intake:wallynm/tesselapp#5@${SHA1}#r1`);
});

test("a replayed delivery or an already requested SHA never creates a second review", async () => {
  const f = fixture();
  const raw = rawPull({ number: 5, sha: SHA1 });
  f.setPull(raw);
  const event = pullEvent("opened", raw, "delivery-1");
  assert.equal((await f.engine.onPullEvent(event)).status, "queued");
  assert.equal((await f.engine.onPullEvent(event)).status, "duplicate");
  await f.engine.processDue();

  // GitHub re-sends the same head under a new delivery id (for example "edited").
  await f.engine.onPullEvent(pullEvent("reopened", raw, "delivery-2"));
  await f.engine.processDue();
  assert.equal(f.issues.length, 1);
  assert.equal(f.wakes.length, 1);
});

test("pushes are debounced into one re-review on the same issue", async () => {
  const f = fixture();
  await f.open(rawPull({ number: 5, sha: SHA1 }));

  for (const sha of [SHA2, SHA3]) {
    const raw = rawPull({ number: 5, sha });
    f.setPull(raw);
    await f.engine.onPullEvent(pullEvent("synchronize", raw));
    f.advance(10_000);
  }
  await f.engine.processDue();
  assert.equal(f.wakes.length, 1, "nothing happens before the debounce window ends");

  f.advance(61_000);
  await f.engine.processDue();
  assert.equal(f.issues.length, 1, "the same issue keeps the conversation");
  assert.equal(f.wakes.length, 2);
  assert.equal(f.wakes[1].idempotencyKey, `pr-intake:wallynm/tesselapp#5@${SHA3}#r2`, "reviews the latest head only");
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /Review round 2 of 3/);
});

test("drafts wait for ready_for_review", async () => {
  const f = fixture();
  assert.equal((await f.open(rawPull({ number: 8, sha: SHA1, draft: true }))).reason, "draft");
  assert.equal(f.issues.length, 0);

  const ready = rawPull({ number: 8, sha: SHA1, draft: false });
  await f.open(ready, "ready_for_review");
  assert.equal(f.issues.length, 1);
});

test("closing or converting to draft cancels the open review", async () => {
  const f = fixture();
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  const closed = { ...rawPull({ number: 5, sha: SHA1 }), state: "closed" };
  assert.equal((await f.engine.onPullEvent(pullEvent("closed", closed))).status, "cancelled");
  assert.equal(f.issues[0].status, "cancelled");
  assert.match(f.comments.at(-1).body, /closed/);

  await f.open(rawPull({ number: 6, sha: SHA1 }));
  await f.engine.onPullEvent(pullEvent("converted_to_draft", rawPull({ number: 6, sha: SHA1, draft: true })));
  assert.equal(f.issues[1].status, "cancelled");
});

test("a review cancelled by draft or close is requested again when the same head comes back", async () => {
  const f = fixture();
  const raw = rawPull({ number: 5, sha: SHA1 });
  await f.open(raw);
  await f.engine.onPullEvent(pullEvent("converted_to_draft", { ...raw, draft: true }));
  assert.equal(f.issues[0].status, "cancelled");

  await f.open(raw, "ready_for_review");
  assert.equal(f.issues.length, 2, "ready_for_review at the same commit starts a new review");
  assert.equal(f.wakes.at(-1).issueId, f.issues[1].id);
  assert.equal(f.wakes.at(-1).idempotencyKey, `pr-intake:wallynm/tesselapp#5@${SHA1}#r2`, "a new round is a new wake request");

  await f.engine.onPullEvent(pullEvent("closed", { ...raw, state: "closed" }));
  assert.equal(f.issues[1].status, "cancelled");
  await f.open(raw, "reopened");
  assert.equal(f.issues.length, 3, "reopening at the same commit starts a new review");
});

test("a review that already finished is not repeated when the PR is reopened at the same head", async () => {
  const f = fixture();
  const raw = rawPull({ number: 5, sha: SHA1 });
  await f.open(raw);
  f.issues[0].status = "done";
  await f.engine.onPullEvent(pullEvent("closed", { ...raw, state: "closed" }));
  await f.open(raw, "reopened");
  assert.equal(f.issues.length, 1);
  assert.equal(f.wakes.length, 1);
});

test("a finished issue gets a fresh review issue on the next push", async () => {
  const f = fixture();
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  f.issues[0].status = "done";
  const raw = rawPull({ number: 5, sha: SHA2 });
  f.setPull(raw);
  await f.engine.onPullEvent(pullEvent("synchronize", raw));
  f.advance(61_000);
  await f.engine.processDue();
  assert.equal(f.issues.length, 2);
  assert.equal(f.issues[1].originId, "wallynm/tesselapp#5");
});

test("the round limit stops automatic reviews and says so once", async () => {
  const f = fixture({ config: { repositories: [repoConfig({ maxRoundsPerPr: 2, debounceSeconds: 0 })] } });
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  for (const sha of [SHA2, SHA3, SHA4]) {
    const raw = rawPull({ number: 5, sha });
    f.setPull(raw);
    await f.engine.onPullEvent(pullEvent("synchronize", raw));
    await f.engine.processDue();
  }
  assert.equal(f.wakes.length, 2, "two rounds were requested, the rest were refused");
  assert.equal(f.comments.filter((c) => /Review limit reached/.test(c.body)).length, 1);
});

test("capacity limits open review issues and resumes when one finishes", async () => {
  const f = fixture({ config: { maxConcurrentReviews: 1 } });
  await f.open(rawPull({ number: 1, sha: SHA1 }));
  await f.open(rawPull({ number: 2, sha: SHA2 }));
  assert.equal(f.issues.length, 1, "the second PR waits for a free slot");

  f.issues[0].status = "done";
  f.advance(61_000);
  await f.engine.processDue();
  assert.equal(f.issues.length, 2);
});

test("the capacity cap also applies when the PR's previous review issue already finished", async () => {
  const f = fixture({ config: { maxConcurrentReviews: 1, repositories: [repoConfig({ debounceSeconds: 0 })] } });
  await f.open(rawPull({ number: 1, sha: SHA1 }));
  f.issues[0].status = "done";
  await f.open(rawPull({ number: 2, sha: SHA2 }));
  assert.equal(f.issues.length, 2, "PR 2 takes the only slot");

  // PR 1 gets a new commit: its old issue is finished, but the cap is full.
  const next = rawPull({ number: 1, sha: SHA3 });
  f.setPull(next);
  await f.engine.onPullEvent(pullEvent("synchronize", next));
  await f.engine.processDue();
  assert.equal(f.issues.length, 2, "no third issue while the cap is reached");

  f.issues[1].status = "done";
  f.advance(61_000);
  await f.engine.processDue();
  assert.equal(f.issues.length, 3, "it proceeds once a slot frees up");
});

test("reconcile does not requeue a PR that was refused or skipped at the same head", async () => {
  const f = fixture({ config: { repositories: [repoConfig({ maxRoundsPerPr: 1, debounceSeconds: 0 })] } });
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  const raw = rawPull({ number: 5, sha: SHA2 });
  f.setPull(raw);
  await f.engine.onPullEvent(pullEvent("synchronize", raw));
  await f.engine.processDue(); // round 2 > limit: refused
  assert.equal(f.wakes.length, 1);

  f.setListing({ notModified: false, etag: "e5", pulls: [raw] });
  const before = f.calls.getPull;
  const summary = await f.engine.reconcile();
  assert.equal(summary.enqueued, 0);
  assert.equal(f.calls.getPull, before, "no GitHub round trip for a head that was already handled");

  // A real new commit is picked up again.
  const newer = rawPull({ number: 5, sha: SHA3 });
  f.setPull(newer);
  f.setListing({ notModified: false, etag: "e6", pulls: [newer] });
  assert.equal((await f.engine.reconcile()).enqueued, 1);

  // Same for a PR skipped after the file check.
  const docs = fixture({ config: { repositories: [repoConfig({ ignorePaths: ["docs/**"], debounceSeconds: 0 })] } });
  docs.setFiles(7, [{ filename: "docs/a.md", status: "modified", additions: 1, deletions: 0 }]);
  const docsPull = rawPull({ number: 7, sha: SHA1 });
  docs.setPull(docsPull);
  docs.setListing({ notModified: false, etag: "d1", pulls: [docsPull] });
  assert.equal((await docs.engine.reconcile()).enqueued, 1, "first sight: fetched and skipped");
  docs.setListing({ notModified: false, etag: "d2", pulls: [docsPull] });
  assert.equal((await docs.engine.reconcile()).enqueued, 0, "second time: ignored");
});

test("a rule routes by changed path; unmatched PRs go to the default reviewer", async () => {
  const rules = [{ reviewerAgentId: CEO, paths: ["packages/billing/**"] }];
  const f = fixture({ config: { repositories: [repoConfig({ rules })] } });
  f.setFiles(1, [{ filename: "packages/billing/a.ts", status: "modified", additions: 1, deletions: 0 }]);
  await f.open(rawPull({ number: 1, sha: SHA1 }));
  await f.open(rawPull({ number: 2, sha: SHA2 }));
  assert.equal(f.issues[0].assigneeAgentId, CEO);
  assert.equal(f.issues[1].assigneeAgentId, THERMO);
});

test("a failed wakeup is retried by the reconcile job and then cleared", async () => {
  const f = fixture({ wakeQueued: false });
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  assert.equal(f.wakes.length, 1);
  assert.equal((await f.engine.retryWakeups()), 1);
  assert.equal(f.wakes.length, 2);
  assert.equal(f.wakes[1].idempotencyKey, f.wakes[0].idempotencyKey, "the retry is idempotent");
});

test("after a crash the existing issue is reused instead of duplicated", async () => {
  const f = fixture();
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  // Simulate losing the plugin state while the issue still exists.
  f.state.clear();
  const raw = rawPull({ number: 5, sha: SHA2 });
  f.setPull(raw);
  await f.engine.onPullEvent(pullEvent("synchronize", raw));
  f.advance(61_000);
  await f.engine.processDue();
  assert.equal(f.issues.length, 1);
  assert.equal(f.wakes.length, 2);
});

test("repositories that are not configured, and the kill switch, are ignored", async () => {
  const f = fixture();
  const other = await f.engine.onPullEvent(pullEvent("opened", rawPull(), "x", "someone/else"));
  assert.deepEqual([other.status, other.reason], ["ignored", "repo_not_configured"]);

  const off = fixture({ config: { killSwitch: true } });
  assert.equal((await off.open(rawPull())).reason, "kill_switch");
  assert.equal(off.issues.length, 0);
});

test("a missing token keeps the PR queued without creating anything", async () => {
  const f = fixture();
  f.setToken(false);
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  assert.equal(f.issues.length, 0);
  assert.equal((await f.engine.processDue()), 0, "it is not retried before its backoff");
  f.setToken(true);
  f.advance(16 * 60_000);
  await f.engine.processDue();
  assert.equal(f.issues.length, 1);
});

test("reconcile recovers a PR whose webhook was missed, and skips unchanged listings", async () => {
  const f = fixture();
  const raw = rawPull({ number: 9, sha: SHA1 });
  f.setPull(raw);
  f.setListing({ notModified: false, etag: "e1", pulls: [raw] });
  const first = await f.engine.reconcile();
  assert.equal(first.enqueued, 1);
  assert.equal(f.issues.length, 1);

  f.setListing({ notModified: true, etag: "e1", pulls: [] });
  const second = await f.engine.reconcile();
  assert.equal(second.enqueued, 0);
  assert.equal(f.issues.length, 1);
});

test("reconcile cancels the review of a PR that was closed while the webhook was down", async () => {
  const f = fixture();
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  f.setPull({ ...rawPull({ number: 5, sha: SHA1 }), state: "closed", merged_at: "2026-01-01" });
  f.setListing({ notModified: false, etag: "e2", pulls: [] });
  const summary = await f.engine.reconcile();
  assert.equal(summary.cancelled, 1);
  assert.equal(f.issues[0].status, "cancelled");
});

test("reconcile survives a GitHub failure for one repository", async () => {
  const f = fixture({ config: { repositories: [repoConfig(), repoConfig({ fullName: "wallynm/other" })] } });
  const raw = rawPull({ number: 3, sha: SHA1 });
  f.setPull(raw);
  f.setListing({ notModified: false, etag: "e", pulls: [raw] });
  const summary = await f.engine.reconcile();
  assert.equal(summary.errors, 0);
  assert.equal(summary.repos, 2);
});

const sign = (body) => `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
const webhook = (event, payload, signature) => {
  const rawBody = JSON.stringify(payload);
  return {
    endpointKey: "github",
    rawBody,
    headers: { "X-GitHub-Event": event, "X-GitHub-Delivery": `del-${Math.random()}`, "X-Hub-Signature-256": signature ?? sign(rawBody) },
    requestId: "req-1",
  };
};

test("the webhook rejects bad signatures and accepts signed pull_request events", async () => {
  const f = fixture();
  const raw = rawPull({ number: 5, sha: SHA1 });
  f.setPull(raw);
  const payload = { action: "opened", repository: { full_name: "wallynm/tesselapp" }, pull_request: raw };

  await assert.rejects(handleWebhook(f.ctx, f.engine, webhook("pull_request", payload, "sha256=deadbeef")), /invalid webhook signature/);
  await assert.rejects(handleWebhook(f.ctx, f.engine, { ...webhook("pull_request", payload), headers: {} }), /invalid webhook signature/);
  assert.equal(f.issues.length, 0);

  await handleWebhook(f.ctx, f.engine, webhook("ping", { zen: "hi" }));
  await handleWebhook(f.ctx, f.engine, webhook("pull_request", payload));
  await new Promise((resolve) => setTimeout(resolve, 20)); // let the fire-and-forget kick finish
  assert.equal(f.issues.length, 1);
  assert.equal(f.wakes.length, 1);

  await handleWebhook(f.ctx, f.engine, { ...webhook("push", {}), endpointKey: "other" });
  assert.equal(f.issues.length, 1);
});

test("without a configured webhook secret every delivery is rejected", async () => {
  const f = fixture({ config: { webhookSecretRef: undefined } });
  await assert.rejects(handleWebhook(f.ctx, f.engine, webhook("ping", {})), /invalid webhook signature/);
});
