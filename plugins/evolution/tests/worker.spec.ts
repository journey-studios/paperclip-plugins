import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { createWorkerFixture, COMPANY, OTHER_COMPANY, AGENT, NS } from "./worker-fixture.js";

let fixture: Awaited<ReturnType<typeof createWorkerFixture>>;
beforeEach(async () => { fixture = await createWorkerFixture(); });
afterEach(async () => fixture.close());

async function createSet(title: string, companyId = COMPANY, context = fixture.actorContext) {
  return fixture.action<{ ok: true; id: string }>("create-change-set", { companyId, title }, context);
}

describe("Evolution data integrity and actions", () => {
  it("rejects cross-company child writes in handlers and at every company-parent foreign key", async () => {
    const otherActor: PluginPerformActionContext = {
      actor: { type: "user", userId: "other-user", agentId: null, runId: null, companyId: OTHER_COMPANY },
      companyId: OTHER_COMPANY,
    };
    const other = await createSet("Other company", OTHER_COMPANY, otherActor);
    await expect(fixture.action("add-evidence", { changeSetId: other.id, evidenceType: "run" })).rejects.toThrow("Change Set not found");
    await expect(fixture.action("add-link", { changeSetId: other.id, linkType: "issue", referenceId: "ISSUE-1" })).rejects.toThrow("Change Set not found");
    await expect(fixture.action("add-conclusion", { changeSetId: other.id, outcome: "proven", summary: "x" })).rejects.toThrow("Change Set not found");

    const own = await createSet("Own company");
    const invalidRows = [
      ["change_items", "id, company_id, change_set_id, entity_type, entity_id, change_kind, source_type", "gen_random_uuid(), $1, $2, 'agent', 'agent-1', 'updated', 'test'"],
      ["change_links", "id, company_id, change_set_id, link_type, reference_id", "gen_random_uuid(), $1, $2, 'issue', 'ISSUE-1'"],
      ["change_evidence", "id, company_id, change_set_id, evidence_type", "gen_random_uuid(), $1, $2, 'run'"],
      ["change_metrics", "id, company_id, change_set_id, metric_key", "gen_random_uuid(), $1, $2, 'cost'"],
      ["change_conclusions", "id, company_id, change_set_id, outcome, summary", "gen_random_uuid(), $1, $2, 'proven', 'ok'"],
    ];
    for (const [table, columns, values] of invalidRows) {
      await expect(fixture.db.query(`INSERT INTO ${NS}.${table} (${columns}) VALUES (${values})`, [OTHER_COMPANY, own.id])).rejects.toThrow();
    }
    const snapshot = await fixture.db.query<{ id: string }>(
      `INSERT INTO ${NS}.change_snapshots (id, company_id, entity_type, entity_id, snapshot_hash, source_type) VALUES (gen_random_uuid(), $1, 'agent', 'agent-1', 'hash', 'test') RETURNING id`,
      [OTHER_COMPANY],
    );
    await expect(fixture.db.query(
      `INSERT INTO ${NS}.change_items (id, company_id, change_set_id, entity_type, entity_id, change_kind, source_type, before_snapshot_id) VALUES (gen_random_uuid(), $1, $2, 'agent', 'agent-1', 'updated', 'test', $3)`,
      [COMPANY, own.id, snapshot.rows[0]!.id],
    )).rejects.toThrow();
  });

  it("requires host-authorized company scope and ignores a caller-selected company", async () => {
    const forged: PluginPerformActionContext = {
      actor: { ...fixture.actorContext.actor, companyId: OTHER_COMPANY },
      companyId: OTHER_COMPANY,
    };
    await expect(fixture.action("create-change-set", { title: "No scope", companyId: OTHER_COMPANY }, fixture.actorContext)).rejects.toThrow("Authorized company scope is required");
    await expect(fixture.action("create-change-set", { title: "Missing scope" }, { ...fixture.actorContext, companyId: null })).rejects.toThrow("Authorized company scope is required");
    const created = await fixture.action<{ id: string }>("create-change-set", {
      title: "Spoofed attribution",
      companyId: OTHER_COMPANY,
      createdByType: "system",
      createdById: "forged-user",
    }, forged);
    expect((await fixture.db.query(`SELECT created_by_type, created_by_id FROM ${NS}.change_sets WHERE id = $1`, [created.id])).rows[0]).toEqual({
      created_by_type: "user",
      created_by_id: "test-user",
    });
  });

  it("records a conclusion and status atomically and returns the same conclusion on retry", async () => {
    const set = await createSet("Conclusion");
    const request = { changeSetId: set.id, outcome: "proven", confidence: "moderate", summary: "Repeated request" };
    const first = await fixture.action<{ id: string }>("add-conclusion", request);
    const second = await fixture.action<{ id: string }>("add-conclusion", request);
    expect(second.id).toBe(first.id);
    expect((await fixture.db.query(`SELECT count(*)::int AS count FROM ${NS}.change_conclusions WHERE change_set_id = $1`, [set.id])).rows[0]!.count).toBe(1);
    expect((await fixture.db.query(`SELECT status FROM ${NS}.change_sets WHERE id = $1`, [set.id])).rows[0]!.status).toBe("proven");

    await fixture.db.exec(`CREATE FUNCTION public.fail_conclusion_status_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'regressed' THEN RAISE EXCEPTION 'injected interruption'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_conclusion_status_update BEFORE UPDATE ON ${NS}.change_sets FOR EACH ROW EXECUTE FUNCTION public.fail_conclusion_status_update();`);
    await expect(fixture.action("add-conclusion", { changeSetId: set.id, outcome: "regressed", summary: "Must roll back" })).rejects.toThrow("injected interruption");
    expect((await fixture.db.query(`SELECT count(*)::int AS count FROM ${NS}.change_conclusions WHERE change_set_id = $1`, [set.id])).rows[0]!.count).toBe(1);
    await fixture.db.exec(`DROP TRIGGER fail_conclusion_status_update ON ${NS}.change_sets; DROP FUNCTION public.fail_conclusion_status_update();`);
  });

  it("merges provenance atomically, retains source-to-target history, and safely retries", async () => {
    const source = await createSet("Source");
    const target = await createSet("Target");
    await fixture.db.query(
      `INSERT INTO ${NS}.change_items (id, company_id, change_set_id, entity_type, entity_id, change_kind, source_type, source_ref) VALUES (gen_random_uuid(), $1, $2, 'agent', $3, 'updated', 'test', 'item-1')`,
      [COMPANY, source.id, AGENT],
    );
    await fixture.action("add-evidence", { changeSetId: source.id, evidenceType: "observation", referenceId: "run-1" });
    await fixture.action("add-link", { changeSetId: source.id, linkType: "issue", referenceId: "ISSUE-1" });
    await fixture.action("add-conclusion", { changeSetId: source.id, outcome: "inconclusive", summary: "Observed" });
    await fixture.db.query(`INSERT INTO ${NS}.change_metrics (id, company_id, change_set_id, metric_key) VALUES (gen_random_uuid(), $1, $2, 'cost')`, [COMPANY, source.id]);

    await fixture.db.exec(`CREATE FUNCTION public.fail_source_merge_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id = '${source.id}'::uuid THEN RAISE EXCEPTION 'injected merge interruption'; END IF; RETURN OLD; END $$; CREATE TRIGGER fail_source_merge_delete BEFORE DELETE ON ${NS}.change_sets FOR EACH ROW EXECUTE FUNCTION public.fail_source_merge_delete();`);
    await expect(fixture.action("merge-change-set", { sourceChangeSetId: source.id, targetChangeSetId: target.id })).rejects.toThrow("injected merge interruption");
    expect((await fixture.db.query(`SELECT id FROM ${NS}.change_sets WHERE company_id = $1 AND id = $2`, [COMPANY, source.id])).rows).toHaveLength(1);
    expect((await fixture.db.query(`SELECT count(*)::int AS count FROM ${NS}.change_items WHERE company_id = $1 AND change_set_id = $2`, [COMPANY, source.id])).rows[0]!.count).toBe(1);
    await fixture.db.exec(`DROP TRIGGER fail_source_merge_delete ON ${NS}.change_sets; DROP FUNCTION public.fail_source_merge_delete();`);

    await expect(fixture.action("merge-change-set", { sourceChangeSetId: source.id, targetChangeSetId: target.id })).resolves.toMatchObject({ ok: true, alreadyMerged: false });
    await expect(fixture.action("merge-change-set", { sourceChangeSetId: source.id, targetChangeSetId: target.id })).resolves.toMatchObject({ ok: true, alreadyMerged: true });
    expect((await fixture.db.query(`SELECT id FROM ${NS}.change_sets WHERE company_id = $1 AND id = $2`, [COMPANY, source.id])).rows).toHaveLength(0);
    expect((await fixture.db.query(`SELECT count(*)::int AS count FROM ${NS}.change_items WHERE company_id = $1 AND change_set_id = $2`, [COMPANY, target.id])).rows[0]!.count).toBe(1);
    expect((await fixture.db.query(`SELECT count(*)::int AS count FROM ${NS}.change_evidence WHERE company_id = $1 AND change_set_id = $2`, [COMPANY, target.id])).rows[0]!.count).toBe(1);
    expect((await fixture.db.query(`SELECT count(*)::int AS count FROM ${NS}.change_links WHERE company_id = $1 AND change_set_id = $2`, [COMPANY, target.id])).rows[0]!.count).toBe(1);
    expect((await fixture.db.query(`SELECT count(*)::int AS count FROM ${NS}.change_conclusions WHERE company_id = $1 AND change_set_id = $2`, [COMPANY, target.id])).rows[0]!.count).toBe(1);
    expect((await fixture.db.query(`SELECT target_change_set_id FROM ${NS}.merge_operations WHERE company_id = $1 AND source_change_set_id = $2`, [COMPANY, source.id])).rows[0]!.target_change_set_id).toBe(target.id);
  });

  it("moves only selected items, preserves source evidence, and retries after metric interruption", async () => {
    const source = await createSet("Research source");
    const target = await createSet("Relevant changes");
    const selectedAgentItem = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const secondSelectedAgentItem = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    const thirdSelectedAgentItem = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
    const retainedIssueItem = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
    await fixture.db.query(
      `INSERT INTO ${NS}.change_items (id, company_id, change_set_id, entity_type, entity_id, change_kind, source_type, source_ref) VALUES ` +
        `($1, $2, $3, 'agent', $4, 'updated', 'test', 'selected-agent'), ` +
        `($5, $2, $3, 'agent', $4, 'updated', 'test', 'second-selected-agent'), ` +
        `($6, $2, $3, 'agent', $4, 'updated', 'test', 'third-selected-agent'), ` +
        `($7, $2, $3, 'issue', 'ISSUE-7', 'updated', 'test', 'retained-issue')`,
      [selectedAgentItem, COMPANY, source.id, AGENT, secondSelectedAgentItem, thirdSelectedAgentItem, retainedIssueItem],
    );
    await fixture.action("add-evidence", { changeSetId: source.id, evidenceType: "observation", referenceId: "source-note" });
    await fixture.action("add-conclusion", { changeSetId: source.id, outcome: "inconclusive", summary: "Source context" });

    await fixture.db.exec(
      `CREATE FUNCTION public.fail_selected_move_metric_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ` +
        `IF NEW.change_set_id = '${source.id}'::uuid THEN RAISE EXCEPTION 'injected metric interruption'; END IF; RETURN NEW; END $$; ` +
        `CREATE TRIGGER fail_selected_move_metric_update BEFORE INSERT OR UPDATE ON ${NS}.change_metrics ` +
        `FOR EACH ROW EXECUTE FUNCTION public.fail_selected_move_metric_update();`,
    );
    const request = { sourceChangeSetId: source.id, targetChangeSetId: target.id, changeItemIds: [selectedAgentItem] };
    await expect(fixture.action("move-selected-change-items", request)).rejects.toThrow("injected metric interruption");
    expect((await fixture.db.query(`SELECT id FROM ${NS}.change_sets WHERE company_id = $1 AND id IN ($2, $3)`, [COMPANY, source.id, target.id])).rows).toHaveLength(2);
    expect((await fixture.db.query(`SELECT change_set_id FROM ${NS}.change_items WHERE id = $1`, [selectedAgentItem])).rows[0]!.change_set_id).toBe(target.id);
    expect((await fixture.db.query(`SELECT change_set_id FROM ${NS}.change_items WHERE id = $1`, [secondSelectedAgentItem])).rows[0]!.change_set_id).toBe(source.id);
    expect((await fixture.db.query(`SELECT change_set_id FROM ${NS}.change_items WHERE id = $1`, [thirdSelectedAgentItem])).rows[0]!.change_set_id).toBe(source.id);
    expect((await fixture.db.query(`SELECT count(*)::int AS count FROM ${NS}.change_evidence WHERE company_id = $1 AND change_set_id = $2`, [COMPANY, source.id])).rows[0]!.count).toBe(1);
    expect((await fixture.db.query(`SELECT count(*)::int AS count FROM ${NS}.change_conclusions WHERE company_id = $1 AND change_set_id = $2`, [COMPANY, source.id])).rows[0]!.count).toBe(1);
    expect((await fixture.db.query(`SELECT metadata->'movedItemIds' AS ids FROM ${NS}.change_links WHERE company_id = $1 AND change_set_id = $2 AND link_type = 'change_set' AND reference_id = $3`, [COMPANY, target.id, source.id])).rows).toHaveLength(1);

    await fixture.db.exec(`DROP TRIGGER fail_selected_move_metric_update ON ${NS}.change_metrics; DROP FUNCTION public.fail_selected_move_metric_update();`);
    await expect(fixture.action("move-selected-change-items", request)).resolves.toMatchObject({ ok: true, selectedCount: 1 });
    await expect(fixture.action("move-selected-change-items", {
      ...request, changeItemIds: [secondSelectedAgentItem, thirdSelectedAgentItem],
    })).resolves.toMatchObject({ ok: true, selectedCount: 2 });
    const provenance = await fixture.db.query<{ ids: string[] }>(
      `SELECT metadata->'movedItemIds' AS ids FROM ${NS}.change_links WHERE company_id = $1 AND change_set_id = $2 AND link_type = 'change_set' AND reference_id = $3`,
      [COMPANY, target.id, source.id],
    );
    expect(provenance.rows).toHaveLength(1);
    expect(provenance.rows[0]!.ids).toEqual([selectedAgentItem, secondSelectedAgentItem, thirdSelectedAgentItem]);
    expect((await fixture.db.query(`SELECT change_set_id FROM ${NS}.change_items WHERE id = $1`, [retainedIssueItem])).rows[0]!.change_set_id).toBe(source.id);
    expect((await fixture.db.query(`SELECT count(*)::int AS count FROM ${NS}.change_metrics WHERE company_id = $1 AND change_set_id = $2`, [COMPANY, target.id])).rows[0]!.count).toBeGreaterThan(0);
  });

  it("rejects selected items outside the source/target company scope without partial moves", async () => {
    const source = await createSet("Own source");
    const target = await createSet("Own target");
    const otherActor: PluginPerformActionContext = {
      actor: { type: "user", userId: "other-user", agentId: null, runId: null, companyId: OTHER_COMPANY },
      companyId: OTHER_COMPANY,
    };
    const other = await createSet("Other company", OTHER_COMPANY, otherActor);
    const ownItem = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    const foreignItem = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
    await fixture.db.query(
      `INSERT INTO ${NS}.change_items (id, company_id, change_set_id, entity_type, entity_id, change_kind, source_type, source_ref) VALUES ` +
        `($1, $2, $3, 'issue', 'ISSUE-OWN', 'updated', 'test', 'own-item'), ` +
        `($4, $5, $6, 'issue', 'ISSUE-OTHER', 'updated', 'test', 'foreign-item')`,
      [ownItem, COMPANY, source.id, foreignItem, OTHER_COMPANY, other.id],
    );
    await expect(fixture.action("move-selected-change-items", {
      sourceChangeSetId: source.id, targetChangeSetId: target.id, changeItemIds: [ownItem, foreignItem],
    })).rejects.toThrow("Every selected change item must belong to the source or target Change Set");
    expect((await fixture.db.query(`SELECT change_set_id FROM ${NS}.change_items WHERE id = $1`, [ownItem])).rows[0]!.change_set_id).toBe(source.id);
    expect((await fixture.db.query(`SELECT count(*)::int AS count FROM ${NS}.change_links WHERE company_id = $1 AND change_set_id = $2`, [COMPANY, target.id])).rows[0]!.count).toBe(0);
    await expect(fixture.action("move-selected-change-items", {
      sourceChangeSetId: source.id, targetChangeSetId: target.id, changeItemIds: ["not-a-uuid"],
    })).rejects.toThrow("changeItemIds must contain valid UUIDs");
    await expect(fixture.action("move-selected-change-items", {
      sourceChangeSetId: source.id, targetChangeSetId: target.id, changeItemIds: Array.from({ length: 201 }, () => ownItem),
    })).rejects.toThrow("between 1 and 200 UUIDs");
  });

  it("qualifies every Evolution table against its namespace and preserves core schema names", async () => {
    await createSet("Namespace scoped");
    expect(fixture.logs.some((sql) => sql.includes(`${NS}.change_sets`))).toBe(true);
    expect(fixture.logs.some((sql) => /\b(?:FROM|INTO|UPDATE)\s+(?:public\.)?change_sets\b/i.test(sql))).toBe(false);
  });
});
