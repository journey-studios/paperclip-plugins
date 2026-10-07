import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPANY, createWorkerFixture } from "./worker-fixture.js";
import { queryCostStats, queryRunStats } from "../src/worker.js";

const AGENT = "33333333-3333-4333-8333-333333333333";
const SKILL = "44444444-4444-4444-8444-444444444444";
let fixture: Awaited<ReturnType<typeof createWorkerFixture>>;

beforeEach(async () => {
  fixture = await createWorkerFixture();
  await fixture.db.query(
    "INSERT INTO public.agents (id, company_id, name, updated_at) VALUES ($1, $2, 'Research Analyst', '2026-10-07T12:00:00Z')",
    [AGENT, COMPANY],
  );
});

afterEach(async () => fixture.close());

describe("Evolution capture and metrics", () => {
  it("keeps an instruction event separate from a nearby config revision and labels its historical snapshot partial", async () => {
    await fixture.db.query(
      "INSERT INTO public.agent_config_revisions (id, company_id, agent_id, changed_keys, before_config, after_config, created_at) " +
        "VALUES ($1, $2, $3, '[\"name\"]'::jsonb, '{\"name\":\"Old\"}'::jsonb, '{\"name\":\"New\"}'::jsonb, $4::timestamptz)",
      ["55555555-5555-4555-8555-555555555555", COMPANY, AGENT, "2026-10-07T12:00:01Z"],
    );
    const handler = fixture.events.get("activity.logged");
    expect(handler).toBeDefined();
    await handler!({
      eventId: "plugin-event-1",
      eventType: "activity.logged",
      occurredAt: "2026-10-07T12:00:00Z",
      companyId: COMPANY,
      actorType: "user",
      actorId: "test-user",
      entityType: "agent",
      entityId: AGENT,
      payload: { activityId: "66666666-6666-4666-8666-666666666666", activityAction: "agent.instructions_updated", instructionFile: "AGENTS.md" },
    });

    const items = (await fixture.db.query(
      `SELECT source_type AS "sourceType", source_ref AS "sourceRef", source_activity_id AS "sourceActivityId", after_snapshot_id AS "afterSnapshotId" FROM ${"plugin_evolution_4399b11512"}.change_items`,
    )).rows;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceType: "activity",
      sourceRef: "66666666-6666-4666-8666-666666666666",
      sourceActivityId: "66666666-6666-4666-8666-666666666666",
    });
    const snapshot = (await fixture.db.query(
      `SELECT snapshot FROM ${"plugin_evolution_4399b11512"}.change_snapshots WHERE id = $1`,
      [items[0]!.afterSnapshotId],
    )).rows[0]!.snapshot as Record<string, unknown>;
    expect(snapshot.activity).toMatchObject({
      action: "agent.instructions_updated",
      partialSnapshot: true,
      partialReason: "historical_instruction_content_unavailable",
      currentStateUpdatedAt: "2026-10-07T12:00:00.000Z",
    });
  });

  it("captures supported Skill changes and managed Skill actions only for company_skill entities", async () => {
    await fixture.db.query(
      "INSERT INTO public.company_skills (id, company_id, key, slug, name, description, markdown, source_type, compatibility, categories, updated_at) " +
        "VALUES ($1, $2, 'research', 'research', 'Research', 'Evidence skill', '# Research', 'managed', 'all', '{}', '2026-10-07T12:00:00Z')",
      [SKILL, COMPANY],
    );
    const handler = fixture.events.get("activity.logged")!;
    for (const [index, activityAction] of ["company.skill_updated", "company.skill_version_created", "plugin.managed_skill.reconciled"].entries()) {
      await handler({
        eventId: `skill-event-${index}`,
        eventType: "activity.logged",
        occurredAt: "2026-10-07T12:00:00Z",
        companyId: COMPANY,
        actorType: "user",
        actorId: "test-user",
        entityType: "company_skill",
        entityId: SKILL,
        payload: { activityId: `skill-activity-${index}`, activityAction },
      });
    }

    const items = (await fixture.db.query<{ entityType: string; changeKind: string }>(
      `SELECT entity_type AS "entityType", change_kind AS "changeKind" FROM ${"plugin_evolution_4399b11512"}.change_items ORDER BY change_kind`,
    )).rows;
    expect(items).toEqual([
      { entityType: "skill", changeKind: "company.skill_updated" },
      { entityType: "skill", changeKind: "company.skill_version_created" },
      { entityType: "skill", changeKind: "plugin.managed_skill.reconciled" },
    ]);
  });

  it("ignores Skill and Agent prefix activities whose entity types are not supported", async () => {
    const handler = fixture.events.get("activity.logged")!;
    const unsupported = [
      { activityAction: "company.skills_imported", entityType: "company", entityId: COMPANY },
      { activityAction: "company.skill_test_input_created", entityType: "company_skill_test_input", entityId: SKILL },
      { activityAction: "company.skill_comment_created", entityType: "company_skill_comment", entityId: SKILL },
      { activityAction: "agent.budget_updated", entityType: "company", entityId: COMPANY },
      { activityAction: "plugin.managed_agent.reset", entityType: "company_skill", entityId: SKILL },
    ];
    for (const [index, item] of unsupported.entries()) {
      await handler({
        eventId: `ignored-event-${index}`,
        eventType: "activity.logged",
        occurredAt: "2026-10-07T12:00:00Z",
        companyId: COMPANY,
        actorType: "user",
        actorId: "test-user",
        ...item,
        payload: { activityId: `ignored-activity-${index}`, activityAction: item.activityAction },
      });
    }

    expect((await fixture.db.query(`SELECT id FROM ${"plugin_evolution_4399b11512"}.change_items`)).rows).toHaveLength(0);
    expect((await fixture.db.query(`SELECT id FROM ${"plugin_evolution_4399b11512"}.change_sets`)).rows).toHaveLength(0);
    expect((await fixture.db.query(`SELECT id FROM ${"plugin_evolution_4399b11512"}.change_snapshots`)).rows).toHaveLength(0);
  });

  it("uses an explicit revision ID for agent.updated even when another revision is nearer", async () => {
    const expectedRevision = "55555555-5555-4555-8555-555555555555";
    const nearerRevision = "77777777-7777-4777-8777-777777777777";
    const activityId = "88888888-8888-4888-8888-888888888888";
    await fixture.db.query(
      "INSERT INTO public.agent_config_revisions (id, company_id, agent_id, changed_keys, before_config, after_config, created_at) VALUES " +
        "($1, $2, $3, '[\"name\"]'::jsonb, '{\"name\":\"Expected before\"}'::jsonb, '{\"name\":\"Expected after\"}'::jsonb, '2026-10-07T11:59:59Z'), " +
        "($4, $2, $3, '[\"name\"]'::jsonb, '{\"name\":\"Nearer before\"}'::jsonb, '{\"name\":\"Nearer after\"}'::jsonb, '2026-10-07T12:00:00Z')",
      [expectedRevision, COMPANY, AGENT, nearerRevision],
    );
    await fixture.events.get("agent.updated")!({
      eventId: "agent-update-explicit",
      eventType: "agent.updated",
      occurredAt: "2026-10-07T12:00:00Z",
      companyId: COMPANY,
      actorType: "user",
      actorId: "test-user",
      entityType: "agent",
      entityId: AGENT,
      payload: { revisionId: nearerRevision, configRevisionId: expectedRevision, activityId },
    });

    const item = (await fixture.db.query<{ sourceRef: string; sourceActivityId: string; metadata: Record<string, unknown>; afterSnapshotId: string }>(
      `SELECT source_ref AS "sourceRef", source_activity_id AS "sourceActivityId", metadata, after_snapshot_id AS "afterSnapshotId" FROM ${"plugin_evolution_4399b11512"}.change_items`,
    )).rows[0]!;
    expect(item).toMatchObject({
      sourceRef: expectedRevision,
      sourceActivityId: activityId,
      metadata: { activityAssociation: "explicit_revision_id" },
    });
    expect((await fixture.db.query(`SELECT snapshot FROM ${"plugin_evolution_4399b11512"}.change_snapshots WHERE id = $1`, [item.afterSnapshotId])).rows[0]!.snapshot)
      .toEqual({ name: "Expected after" });
  });

  it("keeps concurrent temporal candidates separate by plugin event without Audit or run links", async () => {
    const revisionId = "55555555-5555-4555-8555-555555555555";
    await fixture.db.query(
      "INSERT INTO public.agent_config_revisions (id, company_id, agent_id, changed_keys, before_config, after_config, created_at) " +
        "VALUES ($1, $2, $3, '[\"name\"]'::jsonb, '{\"name\":\"Old\"}'::jsonb, '{\"name\":\"New\"}'::jsonb, '2026-10-07T12:00:01Z')",
      [revisionId, COMPANY, AGENT],
    );
    const handler = fixture.events.get("agent.updated")!;
    const event = (eventId: string, activityId: string) => ({
      eventId,
      eventType: "agent.updated",
      occurredAt: "2026-10-07T12:00:00Z",
      companyId: COMPANY,
      actorType: "user",
      actorId: "test-user",
      entityType: "agent",
      entityId: AGENT,
      payload: { activityId, runId: "77777777-7777-4777-8777-777777777777" },
    });
    await Promise.all([
      handler(event("agent-update-temporal-1", "66666666-6666-4666-8666-666666666666")),
      handler(event("agent-update-temporal-2", "88888888-8888-4888-8888-888888888888")),
    ]);

    const items = (await fixture.db.query<{ sourceRef: string; sourceType: string; sourceActivityId: string | null; metadata: Record<string, unknown>; afterSnapshotId: string; changeSetId: string }>(
      `SELECT source_ref AS "sourceRef", source_type AS "sourceType", source_activity_id AS "sourceActivityId", metadata, after_snapshot_id AS "afterSnapshotId", change_set_id AS "changeSetId" FROM ${"plugin_evolution_4399b11512"}.change_items ORDER BY source_ref`,
    )).rows;
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.sourceRef)).toEqual(["agent-update-temporal-1", "agent-update-temporal-2"]);
    for (const item of items) {
      expect(item).toMatchObject({
        sourceType: "plugin_event",
        sourceActivityId: null,
        metadata: { partialSnapshot: true, activityAssociation: "temporal_candidate", candidateRevisionId: revisionId, matchWindowSeconds: 10 },
      });
      expect((await fixture.db.query(`SELECT snapshot FROM ${"plugin_evolution_4399b11512"}.change_snapshots WHERE id = $1`, [item.afterSnapshotId])).rows[0]!.snapshot)
        .toEqual({ name: "New" });
      expect((await fixture.db.query(`SELECT id FROM ${"plugin_evolution_4399b11512"}.change_links WHERE change_set_id = $1`, [item.changeSetId])).rows)
        .toHaveLength(0);
    }
  });

  it("deduplicates the same temporal event before snapshots or sets even after native backfill and curation", async () => {
    const revisionId = "55555555-5555-4555-8555-555555555555";
    const activityId = "66666666-6666-4666-8666-666666666666";
    await fixture.db.query(
      "INSERT INTO public.agent_config_revisions (id, company_id, agent_id, changed_keys, before_config, after_config, created_at) " +
        "VALUES ($1, $2, $3, '[\"name\"]'::jsonb, '{\"name\":\"Old\"}'::jsonb, '{\"name\":\"New\"}'::jsonb, '2026-10-07T12:00:01Z')",
      [revisionId, COMPANY, AGENT],
    );
    const event = {
      eventId: "agent-update-temporal",
      eventType: "agent.updated",
      occurredAt: "2026-10-07T12:00:00Z",
      companyId: COMPANY,
      actorType: "user",
      actorId: "test-user",
      entityType: "agent",
      entityId: AGENT,
      payload: { activityId },
    };
    await fixture.events.get("agent.updated")!(event);
    await fixture.action("backfill-recent", { days: 7 });
    const temporalItem = (await fixture.db.query<{ id: string; changeSetId: string }>(
      `SELECT id, change_set_id AS "changeSetId" FROM ${"plugin_evolution_4399b11512"}.change_items WHERE source_type = 'plugin_event' AND source_ref = $1`,
      [event.eventId],
    )).rows[0]!;
    const target = await fixture.action<{ id: string }>("create-change-set", { title: "Curated revision event" });
    await fixture.action("move-selected-change-items", {
      sourceChangeSetId: temporalItem.changeSetId,
      targetChangeSetId: target.id,
      changeItemIds: [temporalItem.id],
    });
    const beforeReplay = await fixture.db.query<{ snapshots: number; sets: number }>(
      `SELECT (SELECT count(*)::int FROM ${"plugin_evolution_4399b11512"}.change_snapshots) AS snapshots, (SELECT count(*)::int FROM ${"plugin_evolution_4399b11512"}.change_sets) AS sets`,
    );
    await fixture.events.get("agent.updated")!(event);
    const afterReplay = await fixture.db.query<{ snapshots: number; sets: number }>(
      `SELECT (SELECT count(*)::int FROM ${"plugin_evolution_4399b11512"}.change_snapshots) AS snapshots, (SELECT count(*)::int FROM ${"plugin_evolution_4399b11512"}.change_sets) AS sets`,
    );
    expect(afterReplay.rows).toEqual(beforeReplay.rows);
    expect((await fixture.db.query<{ changeSetId: string }>(
      `SELECT change_set_id AS "changeSetId" FROM ${"plugin_evolution_4399b11512"}.change_items WHERE id = $1`, [temporalItem.id],
    )).rows[0]!.changeSetId).toBe(target.id);
    expect((await fixture.db.query<{ sourceRef: string }>(
      `SELECT source_ref AS "sourceRef" FROM ${"plugin_evolution_4399b11512"}.change_items WHERE source_type = 'agent_config_revision' AND source_ref = $1`,
      [revisionId],
    )).rows).toHaveLength(1);
  });

  it("does not temporally match when an explicit revision ID is invalid and timestamps current state honestly", async () => {
    await fixture.events.get("agent.updated")!({
      eventId: "agent-update-invalid-id",
      eventType: "agent.updated",
      occurredAt: "2026-10-07T12:00:00Z",
      companyId: COMPANY,
      actorType: "user",
      actorId: "test-user",
      entityType: "agent",
      entityId: AGENT,
      payload: { configRevisionId: "55555555-5555-4555-8555-555555555555", activityId: "66666666-6666-4666-8666-666666666666" },
    });
    const row = (await fixture.db.query<{ sourceType: string; sourceActivityId: string | null; capturedAt: string; afterSnapshotId: string }>(
      `SELECT ci.source_type AS "sourceType", ci.source_activity_id AS "sourceActivityId", s.captured_at AS "capturedAt", ci.after_snapshot_id AS "afterSnapshotId" FROM ${"plugin_evolution_4399b11512"}.change_items ci JOIN ${"plugin_evolution_4399b11512"}.change_snapshots s ON s.id = ci.after_snapshot_id`,
    )).rows[0]!;
    expect(row.sourceType).toBe("plugin_event");
    expect(row.sourceActivityId).toBe("66666666-6666-4666-8666-666666666666");
    expect(row.capturedAt).not.toBe("2026-10-07T12:00:00.000Z");
    const snapshot = (await fixture.db.query(`SELECT snapshot FROM ${"plugin_evolution_4399b11512"}.change_snapshots WHERE id = $1`, [row.afterSnapshotId])).rows[0]!.snapshot as Record<string, unknown>;
    expect(snapshot.activity).toMatchObject({ partialSnapshot: true, partialReason: "activity_snapshot_is_current_state" });
    expect(typeof snapshot.activity.currentStateReadAt).toBe("string");
  });

  it("does not mistake a generic rollback revisionId target for the applied rollback revision", async () => {
    const rollbackTargetRevision = "55555555-5555-4555-8555-555555555555";
    const rollbackTransitionRevision = "77777777-7777-4777-8777-777777777777";
    await fixture.db.query(
      "INSERT INTO public.agent_config_revisions (id, company_id, agent_id, changed_keys, before_config, after_config, created_at) VALUES " +
        "($1, $2, $3, '[\"name\"]'::jsonb, '{\"name\":\"Before target\"}'::jsonb, '{\"name\":\"Target old state\"}'::jsonb, '2026-10-07T11:59:00Z'), " +
        "($4, $2, $3, '[\"name\"]'::jsonb, '{\"name\":\"Before rollback\"}'::jsonb, '{\"name\":\"Restored state\"}'::jsonb, '2026-10-07T12:00:00Z')",
      [rollbackTargetRevision, COMPANY, AGENT, rollbackTransitionRevision],
    );
    await fixture.events.get("activity.logged")!({
      eventId: "plugin-event-2",
      eventType: "activity.logged",
      occurredAt: "2026-10-07T12:00:00Z",
      companyId: COMPANY,
      actorType: "user",
      actorId: "test-user",
      entityType: "agent",
      entityId: AGENT,
      payload: { activityId: "88888888-8888-4888-8888-888888888888", activityAction: "agent.config_rolled_back", revisionId: rollbackTargetRevision },
    });

    const row = (await fixture.db.query<{ sourceType: string; sourceRef: string; sourceActivityId: string; afterSnapshotId: string }>(
      `SELECT source_type AS "sourceType", source_ref AS "sourceRef", source_activity_id AS "sourceActivityId", after_snapshot_id AS "afterSnapshotId" FROM ${"plugin_evolution_4399b11512"}.change_items WHERE source_type = 'activity'`,
    )).rows[0]!;
    expect(row).toMatchObject({
      sourceType: "activity",
      sourceRef: "88888888-8888-4888-8888-888888888888",
      sourceActivityId: "88888888-8888-4888-8888-888888888888",
    });
    const snapshot = (await fixture.db.query(
      `SELECT snapshot FROM ${"plugin_evolution_4399b11512"}.change_snapshots WHERE id = $1`,
      [row.afterSnapshotId],
    )).rows[0]!.snapshot as Record<string, unknown>;
    expect(snapshot.activity).toMatchObject({
      action: "agent.config_rolled_back",
      partialSnapshot: true,
      partialReason: "activity_snapshot_is_current_state",
    });
    expect((await fixture.db.query(
      `SELECT id FROM ${"plugin_evolution_4399b11512"}.change_items WHERE source_type = 'agent_config_revision' AND source_ref = $1`,
      [rollbackTargetRevision],
    )).rows).toHaveLength(0);
    expect((await fixture.db.query(
      `SELECT id FROM ${"plugin_evolution_4399b11512"}.change_items WHERE source_type = 'agent_config_revision' AND source_ref = $1`,
      [rollbackTransitionRevision],
    )).rows).toHaveLength(0);

    await fixture.events.get("activity.logged")!({
      eventId: "plugin-event-rollback-explicit",
      eventType: "activity.logged",
      occurredAt: "2026-10-07T12:00:00Z",
      companyId: COMPANY,
      actorType: "user",
      actorId: "test-user",
      entityType: "agent",
      entityId: AGENT,
      payload: {
        activityId: "99999999-9999-4999-8999-999999999999",
        activityAction: "agent.config_rolled_back",
        revisionId: rollbackTargetRevision,
        configRevisionId: rollbackTransitionRevision,
      },
    });
    const applied = (await fixture.db.query<{ sourceRef: string; sourceActivityId: string; afterSnapshotId: string }>(
      `SELECT source_ref AS "sourceRef", source_activity_id AS "sourceActivityId", after_snapshot_id AS "afterSnapshotId" FROM ${"plugin_evolution_4399b11512"}.change_items WHERE source_type = 'agent_config_revision'`,
    )).rows[0]!;
    expect(applied).toMatchObject({ sourceRef: rollbackTransitionRevision, sourceActivityId: "99999999-9999-4999-8999-999999999999" });
    expect((await fixture.db.query(
      `SELECT snapshot FROM ${"plugin_evolution_4399b11512"}.change_snapshots WHERE id = $1`, [applied.afterSnapshotId],
    )).rows[0]!.snapshot).toEqual({ name: "Restored state" });
  });

  it("does not create empty Change Sets when backfill finds an existing source item", async () => {
    const revisionId = "55555555-5555-4555-8555-555555555555";
    const versionId = "99999999-9999-4999-8999-999999999999";
    const activityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const set = await fixture.action<{ id: string }>("create-change-set", { title: "Existing history" });
    await fixture.db.query(
      "INSERT INTO public.agent_config_revisions (id, company_id, agent_id, changed_keys, before_config, after_config, created_by_user_id, created_at) " +
        "VALUES ($1, $2, $3, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, 'test-user', now())",
      [revisionId, COMPANY, AGENT],
    );
    await fixture.db.query(
      "INSERT INTO public.company_skills (id, company_id, key, slug, name, description, markdown, source_type, source_ref, compatibility, categories, current_version_id, updated_at) " +
        "VALUES ($1, $2, 'research', 'research', 'Research', '', '', 'managed', null, 'all', '{}', null, now())",
      [SKILL, COMPANY],
    );
    await fixture.db.query(
      "INSERT INTO public.company_skill_versions (id, company_id, company_skill_id, revision_number, file_inventory, author_user_id, created_at) " +
        "VALUES ($1, $2, $3, 1, '[]'::jsonb, 'test-user', now())",
      [versionId, COMPANY, SKILL],
    );
    await fixture.db.query(
      "INSERT INTO public.activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, run_id, details, created_at) " +
        "VALUES ($1, $2, 'user', 'test-user', 'agent.budget_updated', 'agent', $3, null, null, '{}'::jsonb, now())",
      [activityId, COMPANY, AGENT],
    );
    await fixture.db.query(
      `INSERT INTO ${"plugin_evolution_4399b11512"}.change_items (id, company_id, change_set_id, entity_type, entity_id, change_kind, source_type, source_ref) VALUES ` +
        "(gen_random_uuid(), $1, $2, 'agent', $3, 'updated', 'agent_config_revision', $4), " +
        "(gen_random_uuid(), $1, $2, 'skill', $5, 'version', 'company_skill_version', $6), " +
        "(gen_random_uuid(), $1, $2, 'agent', $3, 'budget', 'activity', $7)",
      [COMPANY, set.id, AGENT, revisionId, SKILL, versionId, activityId],
    );
    const before = Number((await fixture.db.query(`SELECT count(*)::int AS count FROM ${"plugin_evolution_4399b11512"}.change_sets WHERE company_id = $1`, [COMPANY])).rows[0]!.count);

    const result = await fixture.action<{ agentItems: number; skillItems: number; activityItems: number }>("backfill-recent", { days: 7 });

    const after = Number((await fixture.db.query(`SELECT count(*)::int AS count FROM ${"plugin_evolution_4399b11512"}.change_sets WHERE company_id = $1`, [COMPANY])).rows[0]!.count);
    expect(result).toMatchObject({ agentItems: 0, skillItems: 0, activityItems: 0 });
    expect(after).toBe(before);
  });

  it("backfills rollback Audit with a partial activity snapshot when only the target revision ID exists", async () => {
    const targetRevision = "55555555-5555-4555-8555-555555555555";
    const appliedRevision = "77777777-7777-4777-8777-777777777777";
    const activityId = "88888888-8888-4888-8888-888888888888";
    await fixture.db.query(
      "INSERT INTO public.agent_config_revisions (id, company_id, agent_id, changed_keys, before_config, after_config, created_at) VALUES " +
        "($1, $2, $3, '[\"name\"]'::jsonb, '{\"name\":\"Old\"}'::jsonb, '{\"name\":\"Target\"}'::jsonb, now() - interval '1 second'), " +
        "($4, $2, $3, '[\"name\"]'::jsonb, '{\"name\":\"Current\"}'::jsonb, '{\"name\":\"Restored\"}'::jsonb, now())",
      [targetRevision, COMPANY, AGENT, appliedRevision],
    );
    await fixture.db.query(
      "INSERT INTO public.activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, run_id, details, created_at) " +
        "VALUES ($1, $2, 'user', 'test-user', 'agent.config_rolled_back', 'agent', $3, null, null, $4::jsonb, now())",
      [activityId, COMPANY, AGENT, JSON.stringify({ revisionId: targetRevision })],
    );

    await fixture.action("backfill-recent", { days: 7 });

    const activity = (await fixture.db.query<{ sourceRef: string; sourceActivityId: string; afterSnapshotId: string }>(
      `SELECT source_ref AS "sourceRef", source_activity_id AS "sourceActivityId", after_snapshot_id AS "afterSnapshotId" FROM ${"plugin_evolution_4399b11512"}.change_items WHERE source_type = 'activity'`,
    )).rows[0]!;
    expect(activity).toMatchObject({ sourceRef: activityId, sourceActivityId: activityId });
    expect((await fixture.db.query(
      `SELECT snapshot FROM ${"plugin_evolution_4399b11512"}.change_snapshots WHERE id = $1`, [activity.afterSnapshotId],
    )).rows[0]!.snapshot).toMatchObject({
      activity: { action: "agent.config_rolled_back", partialSnapshot: true, partialReason: "activity_snapshot_is_current_state" },
    });
    expect((await fixture.db.query<{ sourceRef: string }>(
      `SELECT source_ref AS "sourceRef" FROM ${"plugin_evolution_4399b11512"}.change_items WHERE source_type = 'agent_config_revision'`,
    )).rows.map((row) => row.sourceRef).sort()).toEqual([targetRevision, appliedRevision].sort());
  });

  it("does not backfill unsupported Skill activities even when their entity is company_skill", async () => {
    await fixture.db.query(
      "INSERT INTO public.company_skills (id, company_id, key, slug, name, description, markdown, source_type, compatibility, categories, updated_at) " +
        "VALUES ($1, $2, 'research', 'research', 'Research', '', '', 'managed', 'all', '{}', now())",
      [SKILL, COMPANY],
    );
    await fixture.db.query(
      "INSERT INTO public.activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id, details, created_at) VALUES " +
        "('66666666-6666-4666-8666-666666666666', $1, 'user', 'test-user', 'company.skill_starred', 'company_skill', $2, '{}'::jsonb, now()), " +
        "('77777777-7777-4777-8777-777777777777', $1, 'user', 'test-user', 'company.skill_comment_created', 'company_skill_comment', $2, '{}'::jsonb, now())",
      [COMPANY, SKILL],
    );

    const result = await fixture.action<{ activityItems: number }>("backfill-recent", { days: 7 });

    expect(result.activityItems).toBe(0);
    expect((await fixture.db.query(`SELECT id FROM ${"plugin_evolution_4399b11512"}.change_sets`)).rows).toHaveLength(0);
    expect((await fixture.db.query(`SELECT id FROM ${"plugin_evolution_4399b11512"}.change_items`)).rows).toHaveLength(0);
  });

  it("validates run evidence and links in-company and attaches canonical run context", async () => {
    const set = await fixture.action<{ id: string }>("create-change-set", { title: "Research run" });
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const issueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const projectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const goalId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await fixture.db.query("INSERT INTO public.goals (id, company_id, title) VALUES ($1, $2, 'Research goal')", [goalId, COMPANY]);
    await fixture.db.query("INSERT INTO public.projects (id, company_id, name, goal_id) VALUES ($1, $2, 'Research project', $3)", [projectId, COMPANY, goalId]);
    await fixture.db.query(
      "INSERT INTO public.issues (id, company_id, identifier, title, project_id, goal_id) VALUES ($1, $2, 'JOU-49', 'Evidence research', $3, $4)",
      [issueId, COMPANY, projectId, goalId],
    );
    await fixture.db.query(
      "INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, native_issue_id, context_snapshot) VALUES ($1, $2, $3, 'succeeded', now(), $4, '{}'::jsonb)",
      [runId, COMPANY, AGENT, issueId],
    );

    await fixture.action("add-link", { changeSetId: set.id, linkType: "run", referenceId: runId, label: "Reviewed run" });
    await fixture.action("add-evidence", { changeSetId: set.id, evidenceType: "run", referenceId: runId, label: "Run evidence" });

    const links = (await fixture.db.query<{ link_type: string; reference_id: string; label: string | null }>(
      `SELECT link_type, reference_id, label FROM ${"plugin_evolution_4399b11512"}.change_links WHERE change_set_id = $1 ORDER BY link_type`,
      [set.id],
    )).rows;
    expect(links).toEqual([
      { link_type: "goal", reference_id: goalId, label: "Research goal" },
      { link_type: "issue", reference_id: issueId, label: "JOU-49 · Evidence research" },
      { link_type: "project", reference_id: projectId, label: "Research project" },
      { link_type: "run", reference_id: runId, label: "Reviewed run" },
    ]);
    expect((await fixture.db.query<{ reference_id: string }>(
      `SELECT reference_id FROM ${"plugin_evolution_4399b11512"}.change_evidence WHERE change_set_id = $1`,
      [set.id],
    )).rows).toEqual([{ reference_id: runId }]);

    await fixture.db.query(
      "INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at) VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', $1, $2, 'succeeded', now())",
      ["22222222-2222-4222-8222-222222222222", AGENT],
    );
    await expect(fixture.action("add-link", {
      changeSetId: set.id,
      linkType: "run",
      referenceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    })).rejects.toThrow("Run not found in authorized company");
    await expect(fixture.action("add-evidence", {
      changeSetId: set.id,
      evidenceType: "run",
      referenceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    })).rejects.toThrow("Run not found in authorized company");
    await expect(fixture.action("add-evidence", {
      changeSetId: set.id,
      evidenceType: "run",
      referenceId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    })).rejects.toThrow("Run not found in authorized company");
    await expect(fixture.action("add-link", {
      changeSetId: set.id,
      linkType: "run",
      referenceId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    })).rejects.toThrow("Run not found in authorized company");
    expect((await fixture.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${"plugin_evolution_4399b11512"}.change_links WHERE change_set_id = $1`,
      [set.id],
    )).rows[0]!.count).toBe(4);
    expect((await fixture.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${"plugin_evolution_4399b11512"}.change_evidence WHERE change_set_id = $1`,
      [set.id],
    )).rows[0]!.count).toBe(1);
  });

  it("excludes unfinished runs from success rate and leaves duration based on finished runs", async () => {
    await fixture.db.query(
      "INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at) VALUES " +
        "('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', $1, $2, 'succeeded', '2026-10-05T10:00:00Z', null), " +
        "('cccccccc-cccc-4ccc-8ccc-cccccccccccc', $1, $2, 'failed', '2026-10-06T10:00:00Z', '2026-10-06T10:10:00Z'), " +
        "('dddddddd-dddd-4ddd-8ddd-dddddddddddd', $1, $2, 'succeeded', '2026-10-06T11:00:00Z', '2026-10-06T11:20:00Z')",
      [COMPANY, AGENT],
    );
    const stats = await queryRunStats(
      fixture.workerCtx,
      COMPANY,
      [AGENT],
      "2026-10-01T00:00:00Z",
      "2026-10-08T00:00:00Z",
    );

    expect(stats).toEqual({ runs: 2, successRate: 50, avgDuration: 900 });
  });

  it("reports cost as unknown when all telemetry is unpriced", async () => {
    await fixture.db.query(
      "INSERT INTO public.cost_events (id, company_id, agent_id, occurred_at, cost_cents, cost_status, input_tokens, cached_input_tokens, output_tokens) " +
        "VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', $1, $2, '2026-10-06T10:00:00Z', 0, 'unpriced', 120, 20, 40)",
      [COMPANY, AGENT],
    );
    const stats = await queryCostStats(
      fixture.workerCtx,
      COMPANY,
      [AGENT],
      "2026-10-01T00:00:00Z",
      "2026-10-08T00:00:00Z",
    );

    expect(stats).toEqual({ costUsd: null, inputTokens: 120, cachedInputTokens: 20, outputTokens: 40, pricedEvents: 0, events: 1 });
  });
});
