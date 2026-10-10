import test from "node:test";
import assert from "node:assert/strict";
import { getAgent, getOverview, getTrace, listAgents, normalizeWindowHours, parsePage, safeError } from "../src/service.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const retryId = "44444444-4444-4444-8444-444444444444";
const wakeId = "55555555-5555-4555-8555-555555555555";
const issueId = "66666666-6666-4666-8666-666666666666";
const timestamp = new Date("2026-10-07T10:00:00.000Z");

function fakeContext(overrides = {}) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes("FROM public.delivery_evaluations e JOIN public.delivery_revisions")) {
      if (overrides.qualitySchemaError) {
        const error = new Error("relation delivery_evaluations does not exist");
        error.code = "42P01";
        throw error;
      }
      return (overrides.qualityRows ?? []).filter((row) => params[4] == null || row.agentId === params[4]);
    }
    if (sql.includes("FROM public.delivery_revisions r JOIN public.run_execution_profiles")) {
      return (overrides.trackedQualityRows ?? []).filter((row) => params[4] == null || row.agentId === params[4]);
    }
    if (sql.includes("FROM public.delivery_evaluations e WHERE e.company_id")) {
      return (overrides.assessedQualityRows ?? []).filter((row) => params[4] == null || row.agentId === params[4]);
    }
    if (sql.includes("FROM public.companies")) return [{ id: companyId }];
    if (sql.includes("SELECT a.id, a.name, a.status FROM public.agents") && sql.includes("LIMIT $2 OFFSET $3")) {
      return overrides.agentRows ?? [{ id: agentId, name: "Test Agent", status: "idle" }];
    }
    if (sql.includes("SELECT a.id, a.name, a.status FROM public.agents") && sql.includes("AND a.id = $2")) {
      return [{ id: agentId, name: "Test Agent", status: "idle" }];
    }
    if (sql.includes("FROM public.heartbeat_runs r") && sql.includes("AND r.agent_id = $2") && sql.includes("ORDER BY r.created_at DESC")) {
      return overrides.recentRows ?? [];
    }
    if (sql.includes("FROM public.heartbeat_runs r") && sql.includes("ORDER BY r.created_at DESC") && sql.includes("LIMIT $3")) {
      return overrides.runRows ?? [{
        id: runId, agentId, status: "succeeded", invocationSource: "on_demand",
        createdAt: timestamp, startedAt: timestamp, finishedAt: new Date(timestamp.getTime() + 5000),
        errorCode: "Bearer private-token", error: "private raw error", contextSnapshot: { secret: "private snapshot" },
        retryOfRunId: null, scheduledRetryAttempt: 0, wakeupRequestId: null,
        issueId: null, lastUsefulActionAt: timestamp,
      }];
    }
    if (sql.includes("retry_of_run_id = $2")) return [{ count: "0" }];
    if (sql.includes("COUNT(*)::int AS count FROM public.heartbeat_runs")) return overrides.countRows ?? [{ count: "1" }];
    if (sql.includes("COUNT(*)::int AS count FROM public.agents")) return overrides.agentCountRows ?? [{ count: "1" }];
    if (sql.includes("COUNT(*) FILTER") && sql.includes("GROUP BY r.agent_id")) return overrides.statsRows ?? [{
      agentId, runs: 1, successes: 1, failures: 0, interrupted: 0, retries: 0,
      unknownCostRuns: 1, avgDurationMs: "5000",
    }];
    if (sql.includes("DISTINCT ON (r.agent_id)")) return [{ agentId, lastRunId: runId, lastError: "Bearer secret-value" }];
    if (sql.includes("AS runs") && sql.includes("unknownCostRuns")) return overrides.summaryRows ?? [{
      runs: 1, successes: 1, failures: 0, interrupted: 0, retries: 0, unknownCostRuns: 1, avgDurationMs: "5000",
    }];
    if (sql.includes("GROUP BY c.agent_id")) return overrides.costAgentRows ?? [];
    if (sql.includes("GROUP BY c.heartbeat_run_id")) return overrides.runCostRows ?? [];
    if (sql.includes("FROM public.heartbeat_runs r") && sql.includes("JOIN public.agents")) {
      return overrides.traceRows ?? [{ id: runId, agentId, agentName: "Test Agent", status: "failed", createdAt: timestamp,
        startedAt: timestamp, finishedAt: timestamp, invocationSource: "on_demand", errorCode: "provider_timeout",
        retryOfRunId: null, scheduledRetryAttempt: 0 }];
    }
    if (sql.includes("SUM(c.cost_cents)") && sql.includes("c.heartbeat_run_id = $2")) return [{ knownCostCents: "0" }];
    throw new Error(`Unexpected query: ${sql}`);
  };
  return { ctx: { db: { query } }, calls };
}

test("window and pagination inputs are bounded", () => {
  assert.equal(normalizeWindowHours(undefined), 24);
  assert.equal(normalizeWindowHours("168"), 168);
  assert.throws(() => normalizeWindowHours("169"), /1 to 168/);
  assert.deepEqual(parsePage({ limit: "100", offset: "20" }), { limit: 100, offset: 20 });
  assert.throws(() => parsePage({ limit: "101" }), /limit/);
});

test("overview uses full-window aggregates and returns only safe fields", async () => {
  const { ctx, calls } = fakeContext({ costAgentRows: [{ agentId, knownCostCents: "250" }] });
  const result = await getOverview(ctx, companyId, 24);
  assert.equal(result.summary.runsTotal, 1);
  assert.equal(result.summary.knownCostCents, 250);
  assert.equal(result.summary.unknownCostRuns, 1);
  assert.equal(result.agents[0].unknownCostRuns, 1);
  assert.equal(result.agents[0].knownCostCents, 250);
  assert.equal(result.agents[0].lastError, null);
  assert.equal(result.failures.length, 0);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private raw error|private snapshot|private-token|secret-value|contextSnapshot|stderrExcerpt/);
  assert.ok(calls.every(({ sql }) => sql.includes("public.") && (sql.includes("company_id = $1") || sql.includes("c.id = $1"))));
  assert.ok(calls.every(({ params }) => params[0] === companyId));
});

test("zero reported cents is known while missing and unpriced costs remain unknown", async () => {
  const { ctx } = fakeContext({
    costAgentRows: [{ agentId, knownCostCents: "0" }],
    runCostRows: [{ runId, knownCostCents: "0" }],
    statsRows: [{ agentId, runs: 1, successes: 1, failures: 0, interrupted: 0, retries: 0, unknownCostRuns: 0, avgDurationMs: "5000" }],
    summaryRows: [{ runs: 1, successes: 1, failures: 0, interrupted: 0, retries: 0, unknownCostRuns: 0, avgDurationMs: "5000" }],
  });
  const result = await getOverview(ctx, companyId);
  assert.equal(result.summary.knownCostCents, 0);
  assert.equal(result.agents[0].knownCostCents, 0, "a reported zero must stay known");
  assert.equal(result.summary.unknownCostRuns, 0);
  assert.equal(result.coverage.metricsScope, "full_window_aggregates");
  assert.equal(result.coverage.rawLogsAvailable, false);

  const missing = fakeContext();
  const overview = await getOverview(missing.ctx, companyId);
  const detail = await getAgent(missing.ctx, companyId, agentId);
  assert.equal(overview.agents[0].knownCostCents, null, "missing reported agent cost stays unknown in overview");
  assert.equal(detail.agent.knownCostCents, null, "missing reported agent cost stays unknown in detail");
  assert.equal(overview.agents[0].unknownCostRuns, 1);
});

test("run-cost queries bind UUIDs as scalars and skip empty run lists", async () => {
  const { ctx, calls } = fakeContext({
    recentRows: [{ id: runId, agentId, status: "succeeded", createdAt: timestamp, startedAt: timestamp, finishedAt: timestamp }],
  });
  await getOverview(ctx, companyId);
  await getAgent(ctx, companyId, agentId);
  const runCostQueries = calls.filter(({ sql }) => sql.includes("GROUP BY c.heartbeat_run_id"));
  assert.equal(runCostQueries.length, 3, "overview and the two agent-detail run lists load costs independently");
  for (const call of runCostQueries) {
    assert.match(call.sql, /heartbeat_run_id IN \(\$2\)/);
    assert.doesNotMatch(call.sql, /ANY\(/);
    assert.deepEqual(call.params, [companyId, runId, call.params[2]]);
    assert.ok(call.params.every((value) => !Array.isArray(value)));
  }

  const empty = fakeContext({ runRows: [], recentRows: [], countRows: [{ count: "0" }] });
  await getOverview(empty.ctx, companyId);
  await getAgent(empty.ctx, companyId, agentId);
  assert.equal(empty.calls.filter(({ sql }) => sql.includes("GROUP BY c.heartbeat_run_id")).length, 0);
  assert.ok(empty.calls.every(({ params }) => params.every((value) => !Array.isArray(value))));
});

test("agent pagination is explicit and uses offset in the company-scoped query", async () => {
  const pageRows = Array.from({ length: 26 }, (_, index) => ({
    id: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`,
    name: `Page Agent ${index}`, status: "idle",
  }));
  const { ctx, calls } = fakeContext({ agentRows: pageRows, agentCountRows: [{ count: "125" }] });
  const result = await listAgents(ctx, companyId, { limit: 25, offset: 75 }, 12);
  assert.deepEqual(result.pagination, { total: 125, limit: 25, offset: 75, hasMore: true });
  assert.equal(result.items.length, 25);
  assert.equal(result.items[0].id, pageRows[0].id, "SQL already applied the page offset");
  const agentQuery = calls.find(({ sql }) => sql.includes("LIMIT $2 OFFSET $3"));
  assert.deepEqual(agentQuery.params, [companyId, 26, 75]);
  assert.equal(result.windowHours, 12);
});

test("trace joins and retry counts are restricted to the authorized company", async () => {
  const { ctx, calls } = fakeContext();
  const result = await getTrace(ctx, companyId, runId);
  assert.equal(result.companyId, companyId);
  assert.equal(result.run.errorCode, "provider_timeout");
  assert.equal(result.run.retryCount, 0);
  assert.deepEqual(result.timeline.map((event) => event.type), ["created", "started", "finished"]);
  assert.ok(calls.every(({ sql, params }) => sql.includes("public.") && sql.includes("company_id = $1") && params[0] === companyId));
  assert.ok(calls.every(({ sql }) => !/SELECT[^;]*\b(result_json|stdout_excerpt|stderr_excerpt)\b/i.test(sql)));
});

test("heuristics stay suspected and avoid flagging retry-linked duplicate wakeups", async () => {
  const rows = [
    { id: runId, agentId, status: "failed", createdAt: timestamp, startedAt: timestamp, finishedAt: timestamp,
      errorCode: "provider_timeout", wakeupRequestId: wakeId, issueId, retryOfRunId: null },
    { id: retryId, agentId, status: "failed", createdAt: new Date(timestamp.getTime() + 1000), startedAt: timestamp,
      finishedAt: timestamp, errorCode: "provider_timeout", wakeupRequestId: wakeId, issueId, retryOfRunId: runId },
    { id: "77777777-7777-4777-8777-777777777777", agentId, status: "failed", createdAt: new Date(timestamp.getTime() + 2000),
      startedAt: timestamp, finishedAt: timestamp, errorCode: "provider_timeout", wakeupRequestId: wakeId, issueId, retryOfRunId: null },
    { id: "88888888-8888-4888-8888-888888888888", agentId, status: "running", createdAt: new Date(timestamp.getTime() - 3600000),
      startedAt: new Date(timestamp.getTime() - 3600000), lastUsefulActionAt: new Date(timestamp.getTime() - 3600000), errorCode: null },
  ];
  const { ctx } = fakeContext({
    runRows: rows,
    countRows: [{ count: "4" }],
    statsRows: [{ agentId, runs: 4, successes: 0, failures: 3, interrupted: 0, retries: 1, unknownCostRuns: 0, avgDurationMs: 0 }],
    summaryRows: [{ runs: 4, successes: 0, failures: 3, interrupted: 0, retries: 1, unknownCostRuns: 0, avgDurationMs: 0 }],
    latestRows: [{ agentId, lastRunId: rows[3].id, lastError: null }],
  });
  const result = await getOverview(ctx, companyId);
  assert.equal(result.summary.failures, 3);
  assert.ok(result.anomalies.every((item) => item.suspected === true));
  assert.ok(result.anomalies.some((item) => item.kind === "repeated_error"));
  assert.ok(result.anomalies.some((item) => item.kind === "repeated_wakes"));
  assert.ok(result.anomalies.some((item) => item.kind === "no_progress"));
  assert.ok(!result.anomalies.some((item) => item.kind === "duplicate_wake_suspected"));
});

test("only allowlisted machine error codes can be displayed", () => {
  assert.equal(safeError("provider_timeout"), "provider_timeout");
  assert.equal(safeError("Bearer token-value"), null);
  assert.equal(safeError("database password=secret"), null);
});

test("agent quality detail uses agent-scoped cohorts and full aggregate counts beyond the global sample cap", async () => {
  const otherAgentId = "77777777-7777-4777-8777-777777777777";
  const qualityRows = Array.from({ length: 70 }, (_, index) => ({
    id: "target-evaluation-" + index, companyId, issueId, revisionId: "target-revision-" + index, workProductId: "target-work-" + index,
    agentId, contributionRole: "author", rubric: "research-v1", score: 80, deliveredAt: timestamp,
    reviewerType: "human", reviewerId: "reviewer-1", executionProfile: { role: "analyst", skills: [] }, controlledTestRef: null, hypotheses: [],
  })).concat(Array.from({ length: 70 }, (_, index) => ({
    id: "other-evaluation-" + index, companyId, issueId, revisionId: "other-revision-" + index, workProductId: "other-work-" + index,
    agentId: otherAgentId, contributionRole: "author", rubric: "research-v1", score: 20, deliveredAt: timestamp,
    reviewerType: "human", reviewerId: "reviewer-2", executionProfile: { role: "analyst", skills: [] }, controlledTestRef: null, hypotheses: [],
  })));
  const { ctx, calls } = fakeContext({
    qualityRows,
    trackedQualityRows: [{ agentId, count: 100 }, { agentId: otherAgentId, count: 100 }],
    assessedQualityRows: [{ agentId, count: 70 }, { agentId: otherAgentId, count: 70 }],
  });
  const result = await getAgent(ctx, companyId, agentId);
  assert.equal(result.agent.quality.assessedDeliveries, 70);
  assert.equal(result.agent.quality.trackedExactRevisions, 100);
  assert.equal(result.agent.quality.samples.length, 50);
  assert.ok(result.agent.quality.samples.every((sample) => sample.agentId === agentId));
  assert.ok(result.agent.quality.samples.every((sample) => sample.feedbackHref.includes("evaluationId=" + sample.id)));
  assert.ok(calls.some(({ sql, params }) => sql.includes("FROM public.delivery_evaluations e JOIN public.delivery_revisions") && params[4] === agentId));
});


test("agent detail performs one scoped quality read and preserves unavailable schema state", async () => {
  const present = fakeContext();
  const detail = await getAgent(present.ctx, companyId, agentId);
  assert.equal(detail.agent.id, agentId);
  const qualityReads = present.calls.filter(call => call.sql.includes("FROM public.delivery_evaluations e JOIN public.delivery_revisions"));
  assert.equal(qualityReads.length, 1);
  assert.equal(qualityReads[0].params[4], agentId);
  const unavailable = fakeContext({ qualitySchemaError: true });
  const result = await getAgent(unavailable.ctx, companyId, agentId);
  assert.deepEqual(result.agent.quality.cohorts, []);
  assert.equal(result.agent.quality.unavailable, true);
  assert.match(result.agent.quality.coverage.notes.join(" "), /unavailable/i);
});
