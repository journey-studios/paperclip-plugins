import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT, COMPANY, NS, createWorkerFixture } from "./worker-fixture.js";

let fixture: Awaited<ReturnType<typeof createWorkerFixture>>;
beforeEach(async () => {
  fixture = await createWorkerFixture();
  await fixture.db.query(
    "INSERT INTO public.agents (id, company_id, name) VALUES ($1, $2, 'Review agent')",
    [AGENT, COMPANY],
  );
});
afterEach(async () => fixture.close());

async function createSet(title: string, appliedAt?: string) {
  const set = await fixture.action<{ id: string }>("create-change-set", {
    title, status: "applied", ...(appliedAt ? { appliedAt } : {}),
  });
  await fixture.db.query(
    `INSERT INTO ${NS}.change_items (id, company_id, change_set_id, entity_type, entity_id, change_kind, source_type)
      VALUES (gen_random_uuid(), $1, $2, 'agent', $3, 'updated', 'test')`,
    [COMPANY, set.id, AGENT],
  );
  return set.id;
}

describe("CodeRabbit merge and observation window regressions", () => {
  it("merges a run recorded automatically in both sets, keeping manual evidence authoritative", async () => {
    const source = await createSet("Source");
    const target = await createSet("Target");
    const insert = async (setId: string, runId: string, capture: string, verdict = "neutral") => {
      await fixture.db.query(
        `INSERT INTO ${NS}.change_evidence (id, company_id, change_set_id, evidence_type, reference_id, metadata, verdict)
          VALUES (gen_random_uuid(), $1, $2, 'run', $3, $4::jsonb, $5)`,
        [COMPANY, setId, runId, JSON.stringify({ capture }), verdict],
      );
    };
    await insert(source, "shared-auto", "automatic");
    await insert(target, "shared-auto", "automatic");
    await insert(source, "shared-manual", "automatic");
    await insert(target, "shared-manual", "manual", "negative");
    await insert(source, "source-only", "automatic");

    const params = { sourceChangeSetId: source, targetChangeSetId: target };
    await expect(fixture.action("merge-change-set", params)).resolves.toMatchObject({ ok: true, alreadyMerged: false });
    await expect(fixture.action("merge-change-set", params)).resolves.toMatchObject({ ok: true, alreadyMerged: true });
    const rows = (await fixture.db.query<{ reference_id: string; verdict: string; metadata: { capture: string } }>(
      `SELECT reference_id, verdict, metadata FROM ${NS}.change_evidence
       WHERE company_id = $1 AND change_set_id = $2 ORDER BY reference_id`,
      [COMPANY, target],
    )).rows;
    expect(rows).toEqual([
      { reference_id: "shared-auto", verdict: "neutral", metadata: { capture: "automatic" } },
      { reference_id: "shared-manual", verdict: "negative", metadata: { capture: "manual" } },
      { reference_id: "source-only", verdict: "neutral", metadata: { capture: "automatic" } },
    ]);
  });

  it("continues processing other Change Sets when one run assessment fails", async () => {
    const appliedAt = new Date(Date.now() - 2 * 86400_000).toISOString();
    const ids = [await createSet("One", appliedAt), await createSet("Two", appliedAt)].sort();
    const [failingSet, healthySet] = ids;
    const runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await fixture.db.query(
      `INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at)
        VALUES ($1,$2,$3,'succeeded',now() - interval '1 day',now() - interval '23 hours')`,
      [runId, COMPANY, AGENT],
    );
    await fixture.db.exec(`
      CREATE FUNCTION public.reject_first_set_metric() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.change_set_id = '${failingSet}'::uuid THEN
          RAISE EXCEPTION 'injected single-set metric failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_first_set_metric BEFORE INSERT ON ${NS}.change_metrics
      FOR EACH ROW EXECUTE FUNCTION public.reject_first_set_metric();
    `);
    await expect(fixture.events.get("agent.run.finished")!({
      eventId: "terminal-event",
      companyId: COMPANY,
      eventType: "agent.run.finished",
      entityType: "heartbeat_run",
      entityId: runId,
      payload: { runId },
    })).resolves.toBeUndefined();

    const evidence = (await fixture.db.query<{ change_set_id: string }>(
      `SELECT change_set_id FROM ${NS}.change_evidence
       WHERE company_id = $1 AND evidence_type = 'run' AND reference_id = $2 ORDER BY change_set_id`,
      [COMPANY, runId],
    )).rows;
    expect(evidence.map((row) => row.change_set_id)).toEqual(ids);
    const assessments = (await fixture.db.query<{ change_set_id: string }>(
      `SELECT change_set_id FROM ${NS}.change_assessments WHERE company_id = $1 AND change_set_id IN ($2, $3)`,
      [COMPANY, failingSet, healthySet],
    )).rows;
    expect(assessments).toEqual([{ change_set_id: healthySet }]);
  });

  it("caps metrics, captured evidence and overlapping changes at seven days", async () => {
    const appliedAt = new Date(Date.now() - 10 * 86400_000).toISOString();
    const source = await createSet("Old change", appliedAt);
    await fixture.db.query(
      `UPDATE ${NS}.change_sets SET validation_ends_at = now() + interval '30 days' WHERE company_id = $1 AND id = $2`,
      [COMPANY, source],
    );
    await createSet("Outside observation", new Date(Date.now() - 86400_000).toISOString());
    const inside = new Date(Date.parse(appliedAt) + 5 * 86400_000).toISOString();
    const outside = new Date(Date.parse(appliedAt) + 9 * 86400_000).toISOString();
    const runIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
    ];
    for (const [index, started] of [inside, outside].entries()) {
      await fixture.db.query(
        "INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at) VALUES ($1,$2,$3,'succeeded',$4::timestamptz, $4::timestamptz + interval '5 minutes')",
        [runIds[index], COMPANY, AGENT, started],
      );
    }

    await fixture.action("refresh-assessment", { changeSetId: source });
    const metrics = (await fixture.db.query<{ endAt: string; current_sample_size: number }>(
      `SELECT metadata->'windows'->'current'->>'endAt' AS "endAt", current_sample_size
       FROM ${NS}.change_metrics WHERE company_id = $1 AND change_set_id = $2 AND metric_key = 'run_success_rate'`,
      [COMPANY, source],
    )).rows;
    expect(metrics).toHaveLength(1);
    expect(Date.parse(metrics[0]!.endAt)).toBe(Date.parse(appliedAt) + 7 * 86400_000);
    expect(metrics[0]!.current_sample_size).toBe(1);
    const captured = (await fixture.db.query<{ reference_id: string }>(
      `SELECT reference_id FROM ${NS}.change_evidence WHERE company_id = $1 AND change_set_id = $2`,
      [COMPANY, source],
    )).rows;
    expect(captured).toEqual([{ reference_id: runIds[0] }]);
    const assessment = (await fixture.db.query<{ reason_code: string }>(
      `SELECT reason_code FROM ${NS}.change_assessments WHERE company_id = $1 AND change_set_id = $2`,
      [COMPANY, source],
    )).rows;
    expect(assessment).toMatchObject([{ reason_code: "insufficient_observation" }]);
  });
});
