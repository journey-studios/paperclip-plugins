import { readDeliveryQuality } from "../../../shared/delivery-quality.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_CAP = 1000;
const AGENT_CAP = 100;
const FAILURE = "r.status IN ('failed','timed_out','error')";
const SUCCESS = "r.status IN ('succeeded','success','completed')";
const INTERRUPTED = "r.status IN ('interrupted','cancelled')";
const SETTLED = `(${SUCCESS} OR ${FAILURE} OR ${INTERRUPTED})`;
const ACTIVE_STATUSES = new Set(["running", "in_progress", "active"]);
const QUALITY_TABLES = ["delivery_revisions", "delivery_evaluations", "run_execution_profiles"];

function isMissingQualitySchema(error) {
  const message = String(error?.message ?? error ?? "");
  return error?.code === "42P01" || (error?.code === "42703" && message.includes("controlled_test_ref")) || (message.includes("does not exist") && QUALITY_TABLES.some(table => message.includes(table)));
}

export function unavailableQuality(note = "Delivery-quality tables are unavailable. Install a host version that provides delivery_revisions, delivery_evaluations and run_execution_profiles.") {
  return { policy: "delivery-quality.v1", cohorts: [], samples: [], coverage: { evaluationsReturned: 0, limit: 5000, truncated: false, eligibleByAgent: [], notes: [note] }, notes: [], unavailable: true };
}

const RUN_COLUMNS = `r.id, r.agent_id AS "agentId", r.status,
  r.invocation_source AS "invocationSource", r.created_at AS "createdAt",
  r.started_at AS "startedAt", r.finished_at AS "finishedAt",
  r.error_code AS "errorCode", r.wakeup_request_id AS "wakeupRequestId",
  COALESCE(r.native_issue_id::text, r.context_snapshot ->> 'issueId') AS "issueId",
  r.retry_of_run_id AS "retryOfRunId", r.scheduled_retry_attempt AS "scheduledRetryAttempt",
  r.last_useful_action_at AS "lastUsefulActionAt"`;

const TRACE_COLUMNS = `r.id, r.agent_id AS "agentId", r.status,
  r.invocation_source AS "invocationSource", r.created_at AS "createdAt",
  r.started_at AS "startedAt", r.finished_at AS "finishedAt",
  r.error_code AS "errorCode", r.wakeup_request_id AS "wakeupRequestId",
  COALESCE(r.native_issue_id::text, r.context_snapshot ->> 'issueId') AS "issueId",
  r.retry_of_run_id AS "retryOfRunId", r.scheduled_retry_attempt AS "scheduledRetryAttempt",
  r.last_useful_action_at AS "lastUsefulActionAt"`;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const notFound = (message) => Object.assign(new Error(message), { status: 404 });

export function normalizeWindowHours(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === "") return 24;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 168) throw badRequest("windowHours must be an integer from 1 to 168");
  return parsed;
}

export function parsePage(query = {}) {
  return {
    limit: parseInteger(query.limit, 50, 1, 100, "limit"),
    offset: parseInteger(query.offset, 0, 0, 10000, "offset"),
  };
}

function parseInteger(value, fallback, min, max, field) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw badRequest(`${field} must be an integer from ${min} to ${max}`);
  return parsed;
}

function scalar(value, field) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !raw.trim()) throw badRequest(`${field} is required`);
  return raw.trim();
}

function uuid(value, field) {
  const parsed = scalar(value, field);
  if (!UUID.test(parsed)) throw badRequest(`${field} must be a UUID`);
  return parsed;
}

function asDate(value) {
  if (value == null) return null;
  const result = value instanceof Date ? value : new Date(value);
  return Number.isNaN(result.getTime()) ? null : result;
}

function iso(value) {
  return asDate(value)?.toISOString() ?? null;
}

function durationMs(startedAt, finishedAt) {
  const start = asDate(startedAt);
  const finish = asDate(finishedAt);
  return start && finish ? Math.max(0, finish.getTime() - start.getTime()) : null;
}

// error_code is a machine code, never a provider message or raw log excerpt.
export function safeError(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_.:-]{0,95}$/i.test(value) ? value : null;
}

function safeInvocation(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,47}$/i.test(value) ? value : null;
}

function errorFingerprint(value) {
  return safeError(value)?.toLowerCase() ?? null;
}

function dbQuery(ctx) {
  if (typeof ctx?.db?.query !== "function") throw new Error("Database query is unavailable");
  return ctx.db.query.bind(ctx.db);
}

async function queryRunCosts(query, companyId, runIds, windowStart) {
  if (runIds.length === 0) return [];
  // Plugin DB binds each parameter via Drizzle's sql`...`; JS arrays are
  // expanded as SQL tuples there, so bind the database-derived UUIDs as scalars.
  const runIdPlaceholders = runIds.map((_, index) => `$${index + 2}`).join(", ");
  const windowPlaceholder = `$${runIds.length + 2}`;
  return query(`SELECT c.heartbeat_run_id AS "runId", SUM(c.cost_cents)::bigint AS "knownCostCents"
    FROM public.cost_events c WHERE c.company_id = $1 AND c.heartbeat_run_id IN (${runIdPlaceholders})
      AND c.occurred_at >= ${windowPlaceholder} AND c.cost_status = 'reported' GROUP BY c.heartbeat_run_id`,
  [companyId, ...runIds, windowStart]);
}

async function readSnapshot(ctx, companyValue, windowHours = 24, agentPage = { limit: AGENT_CAP, offset: 0 }, qualityAgentId = null) {
  const companyId = uuid(companyValue, "companyId");
  const hours = normalizeWindowHours(windowHours);
  const now = new Date();
  const windowStart = new Date(now.getTime() - hours * 3600000);
  const query = dbQuery(ctx);
  const companies = await query("SELECT c.id FROM public.companies c WHERE c.id = $1 LIMIT 1", [companyId]);
  if (!companies[0]) throw notFound("Company not found");

  const [agentRows, runRows, countRows, agentCountRows, statsRows, latestRows, aggregateRows, costAgentRows] = await Promise.all([
    query("SELECT a.id, a.name, a.status FROM public.agents a WHERE a.company_id = $1 ORDER BY lower(a.name), a.id LIMIT $2 OFFSET $3", [companyId, agentPage.limit + 1, agentPage.offset]),
    query(`SELECT ${RUN_COLUMNS} FROM public.heartbeat_runs r WHERE r.company_id = $1 AND r.created_at >= $2 ORDER BY r.created_at DESC, r.id DESC LIMIT $3`, [companyId, windowStart, RUN_CAP + 1]),
    query("SELECT COUNT(*)::int AS count FROM public.heartbeat_runs r WHERE r.company_id = $1 AND r.created_at >= $2", [companyId, windowStart]),
    query("SELECT COUNT(*)::int AS count FROM public.agents a WHERE a.company_id = $1", [companyId]),
    query(`SELECT r.agent_id AS "agentId", COUNT(*)::int AS runs,
      COUNT(*) FILTER (WHERE ${SUCCESS})::int AS successes,
      COUNT(*) FILTER (WHERE ${FAILURE})::int AS failures,
      COUNT(*) FILTER (WHERE ${INTERRUPTED})::int AS interrupted,
      COUNT(*) FILTER (WHERE r.retry_of_run_id IS NOT NULL)::int AS retries,
      COUNT(*) FILTER (WHERE ${SETTLED} AND NOT EXISTS (
        SELECT 1 FROM public.cost_events c WHERE c.company_id = $1 AND c.agent_id = r.agent_id
          AND c.heartbeat_run_id = r.id AND c.occurred_at >= $2 AND c.cost_status = 'reported'))::int AS "unknownCostRuns",
      ROUND(AVG(EXTRACT(EPOCH FROM (r.finished_at-r.started_at))*1000)
        FILTER (WHERE r.started_at IS NOT NULL AND r.finished_at IS NOT NULL))::bigint AS "avgDurationMs"
      FROM public.heartbeat_runs r WHERE r.company_id = $1 AND r.created_at >= $2 GROUP BY r.agent_id`, [companyId, windowStart]),
    query(`SELECT DISTINCT ON (r.agent_id) r.agent_id AS "agentId", r.id AS "lastRunId", r.error_code AS "lastError"
      FROM public.heartbeat_runs r WHERE r.company_id = $1 AND r.created_at >= $2
      ORDER BY r.agent_id, r.created_at DESC, r.id DESC`, [companyId, windowStart]),
    query(`SELECT COUNT(*)::int AS runs, COUNT(*) FILTER (WHERE ${SUCCESS})::int AS successes,
      COUNT(*) FILTER (WHERE ${FAILURE})::int AS failures, COUNT(*) FILTER (WHERE ${INTERRUPTED})::int AS interrupted,
      COUNT(*) FILTER (WHERE r.retry_of_run_id IS NOT NULL)::int AS retries,
      ROUND(AVG(EXTRACT(EPOCH FROM (r.finished_at-r.started_at))*1000)
        FILTER (WHERE r.started_at IS NOT NULL AND r.finished_at IS NOT NULL))::bigint AS "avgDurationMs",
      COUNT(*) FILTER (WHERE ${SETTLED} AND NOT EXISTS (
        SELECT 1 FROM public.cost_events c WHERE c.company_id = $1 AND c.agent_id = r.agent_id
          AND c.heartbeat_run_id = r.id AND c.occurred_at >= $2 AND c.cost_status = 'reported'))::int AS "unknownCostRuns"
      FROM public.heartbeat_runs r WHERE r.company_id = $1 AND r.created_at >= $2`, [companyId, windowStart]),
    query(`SELECT c.agent_id AS "agentId", SUM(c.cost_cents)::bigint AS "knownCostCents"
      FROM public.cost_events c WHERE c.company_id = $1 AND c.occurred_at >= $2 AND c.cost_status = 'reported' GROUP BY c.agent_id`, [companyId, windowStart]),
  ]);

  const runs = runRows.slice(0, RUN_CAP);
  let quality;
  try { quality = await readDeliveryQuality(ctx, companyId, { start: windowStart.toISOString(), end: now.toISOString(), agentId: qualityAgentId }); }
  catch (error) {
    if (isMissingQualitySchema(error)) quality = unavailableQuality();
    else {
      ctx?.logger?.error?.("Agent Observatory quality read failed", { code: "quality_read_failed" });
      quality = unavailableQuality("Delivery quality read failed; operational metrics remain available.");
    }
  }
  const runIds = runs.map((run) => run.id);
  const runCostRows = await queryRunCosts(query, companyId, runIds, windowStart);
  const agents = agentRows.slice(0, agentPage.limit);
  const totalRuns = Number(countRows[0]?.count ?? 0);
  const totalAgents = Number(agentCountRows[0]?.count ?? 0);
  return {
    companyId, windowHours: hours, now, windowStart, agents, runs, quality,
    totalRuns, totalAgents,
    hasMoreRuns: totalRuns > RUN_CAP,
    hasMoreAgents: agentPage.offset + agents.length < totalAgents,
    agentPage,
    statsByAgent: new Map(statsRows.map((row) => [row.agentId, row])),
    latestByAgent: new Map(latestRows.map((row) => [row.agentId, row])),
    summary: aggregateRows[0] ?? {},
    costByAgent: new Map(costAgentRows.map((row) => [row.agentId, Number(row.knownCostCents ?? 0)])),
    costByRun: new Map(runCostRows.map((row) => [row.runId, Number(row.knownCostCents ?? 0)])),
  };
}

function safeRun(run, agentNames = new Map(), costByRun = new Map()) {
  const cost = costByRun.get(run.id);
  return {
    id: run.id,
    agentId: run.agentId,
    agentName: agentNames.get(run.agentId) ?? run.agentName ?? "Unknown agent",
    status: run.status,
    createdAt: iso(run.createdAt),
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
    durationMs: durationMs(run.startedAt, run.finishedAt),
    invocationSource: safeInvocation(run.invocationSource),
    errorCode: safeError(run.errorCode),
    retryOfRunId: run.retryOfRunId ?? null,
    attempt: Math.max(0, Number(run.scheduledRetryAttempt ?? 0)),
    knownCostCents: Number.isFinite(cost) ? cost : null,
  };
}

function summarizeAgent(agent, snapshot) {
  const stats = snapshot.statsByAgent.get(agent.id) ?? {};
  const lastRun = snapshot.latestByAgent.get(agent.id) ?? null;
  const failures = Number(stats.failures ?? 0);
  return {
    id: agent.id,
    quality: { unavailable: Boolean(snapshot.quality.unavailable), cohorts: snapshot.quality.cohorts.filter(c => c.agentId === agent.id),
      assessedDeliveries: Number(snapshot.quality.coverage.eligibleByAgent.find(e => e.agentId === agent.id)?.assessedDeliveries ?? 0),
      trackedExactRevisions: Number(snapshot.quality.coverage.eligibleByAgent.find(e => e.agentId === agent.id)?.trackedExactRevisions ?? 0),
      coverage: { ...snapshot.quality.coverage, eligibleByAgent: snapshot.quality.coverage.eligibleByAgent.filter(e => e.agentId === agent.id) },
      samples: snapshot.quality.samples.filter(e => e.agentId === agent.id) },
    name: agent.name,
    status: agent.status,
    health: failures >= 3 ? "degraded" : Number(stats.runs ?? 0) ? "healthy" : "unknown",
    runs: Number(stats.runs ?? 0),
    successes: Number(stats.successes ?? 0),
    failures,
    interrupted: Number(stats.interrupted ?? 0),
    retries: Number(stats.retries ?? 0),
    knownCostCents: snapshot.costByAgent.get(agent.id) ?? null,
    unknownCostRuns: Number(stats.unknownCostRuns ?? 0),
    avgDurationMs: stats.avgDurationMs == null ? null : Number(stats.avgDurationMs),
    lastError: safeError(lastRun?.lastError),
    lastRunId: lastRun?.lastRunId ?? null,
  };
}

function coverage(snapshot) {
  return {
    source: "database",
    windowStart: snapshot.windowStart.toISOString(),
    windowEnd: snapshot.now.toISOString(),
    agentsReturned: snapshot.agents.length,
    agentsLimit: snapshot.agentPage.limit,
    totalAgents: snapshot.totalAgents,
    hasMoreAgents: snapshot.hasMoreAgents,
    runsReturned: snapshot.runs.length,
    runsLimit: RUN_CAP,
    totalRuns: snapshot.totalRuns,
    hasMoreRuns: snapshot.hasMoreRuns,
    metricsScope: "full_window_aggregates",
    anomalyScanRuns: snapshot.runs.length,
    anomalyScanLimit: RUN_CAP,
    rawLogsAvailable: false,
    eventsAvailable: false,
    notes: [
      "Outcome and reported-cost totals use company-scoped aggregates for the full window.",
      "Failure rows and suspected anomalies scan at most the newest 1000 runs; raw event streams and logs are unavailable.",
      "Only reported cost_events are counted; unpriced, missing, and subscription billing are not treated as zero usage.",
    ],
  };
}

function makeAnomalies(snapshot) {
  const names = new Map(snapshot.agents.map((agent) => [agent.id, agent.name]));
  const anomalies = [];
  const wakeGroups = new Map();
  const issueGroups = new Map();
  const errorGroups = new Map();

  for (const run of snapshot.runs) {
    if (run.wakeupRequestId) {
      const key = `${run.agentId}:${run.wakeupRequestId}`;
      wakeGroups.set(key, [...(wakeGroups.get(key) ?? []), run]);
    }
    if (typeof run.issueId === "string" && UUID.test(run.issueId)) {
      const key = `${run.agentId}:${run.issueId}`;
      issueGroups.set(key, [...(issueGroups.get(key) ?? []), run]);
    }
    const fingerprint = errorFingerprint(run.errorCode);
    if (FAILURE_STATUS(run.status) && fingerprint) {
      const key = `${run.agentId}:${fingerprint}`;
      errorGroups.set(key, [...(errorGroups.get(key) ?? []), run]);
    }
    const created = asDate(run.createdAt);
    const lastAction = asDate(run.lastUsefulActionAt) ?? asDate(run.startedAt) ?? created;
    if (ACTIVE_STATUSES.has(run.status) && created && lastAction && snapshot.now - lastAction >= 1800000) {
      anomalies.push(oneRunAnomaly("no_progress", "medium", run, names, {
        runStatus: run.status,
        lastUsefulActionAt: iso(lastAction),
        staleMinutes: Math.floor((snapshot.now - lastAction) / 60000),
      }, "Active run has no recent useful-action timestamp."));
    }
    const cost = snapshot.costByRun.get(run.id);
    if (Number.isFinite(cost) && cost >= 1000) {
      anomalies.push(oneRunAnomaly("expensive_run", cost >= 5000 ? "high" : "medium", run, names, {
        knownCostCents: cost,
        thresholdCents: 1000,
      }, "Reported run cost exceeds the 1000-cent heuristic threshold."));
    }
  }

  for (const group of wakeGroups.values()) {
    if (group.length < 2) continue;
    const ids = new Set(group.map((run) => run.id));
    const retryLinked = new Set();
    for (const run of group) if (run.retryOfRunId && ids.has(run.retryOfRunId)) {
      retryLinked.add(run.id);
      retryLinked.add(run.retryOfRunId);
    }
    const independent = group.filter((run) => !retryLinked.has(run.id));
    if (independent.length >= 2) anomalies.push(groupAnomaly("duplicate_wake_suspected", "low", independent, names, {
      wakeupRequestId: group[0].wakeupRequestId,
      count: independent.length,
      retryLinkedRunsExcluded: retryLinked.size,
    }, "Unlinked runs share a wakeup request; this may still be a valid replay."));
  }
  for (const group of issueGroups.values()) {
    if (group.length < 3) continue;
    const ordered = [...group].sort((a, b) => (asDate(a.createdAt)?.getTime() ?? 0) - (asDate(b.createdAt)?.getTime() ?? 0));
    const span = (asDate(ordered.at(-1).createdAt)?.getTime() ?? 0) - (asDate(ordered[0].createdAt)?.getTime() ?? 0);
    if (span <= 600000) anomalies.push(groupAnomaly("repeated_wakes", "medium", group, names, {
      issueId: group[0].issueId,
      count: group.length,
      spanMinutes: Math.round(span / 60000),
    }, "Several runs for the same issue occurred within ten minutes."));
  }
  for (const group of errorGroups.values()) if (group.length >= 3) {
    anomalies.push(groupAnomaly("repeated_error", "medium", group, names, {
      count: group.length,
      errorCode: safeError(group[0].errorCode),
    }, "The same safe error code occurred repeatedly."));
  }
  return anomalies.sort((a, b) => (asDate(b.occurredAt)?.getTime() ?? 0) - (asDate(a.occurredAt)?.getTime() ?? 0));
}

function FAILURE_STATUS(status) {
  return ["failed", "timed_out", "error"].includes(status);
}

function oneRunAnomaly(kind, severity, run, names, evidence, description) {
  return {
    id: `${kind}:${run.id}`,
    kind,
    severity,
    suspected: true,
    agentId: run.agentId,
    agentName: names.get(run.agentId) ?? "Unknown agent",
    runIds: [run.id],
    occurredAt: iso(run.finishedAt ?? run.createdAt),
    occurrences: 1,
    evidence,
    description,
  };
}

function groupAnomaly(kind, severity, runs, names, evidence, description) {
  const latest = [...runs].sort((a, b) => (asDate(b.createdAt)?.getTime() ?? 0) - (asDate(a.createdAt)?.getTime() ?? 0))[0];
  return {
    id: `${kind}:${latest.id}`,
    kind,
    severity,
    suspected: true,
    agentId: latest.agentId,
    agentName: names.get(latest.agentId) ?? "Unknown agent",
    runIds: [...new Set(runs.map((run) => run.id))].slice(0, 20),
    occurredAt: iso(latest.createdAt),
    occurrences: runs.length,
    evidence,
    description,
  };
}

function paginate(items, pagination) {
  const itemsPage = items.slice(pagination.offset, pagination.offset + pagination.limit);
  return { items: itemsPage, pagination: { total: items.length, limit: pagination.limit, offset: pagination.offset, hasMore: pagination.offset + itemsPage.length < items.length } };
}

export async function getOverview(ctx, companyValue, windowHours = 24) {
  const snapshot = await readSnapshot(ctx, companyValue, windowHours);
  const names = new Map(snapshot.agents.map((agent) => [agent.id, agent.name]));
  const runFailures = snapshot.runs.filter((run) => FAILURE_STATUS(run.status)).map((run) => safeRun(run, names, snapshot.costByRun));
  const failures = runFailures.slice(0, 100);
  const anomalies = makeAnomalies(snapshot);
  const knownCostCents = [...snapshot.costByAgent.values()].reduce((sum, value) => sum + value, 0);
  const aggregate = snapshot.summary;
  return {
    companyId: snapshot.companyId,
    windowHours: snapshot.windowHours,
    generatedAt: snapshot.now.toISOString(),
    quality: snapshot.quality,
    coverage: {
      ...coverage(snapshot),
      failureRowsReturned: failures.length,
      failureRowsLimit: 100,
      hasMoreFailureRows: runFailures.length > failures.length || snapshot.hasMoreRuns,
      anomalyRowsReturned: Math.min(anomalies.length, 100),
      anomalyRowsLimit: 100,
      hasMoreAnomalyRows: anomalies.length > 100 || snapshot.hasMoreRuns,
    },
    summary: {
      agentsTotal: snapshot.totalAgents,
      runsTotal: Number(aggregate.runs ?? 0),
      successes: Number(aggregate.successes ?? 0),
      failures: Number(aggregate.failures ?? 0),
      interrupted: Number(aggregate.interrupted ?? 0),
      retries: Number(aggregate.retries ?? 0),
      knownCostCents,
      unknownCostRuns: Number(aggregate.unknownCostRuns ?? 0),
      avgDurationMs: aggregate.avgDurationMs == null ? null : Number(aggregate.avgDurationMs),
    },
    agents: snapshot.agents.map((agent) => summarizeAgent(agent, snapshot)),
    failures,
    anomalies: anomalies.slice(0, 100),
  };
}

export async function listAgents(ctx, companyValue, pagination = parsePage(), windowHours = 24) {
  const snapshot = await readSnapshot(ctx, companyValue, windowHours, pagination);
  return {
    companyId: snapshot.companyId,
    windowHours: snapshot.windowHours,
    items: snapshot.agents.map((agent) => summarizeAgent(agent, snapshot)),
    pagination: {
      total: snapshot.totalAgents,
      limit: pagination.limit,
      offset: pagination.offset,
      hasMore: snapshot.hasMoreAgents,
    },
    coverage: coverage(snapshot),
  };
}

export async function getAgent(ctx, companyValue, agentValue, windowHours = 24) {
  const companyId = uuid(companyValue, "companyId");
  const agentId = uuid(agentValue, "agentId");
  const snapshot = await readSnapshot(ctx, companyId, windowHours, undefined, agentId);
  const query = dbQuery(ctx);
  const rows = await query("SELECT a.id, a.name, a.status FROM public.agents a WHERE a.company_id = $1 AND a.id = $2 LIMIT 1", [companyId, agentId]);
  if (!rows[0]) throw notFound("Agent not found in this company");
  const names = new Map([...snapshot.agents, rows[0]].map((agent) => [agent.id, agent.name]));
  const recentRows = await query(`SELECT ${RUN_COLUMNS} FROM public.heartbeat_runs r WHERE r.company_id = $1 AND r.agent_id = $2 AND r.created_at >= $3 ORDER BY r.created_at DESC, r.id DESC LIMIT 20`, [companyId, agentId, snapshot.windowStart]);
  const recentIds = recentRows.map((run) => run.id);
  const recentCosts = await queryRunCosts(query, companyId, recentIds, snapshot.windowStart);
  const recentCostMap = new Map(snapshot.costByRun);
  for (const row of recentCosts) recentCostMap.set(row.runId, Number(row.knownCostCents ?? 0));
  const pageSnapshot = { ...snapshot, agents: [rows[0]] };
  return {
    companyId,
    windowHours: snapshot.windowHours,
    agent: summarizeAgent(rows[0], pageSnapshot),
    recentRuns: recentRows.map((run) => safeRun(run, names, recentCostMap)),
    coverage: coverage(snapshot),
  };
}

export async function getFailures(ctx, companyValue, windowHours = 24, pagination = parsePage()) {
  const snapshot = await readSnapshot(ctx, companyValue, windowHours);
  const names = new Map(snapshot.agents.map((agent) => [agent.id, agent.name]));
  const failures = snapshot.runs.filter((run) => FAILURE_STATUS(run.status)).map((run) => safeRun(run, names, snapshot.costByRun));
  return { companyId: snapshot.companyId, windowHours: snapshot.windowHours, ...paginate(failures, pagination), coverage: coverage(snapshot) };
}

export async function getAnomalies(ctx, companyValue, windowHours = 24, pagination = parsePage()) {
  const snapshot = await readSnapshot(ctx, companyValue, windowHours);
  return { companyId: snapshot.companyId, windowHours: snapshot.windowHours, ...paginate(makeAnomalies(snapshot), pagination), coverage: coverage(snapshot) };
}

export async function getTrace(ctx, companyValue, runValue, windowHours = 24) {
  const companyId = uuid(companyValue, "companyId");
  const runId = uuid(runValue, "runId");
  const query = dbQuery(ctx);
  const rows = await query(`SELECT ${TRACE_COLUMNS}, a.name AS "agentName" FROM public.heartbeat_runs r
    JOIN public.agents a ON a.id = r.agent_id AND a.company_id = r.company_id
    WHERE r.company_id = $1 AND r.id = $2 LIMIT 1`, [companyId, runId]);
  if (!rows[0]) throw notFound("Run not found in this company");
  const selected = rows[0];
  const related = await query(`SELECT ${TRACE_COLUMNS}, a.name AS "agentName" FROM public.heartbeat_runs r
    JOIN public.agents a ON a.id = r.agent_id AND a.company_id = r.company_id
    WHERE r.company_id = $1 AND (r.id = $2 OR r.retry_of_run_id = $2 OR r.id = $3)
    ORDER BY r.created_at ASC, r.id ASC LIMIT 25`, [companyId, runId, selected.retryOfRunId ?? runId]);
  const runCostRows = await query(`SELECT SUM(c.cost_cents)::bigint AS "knownCostCents" FROM public.cost_events c
    WHERE c.company_id = $1 AND c.heartbeat_run_id = $2 AND c.cost_status = 'reported'`, [companyId, runId]);
  const retryCountRows = await query(`SELECT COUNT(*)::int AS count FROM public.heartbeat_runs r WHERE r.company_id = $1 AND r.retry_of_run_id = $2`, [companyId, runId]);
  const cost = runCostRows[0]?.knownCostCents;
  const costMap = new Map(cost == null ? [] : [[runId, Number(cost)]]);
  const safe = safeRun(selected, new Map([[selected.agentId, selected.agentName]]), costMap);
  const retryChain = related.map((row) => safeRun(row, new Map([[row.agentId, row.agentName]]), costMap));
  return {
    companyId,
    windowHours: normalizeWindowHours(windowHours),
    run: { ...safe, retryCount: Number(retryCountRows[0]?.count ?? 0) },
    timeline: [
      { type: "created", at: safe.createdAt },
      ...(safe.startedAt ? [{ type: "started", at: safe.startedAt }] : []),
      ...(safe.finishedAt ? [{ type: "finished", at: safe.finishedAt }] : []),
    ],
    retryChain,
    coverage: { source: "database", rawLogsAvailable: false, eventsAvailable: false, notes: ["Safe lifecycle fields only; raw logs and event streams are not exposed."] },
  };
}

export async function getDeliveryQuality(ctx, companyValue, options = {}) {
  const companyId = uuid(companyValue, "companyId");
  const days = Number(options.days ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw badRequest("days must be 1–365");
  const agentId = options.agentId == null ? null : uuid(options.agentId, "agentId");
  if (!["production", "skill_test"].includes(options.environment ?? "production")) throw badRequest("Invalid quality environment");
  const end = new Date().toISOString();
  const quality = await readDeliveryQuality(ctx, companyId, { start: new Date(Date.parse(end) - days * 86400000).toISOString(), end, agentId, environment: options.environment ?? "production" });
  return { ...quality, agentId };
}
