import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  closeReview,
  dispatchQueued,
  enqueueReview,
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

async function createHarness() {
  const pg = new PGlite();
  await pg.exec(`CREATE SCHEMA ${NAMESPACE}`);
  const sql = await readFile(new URL("../migrations/001_pr_reviews.sql", import.meta.url), "utf8");
  await pg.exec(sql);
  const issues = new Map();
  const wakeups = [];
  const logs = [];
  let failNextWakeup = false;
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
    async close() { await pg.close(); },
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

test("failed wakeup retries reuse the existing Paperclip Issue", async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await enqueueReview(h.ctx, COMPANY, route, pr(373, "a".repeat(40)));
  await h.setFailure();
  await dispatchQueued(h.ctx, COMPANY);
  assert.equal((await h.jobs())[0].status, "queued");
  assert.equal((await h.jobs())[0].attempts, 1);
  assert.equal(h.issues.size, 1);
  await h.ctx.db.execute(
    `UPDATE ${NAMESPACE}.review_jobs SET next_attempt_at=now()-interval '1 minute'`,
  );
  assert.equal((await dispatchQueued(h.ctx, COMPANY)).dispatched, 1);
  assert.equal(h.issues.size, 1);
  assert.equal(h.wakeups.length, 1);
});
