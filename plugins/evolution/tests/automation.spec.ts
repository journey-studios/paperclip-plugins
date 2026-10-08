import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { COMPANY, OTHER_COMPANY, AGENT, NS, createWorkerFixture } from "./worker-fixture.js";

const NOW = Date.now();
const dayAgo = (days: number) => new Date(NOW - days * 86400_000).toISOString();
const RUN1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const RUN2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const OTHER_AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const toolCtx = (companyId = COMPANY) => ({ agentId: AGENT, runId: RUN1, companyId, projectId: "" });
let fixture: Awaited<ReturnType<typeof createWorkerFixture>>;

async function setWithAgent(agentId = AGENT, companyId = COMPANY, appliedAt = dayAgo(2)) {
  const context = companyId === COMPANY ? fixture.actorContext : {
    actor: { type: "user" as const, userId: "other", agentId: null, runId: null, companyId }, companyId,
  };
  const set = await fixture.action<{ id: string }>("create-change-set", { companyId, title: "Agent upgrade", appliedAt, status: "applied" }, context);
  await fixture.db.query(
    `INSERT INTO ${NS}.change_items (id, company_id, change_set_id, entity_type, entity_id, change_kind, source_type) VALUES (gen_random_uuid(), $1,$2,'agent',$3,'updated','test')`,
    [companyId, set.id, agentId],
  );
  return set.id;
}
async function run(id: string, companyId = COMPANY, agentId = AGENT, status = "succeeded", startedAt = dayAgo(1)) {
  await fixture.db.query(
    "INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at) VALUES ($1,$2,$3,$4,$5::timestamptz,($5::timestamptz + interval '5 minutes'))",
    [id, companyId, agentId, status, startedAt],
  );
}
async function event(runId: string, companyId = COMPANY, kind: "agent.run.finished" | "agent.run.failed" = "agent.run.finished") {
  await fixture.events.get(kind)!({ eventId: "event-" + runId, companyId, eventType: kind, entityType: "heartbeat_run", entityId: runId, payload: { runId } });
}

beforeEach(async () => {
  fixture = await createWorkerFixture();
  await fixture.db.query("INSERT INTO public.agents (id, company_id, name) VALUES ($1,$2,'Researcher'),($3,$4,'Other')", [AGENT, COMPANY, OTHER_AGENT, OTHER_COMPANY]);
});
afterEach(async () => fixture.close());

describe("Org Tracker automated evidence and native tools", () => {
  it("associates terminal runs idempotently, includes canonical run link and leaves manual status untouched", async () => {
    const set = await setWithAgent();
    await fixture.action("update-change-set", { changeSetId: set, status: "validating", causalityLevel: "validated" });
    await fixture.action("add-conclusion", {
      changeSetId: set,
      outcome: "proven",
      confidence: "moderate",
      summary: "Human review recorded before the automatic observation.",
    });
    await fixture.action("update-change-set", { changeSetId: set, status: "validating", causalityLevel: "validated" });
    await run(RUN1);
    await event(RUN1);
    await event(RUN1);
    const rows = (await fixture.db.query<{ verdict: string; metadata: Record<string, string> }>(
      `SELECT verdict,metadata FROM ${NS}.change_evidence WHERE company_id=$1 AND change_set_id=$2`, [COMPANY, set],
    )).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verdict: "neutral", metadata: { capture: "automatic", status: "succeeded" } });
    expect((await fixture.db.query(`SELECT link_type FROM ${NS}.change_links WHERE company_id=$1 AND change_set_id=$2`, [COMPANY, set])).rows)
      .toContainEqual({ link_type: "run" });
    const assessment = (await fixture.db.query(`SELECT outcome,reason_code FROM ${NS}.change_assessments WHERE company_id=$1 AND change_set_id=$2`, [COMPANY, set])).rows;
    expect(assessment).toMatchObject([{ outcome: "inconclusive", reason_code: "insufficient_observation" }]);
    expect((await fixture.db.query(`SELECT status,causality_level FROM ${NS}.change_sets WHERE id=$1`, [set])).rows[0])
      .toEqual({ status: "validating", causality_level: "validated" });
    expect((await fixture.db.query(`SELECT outcome,confidence,summary FROM ${NS}.change_conclusions WHERE change_set_id=$1`, [set])).rows)
      .toEqual([{ outcome: "proven", confidence: "moderate", summary: "Human review recorded before the automatic observation." }]);
  });
  it("does not cross the company boundary or attach the run that created the Change Set", async () => {
    const set = await setWithAgent();
    const otherSet = await setWithAgent(OTHER_AGENT, OTHER_COMPANY);
    await run(RUN1);
    await event(RUN1, OTHER_COMPANY);
    expect((await fixture.db.query(`SELECT count(*)::int AS n FROM ${NS}.change_evidence WHERE change_set_id IN ($1,$2)`, [set, otherSet])).rows[0]).toMatchObject({ n: 0 });
    const responses = await fixture.tools.get("org_tracker_change_summary")!({ changeSetId: set, companyId: COMPANY }, toolCtx(OTHER_COMPANY));
    expect(responses).toMatchObject({ error: expect.any(String) });
    expect(JSON.stringify(responses)).not.toContain("Agent upgrade");
    await fixture.db.query(`UPDATE ${NS}.change_sets SET source_context_key=$2 WHERE id=$1`, [set, "run:" + RUN1]);
    await event(RUN1, COMPANY);
    expect((await fixture.db.query(`SELECT count(*)::int AS n FROM ${NS}.change_evidence WHERE change_set_id=$1`, [set])).rows[0]).toMatchObject({ n: 0 });
  });
  it("keeps manually curated run evidence authoritative and captures failed runs as neutral observations", async () => {
    const set = await setWithAgent();
    await run(RUN1);
    await fixture.action("add-evidence", { changeSetId: set, evidenceType: "run", referenceId: RUN1, verdict: "negative" });
    await event(RUN1);
    await run(RUN2, COMPANY, AGENT, "failed");
    await event(RUN2, COMPANY, "agent.run.failed");
    const rows = (await fixture.db.query<{ reference_id: string; verdict: string; metadata: Record<string,string> }>(
      `SELECT reference_id,verdict,metadata FROM ${NS}.change_evidence WHERE change_set_id=$1 ORDER BY reference_id`, [set],
    )).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ reference_id: RUN1, verdict: "negative" });
    expect(rows[1]).toMatchObject({ reference_id: RUN2, verdict: "neutral", metadata: { status: "failed", capture: "automatic" } });
  });
  it("refreshes a missed event in the hourly job and exposes a bounded company-scoped MCP assessment", async () => {
    const set = await setWithAgent();
    await run(RUN1);
    await fixture.jobs.get("refresh-assessments")!({ jobKey: "refresh-assessments", runId: RUN2, trigger: "schedule" });
    expect((await fixture.db.query(`SELECT count(*)::int AS n FROM ${NS}.change_evidence WHERE change_set_id=$1`, [set])).rows[0]).toMatchObject({ n: 1 });
    const listing = await fixture.tools.get("org_tracker_list_changes")!({ limit: 4, companyId: OTHER_COMPANY }, toolCtx());
    expect(listing).toMatchObject({ data: { changeSets: [{ id: set }] } });
    const evaluated = await fixture.tools.get("org_tracker_evaluate_change")!({ changeSetId: set, companyId: OTHER_COMPANY }, toolCtx());
    expect(evaluated).toMatchObject({ data: { changeSetId: set, assessment: { outcome: "inconclusive", causality: "observational_only" } } });
    const foreign = await fixture.tools.get("org_tracker_evaluate_change")!({ changeSetId: set }, toolCtx(OTHER_COMPANY));
    expect(foreign).toMatchObject({ error: expect.any(String) });
    const missing = await fixture.tools.get("org_tracker_evaluate_change")!({ changeSetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, toolCtx());
    expect(missing).toMatchObject({ error: expect.any(String) });
    expect((await fixture.db.query(`SELECT count(*)::int AS n FROM ${NS}.change_assessments WHERE change_set_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'`)).rows[0])
      .toMatchObject({ n: 0 });
  });
});
