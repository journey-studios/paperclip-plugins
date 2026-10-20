import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  closeReview,
  dispatchQueued,
  enqueueReview,
  finishByRunId,
  finishReview,
  queueStats,
  reconcileCompany,
} from "../src/queue.js";

const NAMESPACE = "plugin_pr_review_orchestrator_167e9509eb";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const route = { projectId: PROJECT, reviewerAgentId: AGENT };
const pr = (number, sha, updatedAt = "2026-10-20T10:00:00Z") => ({
  repository: "wallynm/tesselapp",
  number,
  sha,
  updatedAt,
  url: `https://github.com/wallynm/tesselapp/pull/${number}`,
  title: `Test PR #${number}`,
  baseRef: "main",
  authorLogin: "developer",
});

let sharedPg = null;
after(async () => { if (sharedPg) await sharedPg.close(); });

async function createHarness() {
  if (!sharedPg) {
    sharedPg = new PGlite();
    await sharedPg.exec(`CREATE SCHEMA ${NAMESPACE}`);
    const sql = await readFile(new URL("../migrations/001_pr_reviews.sql", import.meta.url), "utf8");
    await sharedPg.exec(sql);
  } else {
    await sharedPg.exec(`TRUNCATE ${NAMESPACE}.review_jobs`);
  }
  const pg = sharedPg;
  const issues = new Map();
  const wakeups = [];
  const logs = [];
  let failNextWakeup = false;
  let failAfterWakeStarted = false;
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql, args = []) {
        return (await pg.query(sql, args)).rows;
      },
      async execute(sql, args = []) {
        const res = await pg.query(sql, args);
        return { rowCount: res.affectedRows ?? 0 };
      },
    },
    logger: {
      warn(message, fields) { logs.push({ message, fields }); },
      info() {},
      error() {},
    },
    agents: {
      async get(id) { return id === AGENT ? { id, status: "idle" } : null; },
    },
    projects: {
      async get(id) { return id === PROJECT ? { id } : null; },
    },
    issues: {
      async list({ companyId, originKind, originId }) {
        return [...issues.values()].filter((i) => i.companyId === companyId &&
          i.originKind === originKind && i.originId === originId);
      },
      async create(input) {
        const issue = { ...input, id: randomUUID() };
        issues.set(issue.id, issue);
        return issue;
      },
      async get(id) { return issues.get(id) ?? null; },
      async requestWakeup(id, companyId, options) {
        if (failNextWakeup) {
          failNextWakeup = false;
          throw new Error("Simulated transient wakeup failure");
        }
        const issue = issues.get(id);
        if (failAfterWakeStarted) {
          failAfterWakeStarted = false;
          issue.status = "in_progress";
          wakeups.push({ issueId: id, ...options });
          throw new Error("Wakeup response lost after a run started");
        }
        assert.equal(issue?.companyId, companyId);
        issue.status = "in_progress";
        wakeups.push({ issueId: id, ...options });
        return { queued: true, runId: randomUUID() };
      },
    },
  };
  return {
    ctx,
    issues,
    wakeups,
    logs,
    pg,
    async jobs() {
      return (await pg.query(`SELECT * FROM ${NAMESPACE}.review_jobs ORDER BY created_at,id`)).rows;
    },
    async setFailure() { failNextWakeup = true; },
    async setUncertainStartedFailure() { failAfterWakeStarted = true; },
    async close() { /* Shared PGlite database is closed by the suite hook. */ },
  };
}

test("three PRs queue for one reviewer and drain sequentially", async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  for (let number = 373; number <= 375; number++) {
    await enqueueReview(h.ctx, COMPANY, route, pr(number, String(number).padStart(40, "a")));
  }
  const first = await dispatchQueued(h.ctx, COMPANY);
  assert.equal(first.dispatched, 1);
  assert.equal(h.wakeups.length, 1);
  assert.deepEqual((await queueStats(h.ctx, COMPANY)).map((x) => [x.status, x.count]),
    [["queued", 2], ["running", 1]]);

  const current = (await h.jobs()).find((j) => j.status === "running");
  await finishReview(h.ctx, COMPANY, current.issue_id, true);
  assert.equal((await dispatchQueued(h.ctx, COMPANY)).dispatched, 1);
  const second = (await h.jobs()).find((j) => j.status === "running");
  assert.notEqual(current.id, second.id);
  await finishReview(h.ctx, COMPANY, second.issue_id, true);
  assert.equal((await dispatchQueued(h.ctx, COMPANY)).dispatched, 1);
  const third = (await h.jobs()).find((j) => j.status === "running");
  await finishReview(h.ctx, COMPANY, third.issue_id, true);
  assert.equal((await dispatchQueued(h.ctx, COMPANY)).dispatched, 0);
  assert.equal(h.wakeups.length, 3);
  assert.deepEqual((await queueStats(h.ctx, COMPANY)).map((x) => [x.status, x.count]),
    [["awaiting_publication", 3]]);
});

test("one SHA is idempotent and a newer commit waits until the current review ends", async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const oldPr = pr(373, "a".repeat(40));
  await enqueueReview(h.ctx, COMPANY, route, oldPr);
  assert.equal((await enqueueReview(h.ctx, COMPANY, route, oldPr)).created, false);
  assert.equal((await dispatchQueued(h.ctx, COMPANY)).dispatched, 1);
  const next = pr(373, "b".repeat(40), "2026-10-20T10:01:00Z");
  await enqueueReview(h.ctx, COMPANY, route, next);
  assert.equal((await dispatchQueued(h.ctx, COMPANY)).dispatched, 0);
  await finishReview(h.ctx, COMPANY, (await h.jobs()).find((j) => j.status === "running").issue_id, true);
  assert.equal((await dispatchQueued(h.ctx, COMPANY)).dispatched, 1);
  assert.equal(h.wakeups.length, 2);
  assert.equal((await h.jobs()).length, 2);
});

test("late old webhook is marked superseded and cannot overwrite the new head", async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await enqueueReview(h.ctx, COMPANY, route, pr(373, "b".repeat(40), "2026-10-20T10:03:00Z"));
  await enqueueReview(h.ctx, COMPANY, route, pr(373, "a".repeat(40), "2026-10-20T10:01:00Z"));
  const jobs = await h.jobs();
  assert.equal(jobs.find((j) => j.head_sha.startsWith("a")).status, "superseded");
  assert.equal(jobs.find((j) => j.head_sha.startsWith("b")).status, "queued");
});

test("reopening the same SHA resumes an inactive review without duplicate issues", async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const event = pr(373, "a".repeat(40));
  await enqueueReview(h.ctx, COMPANY, route, event);
  await closeReview(h.ctx, COMPANY, { ...event, updatedAt: "2026-10-20T10:01:00Z" });
  assert.equal((await h.jobs())[0].status, "closed");
  await enqueueReview(h.ctx, COMPANY, route, {
    ...event, updatedAt: "2026-10-20T10:02:00Z",
  });
  assert.equal((await h.jobs()).length, 1);
  assert.equal((await h.jobs())[0].status, "queued");
});

test("concurrent dispatch attempts cannot wake the same reviewer twice", async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  for (let number = 1; number <= 3; number++) {
    await enqueueReview(h.ctx, COMPANY, route, pr(number, String(number).repeat(40)));
  }
  await Promise.all([
    dispatchQueued(h.ctx, COMPANY), dispatchQueued(h.ctx, COMPANY),
    dispatchQueued(h.ctx, COMPANY),
  ]);
  assert.equal(h.wakeups.length, 1);
  assert.equal((await h.jobs()).filter((j) => j.status === "running").length, 1);
});

test("an Issue awaiting review does not release the agent early", async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await enqueueReview(h.ctx, COMPANY, route, pr(373, "a".repeat(40)));
  await enqueueReview(h.ctx, COMPANY, route, pr(374, "b".repeat(40)));
  assert.equal((await dispatchQueued(h.ctx, COMPANY)).dispatched, 1);
  const running = (await h.jobs()).find((j) => j.status === "running");
  h.issues.get(running.issue_id).status = "in_review";
  await reconcileCompany(h.ctx, COMPANY);
  assert.equal((await h.jobs()).find((j) => j.id === running.id).status, "running");
  assert.equal(h.wakeups.length, 1);
});

test("terminal run events resolve the correct review by wake run ID", async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await enqueueReview(h.ctx, COMPANY, route, pr(373, "a".repeat(40)));
  await dispatchQueued(h.ctx, COMPANY);
  const running = (await h.jobs()).find((j) => j.status === "running");
  assert.ok(running.wake_run_id);
  assert.deepEqual(
    await finishByRunId(h.ctx, COMPANY, "unrelated-run", true),
    { updated: false },
  );
  assert.deepEqual(
    await finishByRunId(h.ctx, COMPANY, running.wake_run_id, true),
    { updated: true, awaitingPublication: true },
  );
  assert.deepEqual(
    await finishByRunId(h.ctx, COMPANY, running.wake_run_id, true),
    { updated: false },
  );
  assert.equal((await h.jobs())[0].status, "awaiting_publication");
});

test("an uncertain wake response never queues another concurrent reviewer", async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await enqueueReview(h.ctx, COMPANY, route, pr(373, "a".repeat(40)));
  await h.setUncertainStartedFailure();
  await dispatchQueued(h.ctx, COMPANY);
  assert.equal((await h.jobs())[0].status, "dispatching");
  assert.equal(h.wakeups.length, 1);
  await h.ctx.db.execute(
    `UPDATE ${NAMESPACE}.review_jobs
     SET dispatch_lease_until=now()-interval '1 minute'`,
  );
  await reconcileCompany(h.ctx, COMPANY);
  assert.equal((await h.jobs())[0].status, "running");
  assert.equal(h.wakeups.length, 1);
});

test("failed wakeup retries reuse the existing Paperclip Issue", async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await enqueueReview(h.ctx, COMPANY, route, pr(373, "a".repeat(40)));
  await h.setFailure();
  await dispatchQueued(h.ctx, COMPANY);
  assert.equal((await h.jobs())[0].status, "dispatching");
  assert.equal((await h.jobs())[0].attempts, 1);
  assert.equal(h.issues.size, 1);
  await h.ctx.db.execute(
    `UPDATE ${NAMESPACE}.review_jobs
     SET dispatch_lease_until=now()-interval '1 minute'`,
  );
  await reconcileCompany(h.ctx, COMPANY);
  assert.equal((await h.jobs())[0].status, "queued");
  await h.ctx.db.execute(
    `UPDATE ${NAMESPACE}.review_jobs SET next_attempt_at=now()-interval '1 minute'`,
  );
  assert.equal((await dispatchQueued(h.ctx, COMPANY)).dispatched, 1);
  assert.equal(h.issues.size, 1);
  assert.equal(h.wakeups.length, 1);
});
