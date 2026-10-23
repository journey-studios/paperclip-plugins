import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { enqueue, getRun, listRuns } from "../src/store.js";
const ns = "plugin_performance_observatory_27b58b0e8b";
const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompany = "33333333-3333-4333-8333-333333333333";
const projectId = "22222222-2222-4222-8222-222222222222";
test("migration, idempotent queue and company-filtered history use real PostgreSQL semantics", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE public.companies (id uuid PRIMARY KEY); CREATE TABLE public.projects (id uuid PRIMARY KEY); CREATE SCHEMA ${ns};`);
    await db.query("INSERT INTO public.companies VALUES ($1),($2)", [companyId, otherCompany]);
    await db.query("INSERT INTO public.projects VALUES ($1)", [projectId]);
    await db.exec(await readFile(new URL("../migrations/001_runs.sql", import.meta.url), "utf8"));
    const ctx = {
      db: { namespace: ns, query: async (sql, args) => (await db.query(sql, args)).rows,
        execute: async (sql, args) => ({ rowCount: (await db.query(sql, args)).affectedRows }) },
      config: { get: async () => ({ targets: [{ key: "chat", projectId, environment: "prod", url: "https://dash.tessel.app/chat" }] }) },
      projects: { get: async (id, company) => { if (id === projectId && company === companyId) return { id }; return null; } },
    };
    const first = await enqueue(ctx, companyId, "chat", "command", "stable-request-key");
    const second = await enqueue(ctx, companyId, "chat", "command", "stable-request-key");
    assert.equal(first.id, second.id);
    assert.equal((await listRuns(ctx, companyId)).length, 1);
    assert.equal((await listRuns(ctx, otherCompany)).length, 0);
    assert.equal(await getRun(ctx, otherCompany, first.id), null);
    await assert.rejects(enqueue(ctx, otherCompany, "chat", "command", "another-key"), /PROJECT_NOT_IN_COMPANY/);
    await assert.rejects(enqueue(ctx, companyId, "unknown", "command", "another-key"), /TARGET_NOT_FOUND/);
    assert.equal((await listRuns(ctx, companyId, { environment: "staging" })).length, 0);
    assert.equal((await listRuns(ctx, companyId, { targetKey: "' OR true --" })).length, 0);
  } finally { await db.close(); }
});
