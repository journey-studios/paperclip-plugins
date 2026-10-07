import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import plugin, {
  attachRunContext,
  backfill,
  ensureChangeSet,
  overview,
  queryCostStats,
  recordActivityEvent,
  recomputeMetrics,
  registerActions,
  sanitize,
} from "../.test-output/worker.mjs";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const CHANGE_SET = "33333333-3333-4333-8333-333333333333";
const NAMESPACE = "plugin_evolution_4399b11512";

function context(query = async () => []) {
  const writes = [];
  const queries = [];
  const actions = new Map();
  const data = new Map();
  const aliases = new Map();
  const contextKey = (params) => JSON.stringify(params.slice(0, 2));
  return {
    ctx: {
      db: {
        namespace: NAMESPACE,
        async query(sql, params) {
          const normalized = sql.replaceAll(NAMESPACE + ".", "");
          queries.push({ sql: normalized, rawSql: sql, params });
          if (normalized.startsWith("SELECT change_set_id AS id FROM change_context_aliases") && aliases.has(contextKey(params))) {
            return [{ id: aliases.get(contextKey(params)) }];
          }
          return query(normalized, params);
        },
        async execute(sql, params) {
          const normalized = sql.replaceAll(NAMESPACE + ".", "");
          writes.push({ sql: normalized, rawSql: sql, params });
          if (normalized.startsWith("INSERT INTO change_context_aliases") && !aliases.has(contextKey(params))) {
            aliases.set(contextKey(params), params[2]);
          }
        },
      },
      actions: { register(name, handler) { actions.set(name, handler); } },
      data: { register(name, handler) { data.set(name, handler); } },
      events: { on() {} },
      logger: { info() {} },
    },
    writes,
    queries,
    actions,
    data,
    aliases,
  };
}

const changeInput = { companyId: COMPANY_A, sourceContextKey: "run:run-1", occurredAt: "2026-10-07T12:00:00Z" };
const aliasKey = JSON.stringify([COMPANY_A, changeInput.sourceContextKey]);

test("context routing uses the merge alias when a stale existing candidate was removed", async () => {
  const target = "44444444-4444-4444-8444-444444444444";
  const fixture = context(async (sql) => {
    if (sql.startsWith("SELECT id FROM change_sets")) {
      // Merge commits after the initial alias miss, before capture registers.
      fixture.aliases.set(aliasKey, target);
      return [{ id: CHANGE_SET }];
    }
    return [];
  });
  assert.equal(await ensureChangeSet(fixture.ctx, changeInput), target);
  assert.equal(fixture.writes.filter(({ sql }) => sql.startsWith("INSERT INTO change_sets")).length, 0);
  assert.equal(fixture.writes.filter(({ sql }) => sql.startsWith("DELETE FROM change_sets")).length, 0);
});

test("context routing cleans only its empty new candidate when a merge wins the alias race", async () => {
  const target = "44444444-4444-4444-8444-444444444444";
  let lookups = 0;
  const fixture = context(async (sql) => {
    if (sql.startsWith("SELECT id FROM change_sets")) {
      if (lookups++ === 0) {
        // Source removal and alias redirect land after capture's first miss.
        fixture.aliases.set(aliasKey, target);
        return [];
      }
      const candidate = fixture.writes.find(({ sql }) => sql.startsWith("INSERT INTO change_sets"));
      return [{ id: candidate.params[0] }];
    }
    return [];
  });
  assert.equal(await ensureChangeSet(fixture.ctx, changeInput), target);
  const creation = fixture.writes.find(({ sql }) => sql.startsWith("INSERT INTO change_sets"));
  const cleanup = fixture.writes.find(({ sql }) => sql.startsWith("DELETE FROM change_sets"));
  assert.deepEqual(cleanup.params, [COMPANY_A, creation.params[0]]);
  for (const table of ["change_items", "change_evidence", "change_conclusions", "change_links", "change_metrics", "change_context_aliases"]) {
    assert.ok(cleanup.sql.includes("AND NOT EXISTS (SELECT 1 FROM " + table + " WHERE company_id = $1 AND change_set_id = $2)"));
  }
  assert.equal(await ensureChangeSet(fixture.ctx, changeInput), target, "replay must preserve the merged destination");
  assert.equal(fixture.writes.filter(({ sql }) => sql.startsWith("INSERT INTO change_sets")).length, 1);
});

test("context routing retries a vanished lookup and remains bounded", async () => {
  const target = "44444444-4444-4444-8444-444444444444";
  let lookups = 0;
  const fixture = context(async (sql) => {
    if (sql.startsWith("SELECT id FROM change_sets") && ++lookups === 2) fixture.aliases.set(aliasKey, target);
    return [];
  });
  assert.equal(await ensureChangeSet(fixture.ctx, changeInput), target);
  assert.equal(lookups, 2);
  const neverResolvable = context();
  await assert.rejects(ensureChangeSet(neverResolvable.ctx, changeInput), /Could not resolve Change Set after concurrent updates/);
  assert.equal(neverResolvable.writes.filter(({ sql }) => sql.startsWith("INSERT INTO change_sets")).length, 3);
});

test("SDK setup forwards queries with the validated plugin namespace", async () => {
  const fixture = context();
  await plugin.definition.setup(fixture.ctx);
  await fixture.data.get("changes-overview")({ companyId: COMPANY_A });
  assert.equal(fixture.queries.length, 2);
  for (const { rawSql } of fixture.queries) {
    assert.match(rawSql, new RegExp("FROM " + NAMESPACE + "\\.change_sets"));
    assert.doesNotMatch(rawSql, /(?:FROM|JOIN) change_/);
  }
});

test("SDK setup rejects unsafe or non-plugin namespaces before registering handlers", async () => {
  for (const namespace of ["public", "plugin_evolution; DROP TABLE public.agents", "plugin_evolution.other", "plugin_" + "a".repeat(57)]) {
    const fixture = context();
    fixture.ctx.db.namespace = namespace;
    await assert.rejects(plugin.definition.setup(fixture.ctx), /Invalid plugin database namespace/);
    assert.equal(fixture.data.size, 0);
    assert.equal(fixture.actions.size, 0);
  }
});

test("snapshot redaction covers credential naming variants recursively", () => {
  const sensitiveKeys = [
    "apiKey", "api_key", "accessToken", "refresh_token", "idToken", "token", "clientSecret",
    "password", "credential", "authorization", "cookie", "privateKey", "ssh_key", "passphrase",
    "pwd", "dsn", "bearer", "database_url", "connection_string", "XApiKey", "x-api-key",
    "PrivateKey", "SSHKey", "PRIVATEKEY", "databaseURL", "CONNECTION_STRING", "signing.private_key",
  ];
  const credentials = Object.fromEntries(sensitiveKeys.map((key) => [key, "should-never-persist"]));
  const snapshot = {
    adapterConfig: credentials,
    nested: [{ privateKey: "should-never-persist", timeout: 500 }],
    permissions: { canCreateAgents: true },
    tokenizer: "unchanged",
    passwordless: true,
    shipmentDsnCode: "not-a-dsn-field",
    connectionStringLength: 40,
    privateKeyboardLayout: "pt-BR",
  };
  const clean = sanitize(snapshot);
  assert.deepEqual(clean.adapterConfig, Object.fromEntries(sensitiveKeys.map((key) => [key, "[REDACTED]"])));
  assert.deepEqual(clean.nested, [{ privateKey: "[REDACTED]", timeout: 500 }]);
  for (const key of ["permissions", "tokenizer", "passwordless", "shipmentDsnCode", "connectionStringLength", "privateKeyboardLayout"]) {
    assert.deepEqual(clean[key], snapshot[key], key + " must remain usable");
  }
  assert.equal(snapshot.adapterConfig.privateKey, "should-never-persist", "sanitization must not mutate source input");
});

test("live activity ignores managed-skill plugin events and unsupported entities", async () => {
  for (const entityType of ["plugin", "issue", "project", "company", undefined]) {
    const fixture = context();
    await recordActivityEvent(fixture.ctx, {
      eventId: "event-1",
      eventType: "activity.logged",
      entityType,
      entityId: "plugin-id",
      companyId: COMPANY_A,
      occurredAt: "2026-10-07T12:00:00Z",
      payload: { activityAction: "plugin.managed_skill.reconciled", privateKey: "hidden" },
    });
    assert.equal(fixture.queries.length, 0, String(entityType));
    assert.equal(fixture.writes.length, 0, String(entityType));
  }
});

test("live activity still captures supported agent and company skill changes", async () => {
  for (const [entityType, action] of [["agent", "agent.instructions_updated"], ["company_skill", "company.skill_updated"]]) {
    const fixture = context(async (sql) => sql.startsWith("SELECT id FROM change_sets") ? [{ id: CHANGE_SET }] : []);
    await recordActivityEvent(fixture.ctx, {
      eventId: "event-1",
      eventType: "activity.logged",
      entityType,
      entityId: "entity-1",
      companyId: COMPANY_A,
      occurredAt: "2026-10-07T12:00:00Z",
      payload: { activityAction: action, database_url: "hidden", change: "keep" },
    });
    const item = fixture.writes.find(({ sql }) => sql.startsWith("INSERT INTO change_items"));
    assert.ok(item, entityType + " must produce an item");
    assert.equal(item.params[3], entityType === "agent" ? "agent" : "skill");
    const snapshot = fixture.writes.find(({ sql }) => sql.startsWith("INSERT INTO change_snapshots"));
    assert.equal(JSON.parse(snapshot.params[6]).details.database_url, "[REDACTED]");
  }
});

test("backfill filters entity types in the database and rejects unsupported returned rows", async () => {
  const fixture = context(async (sql) => {
    if (sql.includes("FROM public.activity_log")) {
      return ["plugin", "agent"].map((entityType, index) => ({
        id: "activity-" + index,
        actorType: "user",
        actorId: "founder",
        action: "agent.instructions_updated",
        entityType,
        entityId: "entity-" + index,
        agentId: null,
        runId: null,
        details: { ssh_key: "hidden" },
        createdAt: "2026-10-07T12:00:00Z",
      }));
    }
    return sql.startsWith("SELECT id FROM change_sets") ? [{ id: CHANGE_SET }] : [];
  });
  const result = await backfill(fixture.ctx, COMPANY_A, 7);
  assert.equal(result.activityItems, 1);
  assert.match(fixture.queries.find(({ sql }) => sql.includes("FROM public.activity_log")).sql,
    /AND entity_type IN \('agent', 'company_skill'\)/);
  const items = fixture.writes.filter(({ sql }) => sql.startsWith("INSERT INTO change_items"));
  assert.equal(items.length, 1);
  assert.equal(items[0].params[4], "entity-1");
  const snapshot = fixture.writes.find(({ sql }) => sql.startsWith("INSERT INTO change_snapshots"));
  assert.equal(JSON.parse(snapshot.params[6]).details.ssh_key, "[REDACTED]");
});

test("cost statistics distinguish no observations from explicitly reported zero", async () => {
  for (const [events, expected] of [[0, null], [1, 0]]) {
    const fixture = context(async () => [{ events, costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }]);
    const result = await queryCostStats(fixture.ctx, COMPANY_A, ["agent-1"], "2026-10-01", "2026-10-07");
    assert.deepEqual(result, { events, costUsd: expected, inputTokens: expected, cachedInputTokens: expected, outputTokens: expected });
    assert.deepEqual(fixture.queries[0].params, [COMPANY_A, "2026-10-01", "2026-10-07", "agent-1"]);
  }
  const fixture = context(async () => [{ events: "2", costCents: "125", inputTokens: "100", cachedInputTokens: "40", outputTokens: "8" }]);
  assert.deepEqual(await queryCostStats(fixture.ctx, COMPANY_A, [], "2026-10-01", "2026-10-07"),
    { events: 2, costUsd: 1.25, inputTokens: 100, cachedInputTokens: 40, outputTokens: 8 });
});

test("metric recomputation keeps unobserved baseline and delta null", async () => {
  let costQuery = 0;
  const fixture = context(async (sql) => {
    if (sql.includes("FROM change_sets")) return [{ appliedAt: "2026-10-07T12:00:00Z", validationEndsAt: null }];
    if (sql.includes("FROM change_items")) return [{ entityId: "agent-1" }];
    if (sql.includes("FROM public.heartbeat_runs")) return [{ runs: 0, successes: 0, avgDuration: null }];
    if (sql.includes("FROM public.cost_events")) return [{ events: costQuery++ === 0 ? 0 : 1, costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }];
    throw new Error("Unexpected query: " + sql);
  });
  await recomputeMetrics(fixture.ctx, COMPANY_A, CHANGE_SET);
  for (const metricKey of ["cost", "input_tokens", "cached_input_tokens", "output_tokens"]) {
    const metric = fixture.writes.find(({ params }) => params[3] === metricKey);
    assert.deepEqual(metric.params.slice(4, 7), [null, 0, null], metricKey);
    assert.deepEqual(metric.params.slice(8, 10), [0, 1], metricKey);
  }
});

for (const [action, params] of [
  ["add-evidence", { evidenceType: "run", verdict: "positive" }],
  ["add-link", { linkType: "issue", referenceId: "issue-1" }],
  ["add-conclusion", { outcome: "proven", summary: "Measured improvement" }],
]) {
  test(action + " cannot write to another company's change set", async () => {
    const fixture = context(async (sql, queryParams) => {
      assert.match(sql, /FROM change_sets WHERE company_id = \$1 AND id = \$2 LIMIT 1/);
      return queryParams[0] === COMPANY_A && queryParams[1] === CHANGE_SET ? [{ id: CHANGE_SET }] : [];
    });
    registerActions(fixture.ctx);
    await assert.rejects(fixture.actions.get(action)({ companyId: COMPANY_B, changeSetId: CHANGE_SET, ...params }), /Change Set not found/);
    assert.equal(fixture.writes.length, 0);
    const result = await fixture.actions.get(action)({ companyId: COMPANY_A, changeSetId: CHANGE_SET, ...params });
    assert.equal(result.ok, true);
    assert.ok(fixture.writes.length > 0);
    assert.ok(fixture.writes.every(({ params: values }) => values.includes(COMPANY_A)));
  });
}

test("overview excludes inconsistent child rows belonging to another company", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE change_sets (id TEXT, company_id TEXT, title TEXT, description TEXT, hypothesis TEXT,
        status TEXT, causality_level TEXT, applied_at TEXT, validation_ends_at TEXT, updated_at TEXT);
      CREATE TABLE change_items (id TEXT, company_id TEXT, change_set_id TEXT);
      CREATE TABLE change_evidence (id TEXT, company_id TEXT, change_set_id TEXT);
      CREATE TABLE change_metrics (id TEXT, company_id TEXT, change_set_id TEXT);
    `);
    db.prepare("INSERT INTO change_sets VALUES (?, ?, ?, NULL, NULL, 'applied', 'observed', ?, NULL, ?)")
      .run(CHANGE_SET, COMPANY_A, "Company A changes", "2026-10-07", "2026-10-07");
    for (const table of ["change_items", "change_evidence", "change_metrics"]) {
      db.prepare("INSERT INTO " + table + " VALUES (?, ?, ?)").run("valid-" + table, COMPANY_A, CHANGE_SET);
      db.prepare("INSERT INTO " + table + " VALUES (?, ?, ?)").run("wrong-company-" + table, COMPANY_B, CHANGE_SET);
    }
    const fixture = context(async (sql, params) => db.prepare(sql.replaceAll("::int", "").replaceAll("$1", "?")).all(...params));
    const result = await overview(fixture.ctx, COMPANY_A);
    assert.equal(result.changeSets.length, 1);
    const { itemCount, evidenceCount, metricCount } = result.changeSets[0];
    assert.deepEqual({ itemCount, evidenceCount, metricCount }, { itemCount: 1, evidenceCount: 1, metricCount: 1 });
  } finally {
    db.close();
  }
});

test("run context cannot attach projects or goals from another company", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      ATTACH DATABASE ':memory:' AS public;
      CREATE TABLE public.heartbeat_runs (id TEXT, company_id TEXT, native_issue_id TEXT, context_snapshot TEXT);
      CREATE TABLE public.issues (id TEXT, company_id TEXT, identifier TEXT, title TEXT, project_id TEXT, goal_id TEXT);
      CREATE TABLE public.projects (id TEXT, company_id TEXT, name TEXT, goal_id TEXT);
      CREATE TABLE public.goals (id TEXT, company_id TEXT, title TEXT);
    `);
    db.prepare("INSERT INTO public.projects VALUES (?, ?, ?, ?)").run("foreign-project", COMPANY_B, "Foreign private project", "foreign-goal");
    db.prepare("INSERT INTO public.projects VALUES (?, ?, ?, ?)").run("own-project", COMPANY_A, "Own project", "own-goal");
    db.prepare("INSERT INTO public.goals VALUES (?, ?, ?)").run("foreign-goal", COMPANY_B, "Foreign private goal");
    db.prepare("INSERT INTO public.goals VALUES (?, ?, ?)").run("own-goal", COMPANY_A, "Own goal");
    db.prepare("INSERT INTO public.issues VALUES (?, ?, ?, ?, ?, ?)").run("own-issue", COMPANY_A, "JOU-1", "Own issue", "own-project", "foreign-goal");
    db.prepare("INSERT INTO public.heartbeat_runs VALUES (?, ?, NULL, ?)").run("foreign-project-run", COMPANY_A, JSON.stringify({ projectId: "foreign-project" }));
    db.prepare("INSERT INTO public.heartbeat_runs VALUES (?, ?, ?, '{}')").run("foreign-goal-run", COMPANY_A, "own-issue");
    db.prepare("INSERT INTO public.heartbeat_runs VALUES (?, ?, NULL, ?)").run("own-project-run", COMPANY_A, JSON.stringify({ projectId: "own-project" }));
    for (const [runId, expectedLinks] of [
      ["foreign-project-run", ["run"]],
      ["foreign-goal-run", ["run", "issue", "project"]],
      ["own-project-run", ["run", "project", "goal"]],
    ]) {
      const fixture = context(async (sql, params) => db.prepare(sql.replaceAll("::text", "").replace(/\$\d/g, "?")).all(...params));
      await attachRunContext(fixture.ctx, COMPANY_A, CHANGE_SET, runId);
      const links = fixture.writes.filter(({ sql }) => sql.startsWith("INSERT INTO change_links"));
      assert.deepEqual(links.map(({ params }) => params[3]), expectedLinks, runId);
      assert.ok(links.every(({ params }) => !params.includes("foreign-project") && !params.includes("foreign-goal")), runId);
    }
  } finally {
    db.close();
  }
});

test("change detail cannot reveal snapshots belonging to another company", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE change_sets (id TEXT, company_id TEXT, title TEXT, description TEXT, hypothesis TEXT, status TEXT,
        causality_level TEXT, source_context_key TEXT, applied_at TEXT, validation_ends_at TEXT, created_by_type TEXT,
        created_by_id TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE change_items (id TEXT, company_id TEXT, change_set_id TEXT, entity_type TEXT, entity_id TEXT, entity_name TEXT,
        change_kind TEXT, changed_keys TEXT, source_type TEXT, source_ref TEXT, source_activity_id TEXT, occurred_at TEXT,
        before_snapshot_id TEXT, after_snapshot_id TEXT);
      CREATE TABLE change_snapshots (id TEXT, company_id TEXT, snapshot TEXT);
      CREATE TABLE change_evidence (id TEXT, company_id TEXT, change_set_id TEXT, evidence_type TEXT, reference_id TEXT,
        label TEXT, verdict TEXT, notes TEXT, metadata TEXT, observed_at TEXT, created_at TEXT);
      CREATE TABLE change_metrics (company_id TEXT, change_set_id TEXT, metric_key TEXT, baseline_value REAL, current_value REAL,
        delta_value REAL, unit TEXT, baseline_sample_size INTEGER, current_sample_size INTEGER, computed_at TEXT);
      CREATE TABLE change_conclusions (id TEXT, company_id TEXT, change_set_id TEXT, outcome TEXT, confidence TEXT, summary TEXT,
        evidence_summary TEXT, created_at TEXT);
      CREATE TABLE change_links (id TEXT, company_id TEXT, change_set_id TEXT, link_type TEXT, reference_id TEXT, label TEXT,
        metadata TEXT, created_at TEXT);
    `);
    db.prepare("INSERT INTO change_sets (id, company_id, title, applied_at) VALUES (?, ?, 'Own changes', '2026-10-07')").run(CHANGE_SET, COMPANY_A);
    db.prepare("INSERT INTO change_snapshots VALUES (?, ?, ?)").run("foreign-snapshot", COMPANY_B, JSON.stringify({ name: "Foreign confidential configuration" }));
    db.prepare("INSERT INTO change_snapshots VALUES (?, ?, ?)").run("own-snapshot", COMPANY_A, JSON.stringify({ name: "Own configuration" }));
    db.prepare("INSERT INTO change_items (id, company_id, change_set_id, entity_type, entity_id, before_snapshot_id, after_snapshot_id) VALUES ('item-1', ?, ?, 'skill', 'skill-1', 'foreign-snapshot', 'own-snapshot')")
      .run(COMPANY_A, CHANGE_SET);
    const fixture = context(async (sql, params) => db.prepare(sql.replace(/::(?:int|float)/g, "").replace(/\$\d/g, "?")).all(...params));
    await plugin.definition.setup(fixture.ctx);
    const detail = await fixture.data.get("change-detail")({ companyId: COMPANY_A, changeSetId: CHANGE_SET });
    assert.equal(detail.items.length, 1);
    assert.equal(detail.items[0].beforeSnapshot, null);
    assert.deepEqual(JSON.parse(detail.items[0].afterSnapshot), { name: "Own configuration" });
    assert.ok(!JSON.stringify(detail).includes("Foreign confidential configuration"));
  } finally {
    db.close();
  }
});

test("a committed merge reports stale metrics without making the deleted source retryable", async () => {
  const target = "44444444-4444-4444-8444-444444444444";
  const actions = new Map();
  let deleted = false;
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql) {
        if (sql.includes('id IN ($2, $3)')) return [{ id: CHANGE_SET }, { id: target }];
        assert.ok(deleted, "metric reads follow the completed transfer");
        throw new Error("cost service unavailable with private SQL detail");
      },
      async execute(sql) {
        if (sql.startsWith(`DELETE FROM "${NAMESPACE}"."change_sets"`)) deleted = true;
        return { rowCount: 1 };
      },
    },
    actions: { register(name, handler) { actions.set(name, handler); } },
  };
  registerActions(ctx);
  assert.deepEqual(await actions.get("merge-change-set")({
    companyId: COMPANY_A, sourceChangeSetId: CHANGE_SET, targetChangeSetId: target,
  }), { ok: true, targetChangeSetId: target, metricsStale: true });
  assert.equal(deleted, true);
});
