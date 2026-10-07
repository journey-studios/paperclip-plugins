import test from "node:test";
import assert from "node:assert/strict";
import esbuild from "esbuild";
import {
  agentActivitySnapshot,
  captureTimestamp,
  isRevisionProducingActivity,
  revisionReferenceFromActivity,
  RUN_METRIC_AGGREGATION_SQL,
  sourceItemExists,
  skillActivitySnapshot,
} from "../plugins/evolution/src/capture.mjs";

const workerBuild = await esbuild.build({
  entryPoints: [new URL("../plugins/evolution/src/worker.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [{
    name: "mock-paperclip-sdk",
    setup(build) {
      build.onResolve({ filter: /^@paperclipai\/plugin-sdk$/ }, () => ({ path: "sdk", namespace: "mock-sdk" }));
      build.onLoad({ filter: /.*/, namespace: "mock-sdk" }, () => ({
        contents: "export const definePlugin = (plugin) => plugin; export function runWorker() {}",
        loader: "js",
      }));
    },
  }],
});
const worker = await import(`data:text/javascript;base64,${Buffer.from(workerBuild.outputFiles[0].text).toString("base64")}`);

test("only rollback activities can inherit an agent config revision", () => {
  assert.equal(isRevisionProducingActivity("agent.config_rolled_back"), true);
  for (const action of [
    "agent.instructions_updated",
    "agent.budget_updated",
    "agent.permissions_updated",
    "agent.skills_synced",
    "agent.status_changed",
  ]) {
    assert.equal(isRevisionProducingActivity(action), false, action);
  }
});

test("revision reference accepts applied revision IDs and rejects rollback target IDs", () => {
  assert.equal(revisionReferenceFromActivity({ agentConfigRevisionId: "rev-7" }), "rev-7");
  assert.equal(revisionReferenceFromActivity({ configRevisionId: "rev-7b" }), "rev-7b");
  assert.equal(revisionReferenceFromActivity({ agent_config_revision_id: " rev-8 " }), "rev-8");
  assert.equal(revisionReferenceFromActivity({ revisionId: "rollback-target-rev" }), null);
  assert.equal(revisionReferenceFromActivity({ revision_id: "rollback-target-rev" }), null);
  assert.equal(revisionReferenceFromActivity({ configRevisionId: "  " }), null);
  assert.equal(revisionReferenceFromActivity({ activityId: "activity-3" }), null);
});

test("activity snapshots identify current-state captures as partial", () => {
  const base = { name: "Research Analyst", permissions: ["read"] };
  const instruction = agentActivitySnapshot(base, "agent.instructions_updated", { path: "AGENTS.md" }, "read-at", null);
  const permission = agentActivitySnapshot(base, "agent.permissions_updated", { added: ["write"] }, "read-at", "updated-at");
  const skill = skillActivitySnapshot({ name: "Research skill" }, "company.skill_updated", {}, "read-at", null);

  assert.equal(instruction.activity.partialSnapshot, true);
  assert.equal(instruction.activity.partialReason, "historical_instruction_content_unavailable");
  assert.deepEqual(instruction.activity.details, { path: "AGENTS.md" });
  assert.equal(instruction.activity.currentStateReadAt, "read-at");
  assert.equal(permission.activity.partialSnapshot, true);
  assert.equal(permission.activity.partialReason, "activity_snapshot_is_current_state");
  assert.equal(permission.activity.currentStateUpdatedAt, "updated-at");
  assert.equal(skill.activity.partialSnapshot, true);
  assert.equal(skill.activity.currentStateReadAt, "read-at");
  assert.deepEqual(permission.permissions, ["read"]);
});

test("capture timestamps preserve provided dates and reject invented fallbacks", () => {
  assert.equal(captureTimestamp("2026-10-07T12:30:00Z"), "2026-10-07T12:30:00.000Z");
  assert.equal(captureTimestamp(new Date("2026-10-07T12:30:00Z")), "2026-10-07T12:30:00.000Z");
  assert.equal(captureTimestamp(undefined), null);
  assert.equal(captureTimestamp("not-a-date"), null);
});

test("backfill source lookup distinguishes existing and missing rows", async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return params[2] === "existing-ref" ? [{ id: "item-1" }] : [];
    },
  };

  assert.equal(await sourceItemExists(db, "company-1", "activity", "existing-ref"), true);
  assert.equal(await sourceItemExists(db, "company-1", "activity", "new-ref"), false);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, ["company-1", "activity", "existing-ref"]);
});

test("run success metrics count only finished runs in the denominator and numerator", () => {
  assert.match(RUN_METRIC_AGGREGATION_SQL, /count\(\*\) FILTER \(WHERE finished_at IS NOT NULL\)::int AS runs/);
  assert.match(RUN_METRIC_AGGREGATION_SQL, /status = 'succeeded' AND finished_at IS NOT NULL/);
});

test("instruction activity stays an activity item even beside a nearby config revision", async () => {
  const queries = [];
  const writes = [];
  const ctx = {
    db: {
      async query(sql, params) {
        queries.push({ sql, params });
        if (sql.includes("FROM public.agents")) return [{
          id: "agent-1", name: "Research Analyst", role: null, title: null, status: "active",
          adapterType: "codex", adapterConfig: {}, runtimeConfig: {}, permissions: {}, capabilities: {},
          defaultEnvironmentId: null, budgetMonthlyCents: 0, updatedAt: "2026-10-07T12:00:00Z",
        }];
        if (sql.includes("FROM public.agent_config_revisions")) return [{
          id: "nearby-revision", changedKeys: ["name"], beforeConfig: { name: "Old" },
          afterConfig: { name: "New" }, createdAt: "2026-10-07T12:00:00Z",
        }];
        if (sql.includes("FROM change_snapshots")) return [];
        if (sql.includes("FROM change_sets")) return [{ id: "set-1" }];
        if (sql.includes("FROM change_items")) return [];
        throw new Error(`Unexpected query: ${sql}`);
      },
      async execute(sql, params) { writes.push({ sql, params }); },
    },
  };

  await worker.recordActivityEvent(ctx, {
    eventId: "plugin-event-1",
    eventType: "activity.logged",
    occurredAt: "2026-10-07T12:00:00Z",
    companyId: "company-1",
    actorType: "user",
    actorId: "user-1",
    entityType: "agent",
    entityId: "agent-1",
    payload: {
      activityId: "activity-1",
      activityAction: "agent.instructions_updated",
      instructionFile: "AGENTS.md",
    },
  });

  assert.equal(queries.some(({ sql }) => sql.includes("FROM public.agent_config_revisions")), false);
  const itemInsert = writes.find(({ sql }) => sql.includes("INSERT INTO change_items"));
  assert.ok(itemInsert);
  assert.equal(itemInsert.params[10], "activity");
  assert.equal(itemInsert.params[11], "activity-1");
  assert.equal(itemInsert.params[12], "activity-1");
  const snapshotInsert = writes.find(({ sql }) => sql.includes("INSERT INTO change_snapshots"));
  const snapshot = JSON.parse(snapshotInsert.params[6]);
  assert.equal(snapshot.activity.partialSnapshot, true);
  assert.equal(snapshot.activity.partialReason, "historical_instruction_content_unavailable");
  assert.equal(snapshot.activity.action, "agent.instructions_updated");
});

test("backfill skips existing revision, skill-version, and activity items before creating sets", async () => {
  const queries = [];
  const executes = [];
  const ctx = {
    db: {
      async query(sql, params) {
        queries.push({ sql, params });
        if (sql.includes("FROM public.agent_config_revisions r JOIN")) return [{
          id: "revision-1", agentId: "agent-1", agentName: "Agent", changedKeys: [], beforeConfig: {}, afterConfig: {},
          createdByAgentId: null, createdByUserId: "user-1", createdAt: "2026-10-07T12:00:00Z",
        }];
        if (sql.includes("FROM public.company_skill_versions v")) return [{
          id: "version-1", skillId: "skill-1", skillName: "Skill", revisionNumber: 1, fileInventory: [],
          authorAgentId: null, authorUserId: "user-1", createdAt: "2026-10-07T12:00:00Z",
        }];
        if (sql.includes("FROM public.activity_log")) return [{
          id: "activity-1", actorType: "user", actorId: "user-1", action: "agent.budget_updated",
          entityType: "agent", entityId: "agent-1", agentId: null, runId: null, details: {}, createdAt: "2026-10-07T12:00:00Z",
        }];
        if (sql.includes("FROM change_items")) return [{ id: "existing-item" }];
        if (sql.includes("FROM change_snapshots")) return [{ id: "existing-snapshot" }];
        throw new Error(`Unexpected query: ${sql}`);
      },
      async execute(sql, params) { executes.push({ sql, params }); },
    },
  };

  const result = await worker.backfill(ctx, "company-1", 7);

  assert.deepEqual(result, { agentItems: 0, skillItems: 0, activityItems: 0, days: 7 });
  assert.equal(queries.some(({ sql }) => sql.includes("FROM change_sets")), false);
  assert.equal(executes.length, 0);
});

test("unpriced or missing cost telemetry never becomes a zero-cost claim", async () => {
  const responses = [
    { costCents: null, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, pricedEvents: 0, events: 0 },
    { costCents: null, inputTokens: 120, cachedInputTokens: 20, outputTokens: 40, pricedEvents: 0, events: 1 },
  ];
  const sqlQueries = [];
  const ctx = { db: { async query(sql) { sqlQueries.push(sql); return [responses.shift()]; } } };

  const missing = await worker.queryCostStats(ctx, "company-1", [], "start", "end");
  const unpriced = await worker.queryCostStats(ctx, "company-1", [], "start", "end");

  assert.equal(missing.costUsd, null);
  assert.equal(missing.inputTokens, null);
  assert.equal(unpriced.costUsd, null);
  assert.equal(unpriced.inputTokens, 120);
  assert.equal(unpriced.events, 1);
  assert.match(sqlQueries[0], /cost_status = 'reported'/);
});
