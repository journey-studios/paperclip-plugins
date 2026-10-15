import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { MilestoneRecord } from "../src/contracts.js";
import { DATABASE_NAMESPACE } from "../src/manifest.js";
import { COMPANY, OTHER_COMPANY, OTHER_PROJECT, PROJECT, SECOND_PROJECT, ARCHIVED_PROJECT, createHarness, issue, type Harness } from "./harness.js";

let h: Harness;
beforeEach(async () => {
  if (h) await h.db.close();
  h = await createHarness();
});
afterAll(async () => { if (h) await h.db.close(); });

const create = (params: Record<string, unknown>, run = {}) => h.tool("create_milestone", params, run);
const update = (params: Record<string, unknown>) => h.tool("update_milestone", params);
const data = (params: Record<string, unknown> = {}) => h.data("milestones.list", { companyId: COMPANY, projectId: PROJECT, ...params }) as Promise<MilestoneRecord[]>;
const alpha = (more: Record<string, unknown> = {}) => ({
  title: "Alpha on iPad",
  criteria: [{ text: "Touch controls verified", checked: false }],
  ...more,
});
const entry = async (params: Record<string, unknown> = alpha()) => {
  const result = await create(params);
  expect(result.error).toBeUndefined();
  return result.data as MilestoneRecord;
};

describe("project milestone 003 storage", () => {
  it("uses a real migration, isolated records and joined names", async () => {
    const m = await entry(alpha({ targetDate: "2026-12-10" }));
    expect(m).toMatchObject({
      companyId: COMPANY, projectId: PROJECT, projectName: "Acme Web App",
      targetDate: "2026-12-10", status: "planned", progress: 0, revision: 1,
    });
    expect((await data()).map((it) => it.id)).toEqual([m.id]);
    expect((await data({ companyId: OTHER_COMPANY, projectId: PROJECT }))).toEqual([]);
    expect((await data({ projectId: SECOND_PROJECT }))).toEqual([]);
    expect((await h.data("milestone.get", { companyId: OTHER_COMPANY, milestoneId: m.id }))).toBeNull();
    const stored = await h.db.query(`SELECT status FROM ${DATABASE_NAMESPACE}.milestones WHERE id = $1`, [m.id]);
    expect(stored.rows).toEqual([{ status: "planned" }]);
  });

  it("keeps existing changelog history and never inserts a milestone event on creation", async () => {
    await entry();
    expect((await h.db.query(`SELECT * FROM ${DATABASE_NAMESPACE}.changelog_entries`)).rows).toEqual([]);
  });

  it("rejects malformed title, criteria, dates, URLs and duplicate issues", async () => {
    expect((await create({ criteria: [{ text: "a", checked: false }] })).error).toContain("title");
    expect((await create(alpha({ criteria: [] }))).error).toContain("criteria");
    expect((await create(alpha({ targetDate: "2026-02-30" }))).error).toContain("targetDate");
    expect((await create(alpha({ evidence: [{ label: "bad", url: "javascript:alert(1)" }] }))).error).toContain("http(s)");
    const id = randomUUID();
    expect((await create(alpha({ issueIds: [id, id] }))).error).toContain("duplicate");
    expect((await create(alpha({ extra: 42 }))).error).toContain("unexpected");
    expect(await data()).toEqual([]);
  });

  it("requires project membership and refuses archived projects and foreign issues", async () => {
    const foreign = randomUUID();
    h.issues.set(foreign, issue({ id: foreign, companyId: OTHER_COMPANY, projectId: OTHER_PROJECT }));
    expect((await create(alpha({ issueIds: [foreign] }))).error).toContain("belong");
    expect((await create(alpha({ projectId: OTHER_PROJECT }))).error).toContain("not found");
    expect((await create(alpha({ projectId: ARCHIVED_PROJECT }))).error).toContain("archived");
    expect((await create(alpha(), { projectId: "" })).error).toContain("projectId");
  });

  it("cannot create already completed milestones or modify another company's milestone", async () => {
    expect((await create(alpha({ status: "completed" }))).error).toContain("created before");
    const m = await entry();
    const result = await h.api("milestone-update", {
      method: "POST", companyId: OTHER_COMPANY, params: { milestoneId: m.id },
      body: { revision: m.revision, title: "attack" },
    });
    expect(result.status).toBe(404);
    expect((await data())[0].title).toBe("Alpha on iPad");
  });
});

describe("milestone progress and completion", () => {
  it("reads live linked Issue statuses but never auto-completes a milestone", async () => {
    const id = randomUUID();
    h.issues.set(id, issue({ id, status: "todo", identifier: "ACME-10" }));
    const m = await entry(alpha({ issueIds: [id] }));
    expect(m.progress).toBe(0);
    expect(m.blockers.join("; ")).toContain("ACME-10");
    h.issues.set(id, issue({ id, status: "done", identifier: "ACME-10" }));
    const [fresh] = await data();
    expect(fresh.doneIssues).toBe(1);
    expect(fresh.progress).toBe(50);
    expect(fresh.status).toBe("planned");
  });

  it("requires explicit checked criteria, all Issues done, and verifiable evidence before completion", async () => {
    const id = randomUUID();
    h.issues.set(id, issue({ id, status: "todo", identifier: "ACME-20" }));
    const m = await entry(alpha({ issueIds: [id] }));
    expect((await update({ milestoneId: m.id, revision: 1, status: "completed" })).error).toContain("Cannot complete");
    const revised = (await update({
      milestoneId: m.id, revision: 1,
      criteria: [{ text: "Touch controls verified", checked: true }],
      evidence: [{ label: "E2E", url: "https://github.com/journey-studios/paperclip-plugins/actions" }],
    })).data as MilestoneRecord;
    expect(revised.revision).toBe(2);
    expect(revised.progress).toBe(50);
    expect((await update({ milestoneId: m.id, revision: 2, status: "completed" })).error).toContain("Cannot complete");
    h.issues.set(id, issue({ id, status: "done", identifier: "ACME-20" }));
    const [ready] = await data();
    expect(ready.readyToComplete).toBe(true);
    expect(ready.progress).toBe(100);
    expect(ready.status).toBe("planned");
    const completed = (await update({ milestoneId: m.id, revision: 2, status: "completed" })).data as MilestoneRecord;
    expect(completed).toMatchObject({ revision: 3, status: "completed", readyToComplete: true, progress: 100 });
    expect(completed.completedAt).not.toBeNull();
    const logged = (await h.db.query<Record<string, unknown>>(
      `SELECT kind, milestone_id, title, refs, links FROM ${DATABASE_NAMESPACE}.changelog_entries WHERE company_id = $1`, [COMPANY],
    )).rows;
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ kind: "milestone", milestone_id: m.id, title: "Alpha on iPad" });
    expect(JSON.stringify(logged[0].refs)).toContain("ACME-20");
    expect(JSON.stringify(logged[0].links)).toContain("https://github.com");
    expect(h.activity.at(-1)?.message).toContain("Completed milestone");
  });

  it("writes Changelog refs from the Issues linked in the same completion update", async () => {
    const id = randomUUID();
    h.issues.set(id, issue({ id, status: "done", identifier: "ACME-77" }));
    const m = await entry(alpha({
      criteria: [{ text: "Acceptance", checked: true }],
      evidence: [{ label: "Live test", url: "https://example.com/proof" }],
    }));
    const result = await update({ milestoneId: m.id, revision: 1, status: "completed", issueIds: [id] });
    expect(result.error).toBeUndefined();
    const change = (await h.db.query<Record<string, unknown>>(
      `SELECT refs FROM ${DATABASE_NAMESPACE}.changelog_entries WHERE milestone_id=$1`, [m.id],
    )).rows[0];
    expect(JSON.stringify(change.refs)).toContain("ACME-77");
  });

  it("uses optimistic revisions to avoid lost writes or double-completing", async () => {
    const m = await entry(alpha({
      criteria: [{ text: "Ready", checked: true }],
      evidence: [{ label: "Release", url: "https://example.com/release" }],
    }));
    expect((await update({ milestoneId: m.id, revision: 999, title: "wrong" })).error).toContain("refresh");
    const a = await Promise.all([
      update({ milestoneId: m.id, revision: 1, status: "completed" }),
      update({ milestoneId: m.id, revision: 1, status: "completed" }),
    ]);
    expect(a.filter((r) => !r.error)).toHaveLength(1);
    expect(a.filter((r) => r.error?.includes("refresh"))).toHaveLength(1);
    const logged = (await h.db.query(`SELECT id FROM ${DATABASE_NAMESPACE}.changelog_entries`)).rows;
    expect(logged).toHaveLength(1);
  });

  it("locks completed milestones until explicit reopen; records history once", async () => {
    const m = await entry(alpha({
      criteria: [{ text: "Ready", checked: true }],
      evidence: [{ label: "Release", url: "https://example.com/release" }],
    }));
    const done = (await update({ milestoneId: m.id, revision: 1, status: "completed" })).data as MilestoneRecord;
    expect((await update({ milestoneId: m.id, revision: 2, title: "new" })).error).toContain("immutable");
    const reopened = (await update({ milestoneId: m.id, revision: 2, status: "in_progress" })).data as MilestoneRecord;
    expect(reopened.completedAt).toBeNull();
    expect(reopened.status).toBe("in_progress");
    const again = (await update({ milestoneId: m.id, revision: 3, status: "completed" })).data as MilestoneRecord;
    expect(again.status).toBe("completed");
    expect((await h.db.query(`SELECT id FROM ${DATABASE_NAMESPACE}.changelog_entries`)).rows).toHaveLength(1);
    expect(done.id).toBe(again.id);
  });

  it("shows a historical completed milestone but warns when a linked Issue later reopens", async () => {
    const id = randomUUID();
    h.issues.set(id, issue({ id, status: "done" }));
    const m = await entry(alpha({ issueIds: [id], criteria: [{ text: "Ready", checked: true }],
      evidence: [{ label: "E2E", url: "https://example.com" }] }));
    await update({ milestoneId: m.id, revision: 1, status: "completed" });
    h.issues.set(id, issue({ id, status: "in_progress" }));
    const [fresh] = await data();
    expect(fresh.status).toBe("completed");
    expect(fresh.readyToComplete).toBe(false);
    expect(fresh.blockers.join("; ")).toContain("not done");
  });

  it("prevents moving linked Issues across projects and accepts canceled/reopened milestones", async () => {
    const id = randomUUID();
    h.issues.set(id, issue({ id, projectId: SECOND_PROJECT }));
    const m = await entry();
    expect((await update({ milestoneId: m.id, revision: 1, issueIds: [id] })).error).toContain("belong");
    const cancelled = (await update({ milestoneId: m.id, revision: 1, status: "cancelled" })).data as MilestoneRecord;
    expect(cancelled.status).toBe("cancelled");
    expect((await update({ milestoneId: m.id, revision: 2, status: "in_progress" })).error).toBeUndefined();
  });
});

describe("native UI transport and REST", () => {
  it("exposes create, read, update and the project Issue picker through host actions", async () => {
    const id = randomUUID();
    h.issues.set(id, issue({ id, identifier: "ACME-31" }));
    const issues = await h.data("milestones.projectIssues", { companyId: COMPANY, projectId: PROJECT }) as { id: string }[];
    expect(issues.map((item) => item.id)).toContain(id);
    const created = await h.action("milestone.create", { companyId: COMPANY, projectId: PROJECT, ...alpha() }) as MilestoneRecord;
    expect(created.createdBy.kind).toBe("user");
    const updated = await h.action("milestone.update", { companyId: COMPANY, milestoneId: created.id, revision: 1, status: "in_progress" }) as MilestoneRecord;
    expect(updated.status).toBe("in_progress");
    expect((await h.data("milestone.get", { companyId: COMPANY, milestoneId: created.id }))).toMatchObject({ revision: 2 });
  });

  it("REST input errors are 422, revision conflict 409, and create/update succeed", async () => {
    const bad = await h.api("milestone-create", { method: "POST", body: { projectId: PROJECT, title: "No checks" } });
    expect(bad.status).toBe(422);
    const added = await h.api("milestone-create", { method: "POST", body: { projectId: PROJECT, ...alpha() } });
    expect(added.status).toBe(200);
    const created = (added.body as { milestone: MilestoneRecord }).milestone;
    const listed = await h.api("milestones-list", { query: { projectId: PROJECT } });
    expect((listed.body as { milestones: MilestoneRecord[] }).milestones[0]?.id).toBe(created.id);
    const updated = await h.api("milestone-update", { method: "POST", params: { milestoneId: created.id },
      body: { revision: 1, status: "in_progress" } });
    expect(updated.status).toBe(200);
    const conflict = await h.api("milestone-update", { method: "POST", params: { milestoneId: created.id },
      body: { revision: 1, title: "Conflicting change" } });
    expect(conflict.status).toBe(409);
  });
});
