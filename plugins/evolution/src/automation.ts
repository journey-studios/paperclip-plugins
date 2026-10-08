import { type PluginContext, type PluginEvent, type PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { sanitizeSnapshot, sanitizeTextSnapshot } from "./snapshot-safety.js";
import { assessChangeMetrics, type AssessmentMetric } from "./assessment.js";
import manifest from "./manifest.js";

type Overview = { changeSets: Record<string, unknown>[]; counts: Record<string, number> };
export type AutomationDependencies = {
  assertChangeSet: (ctx: PluginContext, companyId: string, changeSetId: string) => Promise<void>;
  attachRunContext: (ctx: PluginContext, companyId: string, changeSetId: string, runId: string | null) => Promise<void>;
  authorizedCompanyId: (params: Record<string, unknown>, context: PluginPerformActionContext) => string;
  asRecord: (value: unknown) => Record<string, unknown>;
  getOverview: (ctx: PluginContext, companyId: string) => Promise<Overview>;
  requiredIso: (value: unknown) => string;
  recomputeMetrics: (ctx: PluginContext, companyId: string, changeSetId: string) => Promise<unknown>;
};

export function registerAutomation(ctx: PluginContext, deps: AutomationDependencies) {
  const { assertChangeSet, asRecord, attachRunContext, authorizedCompanyId, getOverview, recomputeMetrics, requiredIso } = deps;

  const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "timed_out", "cancelled"];

  async function insertAutomaticRunEvidence(ctx: PluginContext, companyId: string, changeSetId: string, runId: string): Promise<boolean> {
    // Confirm run/company/agent/time on the host; never trust an event's payload for identity or verdict.
    const rows = await ctx.db.query<{ id: string; status: string; startedAt: string | Date }>(
      'SELECT r.id, r.status, r.started_at AS "startedAt" FROM public.heartbeat_runs r ' +
        'JOIN change_items ci ON ci.company_id = r.company_id AND ci.entity_type = \'agent\' AND ci.entity_id = r.agent_id::text ' +
        'JOIN change_sets cs ON cs.company_id = ci.company_id AND cs.id = ci.change_set_id ' +
        'WHERE r.company_id = $1 AND r.id::text = $2 AND cs.id = $3 AND r.status IN (\'succeeded\',\'failed\',\'timed_out\',\'cancelled\') ' +
        'AND r.started_at >= cs.applied_at AND r.started_at < LEAST(coalesce(cs.validation_ends_at, cs.applied_at + interval \'7 days\'), cs.applied_at + interval \'7 days\') ' +
        'AND cs.source_context_key IS DISTINCT FROM (\'run:\' || r.id::text) LIMIT 1',
      [companyId, runId, changeSetId],
    );
    const run = rows[0];
    if (!run || !TERMINAL_RUN_STATUSES.includes(run.status)) return false;
    // Curated manual run evidence takes priority. Unique partial index protects duplicate event deliveries.
    const existing = await ctx.db.query<{ id: string }>(
      'SELECT id FROM change_evidence WHERE company_id = $1 AND change_set_id = $2 AND evidence_type = \'run\' AND reference_id = $3 LIMIT 1',
      [companyId, changeSetId, runId],
    );
    if (existing[0]) return false;
    const inserted = await ctx.db.execute(
      'INSERT INTO change_evidence (id, company_id, change_set_id, evidence_type, reference_id, label, verdict, notes, metadata, observed_at) ' +
        'VALUES ($1,$2,$3,\'run\',$4,\'Run observed automatically\',\'neutral\',\'Execution outcome is not proof of improvement.\',$5::jsonb,$6::timestamptz) ' +
        'ON CONFLICT DO NOTHING',
      [globalThis.crypto.randomUUID(), companyId, changeSetId, runId, JSON.stringify({ capture: "automatic", status: run.status }), requiredIso(run.startedAt)],
    );
    if (inserted.rowCount === 0) return false;
    await attachRunContext(ctx, companyId, changeSetId, runId);
    return true;
  }

  async function assessSet(ctx: PluginContext, companyId: string, changeSetId: string) {
    const sets = await ctx.db.query<{ appliedAt: string | Date; validationEndsAt: string | Date | null }>(
      'SELECT applied_at AS "appliedAt", validation_ends_at AS "validationEndsAt" FROM change_sets WHERE company_id = $1 AND id = $2 LIMIT 1',
      [companyId, changeSetId],
    );
    if (!sets[0]) throw new Error("Change Set not found");
    const appliedAt = requiredIso(sets[0].appliedAt);
    const evaluatedAt = new Date().toISOString();
    const appliedTime = Date.parse(appliedAt);
    const boundedEnd = Math.min(Date.now(), appliedTime + 7 * 86400_000,
      sets[0].validationEndsAt ? Date.parse(requiredIso(sets[0].validationEndsAt)) : Infinity);
    const observedThrough = new Date(boundedEnd).toISOString();
    const [metrics, overlaps, evidence] = await Promise.all([
      ctx.db.query<AssessmentMetric>(
        'SELECT metric_key AS "metricKey", baseline_value::float AS "baselineValue", current_value::float AS "currentValue", ' +
          'baseline_sample_size AS "baselineSampleSize", current_sample_size AS "currentSampleSize" ' +
          'FROM change_metrics WHERE company_id = $1 AND change_set_id = $2',
        [companyId, changeSetId],
      ),
      ctx.db.query<{ overlappingChanges: number }>(
        'SELECT count(DISTINCT newer.id)::int AS "overlappingChanges" FROM change_sets subject ' +
          'JOIN change_items affected ON affected.company_id = subject.company_id AND affected.change_set_id = subject.id AND affected.entity_type = \'agent\' ' +
          'JOIN change_items changed ON changed.company_id = affected.company_id AND changed.entity_type = \'agent\' AND changed.entity_id = affected.entity_id ' +
          'JOIN change_sets newer ON newer.company_id = changed.company_id AND newer.id = changed.change_set_id ' +
          'WHERE subject.company_id = $1 AND subject.id = $2 AND newer.id <> subject.id ' +
          'AND newer.applied_at > subject.applied_at AND newer.applied_at < LEAST(coalesce(subject.validation_ends_at, subject.applied_at + interval \'7 days\'), subject.applied_at + interval \'7 days\', now())',
        [companyId, changeSetId],
      ),
      ctx.db.query<{ total: number }>(
        'SELECT count(*)::int AS total FROM change_evidence WHERE company_id = $1 AND change_set_id = $2',
        [companyId, changeSetId],
      ),
    ]);
    const result = assessChangeMetrics(metrics, appliedAt, observedThrough, Number(overlaps[0]?.overlappingChanges ?? 0));
    const evidenceCount = Number(evidence[0]?.total ?? 0);
    await ctx.db.execute(
      'INSERT INTO change_assessments (id, company_id, change_set_id, outcome, confidence, reason_code, summary, signals, baseline_run_count, current_run_count, evidence_count, evaluated_at) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::timestamptz) ' +
        'ON CONFLICT (company_id, change_set_id) DO UPDATE SET outcome=excluded.outcome, confidence=excluded.confidence, reason_code=excluded.reason_code, ' +
        'summary=excluded.summary, signals=excluded.signals, baseline_run_count=excluded.baseline_run_count, current_run_count=excluded.current_run_count, ' +
        'evidence_count=excluded.evidence_count, evaluated_at=excluded.evaluated_at',
      [globalThis.crypto.randomUUID(), companyId, changeSetId, result.outcome, result.confidence, result.reasonCode, result.summary,
        JSON.stringify(result.signals), result.baselineRunCount, result.currentRunCount, evidenceCount, evaluatedAt],
    );
    return { ...result, evidenceCount, evaluatedAt, causality: "observational_only" as const };
  }

  async function refreshSet(ctx: PluginContext, companyId: string, changeSetId: string) {
    await assertChangeSet(ctx, companyId, changeSetId);
    const recentRuns = await ctx.db.query<{ id: string }>(
      'SELECT DISTINCT r.id, r.started_at FROM public.heartbeat_runs r ' +
        'JOIN change_items ci ON ci.company_id = r.company_id AND ci.entity_type = \'agent\' AND ci.entity_id = r.agent_id::text ' +
        'JOIN change_sets cs ON cs.company_id = ci.company_id AND cs.id = ci.change_set_id ' +
        'WHERE cs.company_id = $1 AND cs.id = $2 AND r.status IN (\'succeeded\',\'failed\',\'timed_out\',\'cancelled\') ' +
        'AND r.started_at >= cs.applied_at AND r.started_at < LEAST(coalesce(cs.validation_ends_at, cs.applied_at + interval \'7 days\'), cs.applied_at + interval \'7 days\') ' +
        'AND cs.source_context_key IS DISTINCT FROM (\'run:\' || r.id::text) ORDER BY r.started_at DESC, r.id DESC LIMIT 150',
      [companyId, changeSetId],
    );
    let capturedRuns = 0;
    for (const row of recentRuns) {
      if (await insertAutomaticRunEvidence(ctx, companyId, changeSetId, row.id)) capturedRuns++;
    }
    await recomputeMetrics(ctx, companyId, changeSetId);
    return { capturedRuns, assessment: await assessSet(ctx, companyId, changeSetId) };
  }

  async function onRunTerminal(ctx: PluginContext, event: PluginEvent) {
    const payload = asRecord(event.payload);
    const runId = typeof payload.runId === "string" ? payload.runId : event.entityId;
    if (!runId) return;
    const rows = await ctx.db.query<{ changeSetId: string }>(
      'SELECT DISTINCT cs.id AS "changeSetId" FROM public.heartbeat_runs r ' +
        'JOIN change_items ci ON ci.company_id = r.company_id AND ci.entity_type = \'agent\' AND ci.entity_id = r.agent_id::text ' +
        'JOIN change_sets cs ON cs.company_id = ci.company_id AND cs.id = ci.change_set_id ' +
        'WHERE r.company_id = $1 AND r.id::text = $2 AND cs.status IN (\'applied\',\'validating\',\'inconclusive\') ' +
        'AND r.started_at >= cs.applied_at AND r.started_at < LEAST(coalesce(cs.validation_ends_at, cs.applied_at + interval \'7 days\'), cs.applied_at + interval \'7 days\') ' +
        'AND cs.source_context_key IS DISTINCT FROM (\'run:\' || r.id::text) ORDER BY cs.id LIMIT 30',
      [event.companyId, runId],
    );
    for (const row of rows) {
      try {
        await insertAutomaticRunEvidence(ctx, event.companyId, row.changeSetId, runId);
        await recomputeMetrics(ctx, event.companyId, row.changeSetId);
        await assessSet(ctx, event.companyId, row.changeSetId);
      } catch {
        // A failed Change Set must not leave every other eligible set stale.
        ctx.logger.warn("Org Tracker run evidence refresh failed", { changeSetId: row.changeSetId });
      }
    }
  }

  async function refreshCompany(ctx: PluginContext, companyId: string) {
    const rows = await ctx.db.query<{ id: string }>(
      'SELECT cs.id FROM change_sets cs WHERE cs.company_id = $1 AND cs.status IN (\'applied\',\'validating\',\'inconclusive\') ' +
        'AND cs.applied_at >= now() - interval \'8 days\' ' +
        'AND EXISTS (SELECT 1 FROM change_items ci WHERE ci.company_id = cs.company_id AND ci.change_set_id = cs.id AND ci.entity_type = \'agent\') ' +
        'ORDER BY cs.applied_at DESC LIMIT 30',
      [companyId],
    );
    for (const row of rows) {
      try { await refreshSet(ctx, companyId, row.id); }
      catch { ctx.logger.warn("Org Tracker assessment refresh failed", { changeSetId: row.id }); }
    }
  }
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function requiredUuidParam(params: unknown): string {
    const changeSetId = asRecord(params).changeSetId;
    if (typeof changeSetId !== "string" || !UUID_PATTERN.test(changeSetId)) throw new Error("Invalid Change Set ID");
    return changeSetId;
  }

  async function safeChangeSummary(ctx: PluginContext, companyId: string, changeSetId: string) {
    const set = await ctx.db.query<Record<string, unknown>>(
      'SELECT cs.id, cs.title, cs.status, cs.hypothesis, cs.causality_level AS "causalityLevel", cs.applied_at AS "appliedAt", ' +
        'ca.outcome AS "assessmentOutcome", ca.confidence AS "assessmentConfidence", ca.reason_code AS "assessmentReason", ' +
        'ca.summary AS "assessmentSummary", ca.evaluated_at AS "assessmentEvaluatedAt" ' +
        'FROM change_sets cs LEFT JOIN change_assessments ca ON ca.company_id = cs.company_id AND ca.change_set_id = cs.id ' +
        'WHERE cs.company_id = $1 AND cs.id = $2 LIMIT 1',
      [companyId, changeSetId],
    );
    if (!set[0]) throw new Error("Change Set not found");
    const [affected, metrics, evidence, conclusion] = await Promise.all([
      ctx.db.query<Record<string, unknown>>(
        'SELECT DISTINCT entity_type AS "entityType", entity_id AS "entityId", entity_name AS "entityName" ' +
          'FROM change_items WHERE company_id = $1 AND change_set_id = $2 ORDER BY "entityType", "entityId" LIMIT 30',
        [companyId, changeSetId],
      ),
      ctx.db.query<Record<string, unknown>>(
        'SELECT metric_key AS "metricKey", baseline_value::float AS "baselineValue", current_value::float AS "currentValue", ' +
          'delta_value::float AS "deltaValue", baseline_sample_size AS "baselineSampleSize", current_sample_size AS "currentSampleSize", unit ' +
          'FROM change_metrics WHERE company_id = $1 AND change_set_id = $2 ORDER BY metric_key LIMIT 12',
        [companyId, changeSetId],
      ),
      ctx.db.query<{ evidenceType: string; total: number }>(
        'SELECT evidence_type AS "evidenceType", count(*)::int AS total FROM change_evidence ' +
          'WHERE company_id = $1 AND change_set_id = $2 GROUP BY evidence_type ORDER BY evidence_type LIMIT 15',
        [companyId, changeSetId],
      ),
      ctx.db.query<{ outcome: string; confidence: string; summary: string }>(
        'SELECT outcome, confidence, summary FROM change_conclusions WHERE company_id = $1 AND change_set_id = $2 ' +
          'ORDER BY created_at DESC LIMIT 1',
        [companyId, changeSetId],
      ),
    ]);
    return sanitizeSnapshot({
      changeSet: set[0], affected, metrics, evidence,
      latestHumanConclusion: conclusion[0] ? { outcome: conclusion[0].outcome, confidence: conclusion[0].confidence,
        summary: sanitizeTextSnapshot(conclusion[0].summary, 800) } : null,
      caveat: "Automatic assessments are observational and never establish causality.",
    });
  }

  function registerTools(ctx: PluginContext) {
    const definitions = manifest.tools ?? [];
    const register = (name: string, handler: (params: unknown, companyId: string) => Promise<unknown>) => {
      const declaration = definitions.find((tool) => tool.name === name);
      if (!declaration) throw new Error("Missing Org Tracker tool manifest declaration");
      ctx.tools.register(name, declaration, async (params, runContext) => {
        if (!runContext.companyId) return { error: "Authorized company context is required" };
        try {
          const data = await handler(params, runContext.companyId);
          return { content: JSON.stringify(data), data };
        } catch {
          ctx.logger.warn("Org Tracker tool invocation failed", { tool: name });
          return { error: "Org Tracker data unavailable or Change Set not found" };
        }
      });
    };
    register("org_tracker_list_changes", async (params, companyId) => {
      const rawLimit = asRecord(params).limit;
      const limit = typeof rawLimit === "number" && Number.isInteger(rawLimit) ? Math.min(50, Math.max(1, rawLimit)) : 20;
      const result = await getOverview(ctx, companyId);
      return sanitizeSnapshot({
        changeSets: result.changeSets.slice(0, limit).map((set) => ({
          id: set.id, title: set.title, status: set.status, causalityLevel: set.causalityLevel, appliedAt: set.appliedAt,
          assessmentOutcome: set.assessmentOutcome, assessmentReason: set.assessmentReason,
          itemCount: set.itemCount, evidenceCount: set.evidenceCount,
        })),
        counts: result.counts,
        caveat: "Automatic assessment does not establish causality.",
      });
    });
    register("org_tracker_change_summary", async (params, companyId) => safeChangeSummary(ctx, companyId, requiredUuidParam(params)));
    register("org_tracker_evaluate_change", async (params, companyId) => {
      const changeSetId = requiredUuidParam(params);
      return { changeSetId, ...(await refreshSet(ctx, companyId, changeSetId)) };
    });
  }
  async function refreshAllCompanies(ctx: PluginContext) {
    const companies = await ctx.db.query<{ companyId: string }>(
      'SELECT DISTINCT company_id AS "companyId" FROM change_sets WHERE applied_at >= now() - interval \'8 days\' ORDER BY "companyId" LIMIT 50',
    );
    for (const company of companies) {
      try { await refreshCompany(ctx, company.companyId); }
      catch { ctx.logger.warn("Org Tracker company refresh failed", { companyId: company.companyId }); }
    }
  }

  ctx.actions.register("refresh-assessment", async (params, actionContext) =>
    refreshSet(ctx, authorizedCompanyId(params, actionContext), requiredUuidParam(params)));
  ctx.jobs.register("refresh-assessments", async () => refreshAllCompanies(ctx));
  for (const kind of ["agent.run.finished", "agent.run.failed", "agent.run.cancelled"] as const) {
    ctx.events.on(kind, async (event) => onRunTerminal(ctx, event));
  }
  registerTools(ctx);
  return { assessSet };
}
