import { createPluginMcpEndpoint } from "../../../shared/mcp/index.js";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type PluginPerformActionContext,
} from "@paperclipai/plugin-sdk";
import {
  agentActivitySnapshot,
  captureTimestamp,
  isRevisionProducingActivity,
  revisionReferenceFromActivity,
  RUN_METRIC_AGGREGATION_SQL,
  skillActivitySnapshot,
  sourceItemExists,
  sourceSnapshotId,
} from "./capture.mjs";
import { sanitizeSnapshot, sanitizeTextSnapshot } from "./snapshot-safety.js";
import { assessChangeMetrics, type AssessmentMetric } from "./assessment.js";
import manifest from "./manifest.js";

const CHANGE_STATUSES = new Set([
  "draft",
  "applied",
  "validating",
  "proven",
  "regressed",
  "inconclusive",
  "reverted",
]);
const CAUSALITY_LEVELS = new Set(["observed", "associated", "validated"]);
const EVIDENCE_VERDICTS = new Set(["positive", "neutral", "negative"]);
const CONFIDENCE_LEVELS = new Set(["low", "moderate", "high"]);
const SKILL_ACTIVITY_ACTIONS = new Set([
  "company.skill_created",
  "company.skill_updated",
  "company.skill_version_created",
  "company.skill_file_updated",
  "company.skill_file_deleted",
  "company.skill_deleted",
  "company.skill_forked",
  "company.skill_renamed",
  "company.skill_update_installed",
  "company.skill_reset",
  "plugin.managed_skill.reconciled",
  "plugin.managed_skill.reset",
]);
const AGENT_ACTIVITY_ACTIONS = new Set([
  "agent.skills_synced",
  "agent.permissions_updated",
  "agent.config_rolled_back",
  "agent.budget_updated",
  "plugin.managed_agent.reset",
]);
const EVOLUTION_TABLES = [
  "change_sets",
  "change_snapshots",
  "change_items",
  "change_links",
  "change_evidence",
  "change_metrics",
  "change_conclusions",
  "change_assessments",
  "merge_operations",
] as const;

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = stringParam(params, key);
  if (!value) throw new Error(key + " is required");
  return value;
}

function authorizedCompanyId(params: Record<string, unknown>, context: PluginPerformActionContext): string {
  const companyId = requiredString(params, "companyId");
  if (!context.companyId || context.companyId !== companyId) {
    throw new Error("Authorized company scope is required");
  }
  return companyId;
}

function selectedChangeItemIds(params: Record<string, unknown>): string[] {
  const value = params.changeItemIds;
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) {
    throw new Error("changeItemIds must contain between 1 and 200 UUIDs");
  }
  const ids = value.map((id) => typeof id === "string" ? id.trim().toLowerCase() : "");
  if (ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) {
    throw new Error("changeItemIds must contain valid UUIDs");
  }
  if (new Set(ids).size !== ids.length) throw new Error("changeItemIds must not contain duplicates");
  return ids.sort();
}

function qualifyEvolutionTables(statement: string, namespace: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(namespace)) throw new Error("Invalid Evolution database namespace");
  const tables = EVOLUTION_TABLES.join("|");
  const tableReference = new RegExp(`\\b(from|join|into|update|references)\\s+((?:[A-Za-z_][A-Za-z0-9_]*)\\.)?(${tables})\\b`, "gi");
  return statement.replace(tableReference, (match, keyword: string, schema: string | undefined, table: string) =>
    schema ? match : `${keyword} ${namespace}.${table}`,
  );
}

export function withEvolutionDatabaseNamespace(ctx: PluginContext): PluginContext {
  const namespace = ctx.db.namespace;
  return {
    ...ctx,
    db: {
      ...ctx.db,
      query: (statement, params) => ctx.db.query(qualifyEvolutionTables(statement, namespace), params),
      execute: (statement, params) => ctx.db.execute(qualifyEvolutionTables(statement, namespace), params),
    },
  };
}

function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function iso(value: unknown): string | null {
  return captureTimestamp(value);
}

function requiredIso(value: unknown): string {
  const timestamp = iso(value);
  if (!timestamp) throw new Error("Invalid timestamp in Evolution data");
  return timestamp;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return /(^|_)(api_?key|access_token|refresh_token|id_token|token|secret|password|credential|authorization|cookie)($|_)/.test(normalized);
}

function sanitize(value: unknown, key = ""): unknown {
  if (isSensitiveKey(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = sanitize(childValue, childKey);
    }
    return out;
  }
  return value;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortDeep(item)]),
    );
  }
  return value;
}

function snapshotHash(value: unknown): string {
  const text = JSON.stringify(sortDeep(value));
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}

function bucketContext(
  occurredAt: string,
  actorType?: string | null,
  actorId?: string | null,
  runId?: string | null,
): string {
  if (runId) return "run:" + runId;
  const millis = Date.parse(occurredAt);
  const bucket = Number.isFinite(millis) ? Math.floor(millis / (30 * 60 * 1000)) : 0;
  return "actor:" + (actorType ?? "unknown") + ":" + (actorId ?? "unknown") + ":" + String(bucket);
}

function humanTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString().replace("T", " ").slice(0, 16) + " UTC"
    : value;
}

async function ensureChangeSet(
  ctx: PluginContext,
  input: {
    companyId: string;
    sourceContextKey: string;
    occurredAt: string;
    actorType?: string | null;
    actorId?: string | null;
    title?: string;
  },
): Promise<string> {
  const existing = await ctx.db.query<{ id: string }>(
    'SELECT id FROM change_sets WHERE company_id = $1 AND source_context_key = $2 LIMIT 1',
    [input.companyId, input.sourceContextKey],
  );
  if (existing[0]) return existing[0].id;

  const id = globalThis.crypto.randomUUID();
  await ctx.db.execute(
    'INSERT INTO change_sets (id, company_id, title, status, causality_level, source_context_key, applied_at, created_by_type, created_by_id) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9) ON CONFLICT DO NOTHING',
    [
      id,
      input.companyId,
      input.title ?? "Operational changes · " + humanTimestamp(input.occurredAt),
      "applied",
      "observed",
      input.sourceContextKey,
      input.occurredAt,
      input.actorType ?? null,
      input.actorId ?? null,
    ],
  );
  const row = await ctx.db.query<{ id: string }>(
    'SELECT id FROM change_sets WHERE company_id = $1 AND source_context_key = $2 LIMIT 1',
    [input.companyId, input.sourceContextKey],
  );
  if (!row[0]) throw new Error("Could not create Change Set");
  return row[0].id;
}

async function ensureChangeLink(
  ctx: PluginContext,
  companyId: string,
  changeSetId: string,
  linkType: string,
  referenceId: string,
  label?: string | null,
) {
  await ctx.db.execute(
    'INSERT INTO change_links (id, company_id, change_set_id, link_type, reference_id, label) ' +
      'VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
    [globalThis.crypto.randomUUID(), companyId, changeSetId, linkType, referenceId, label ?? null],
  );
}

async function attachRunContext(
  ctx: PluginContext,
  companyId: string,
  changeSetId: string,
  runId: string | null,
) {
  if (!runId) return;
  const rows = await ctx.db.query<{
    runId: string;
    issueId: string | null;
    issueIdentifier: string | null;
    issueTitle: string | null;
    projectId: string | null;
    projectName: string | null;
    goalId: string | null;
    goalTitle: string | null;
  }>(
    'SELECT r.id AS "runId", i.id::text AS "issueId", i.identifier AS "issueIdentifier", i.title AS "issueTitle", ' +
      'p.id::text AS "projectId", p.name AS "projectName", g.id::text AS "goalId", g.title AS "goalTitle" ' +
      'FROM public.heartbeat_runs r ' +
      'LEFT JOIN public.issues i ON i.company_id = r.company_id AND i.id::text = coalesce(r.native_issue_id::text, r.context_snapshot->>\'issueId\') ' +
      'LEFT JOIN public.projects p ON p.company_id = r.company_id AND p.id::text = coalesce(i.project_id::text, r.context_snapshot->>\'projectId\') ' +
      'LEFT JOIN public.goals g ON g.company_id = r.company_id AND g.id::text = coalesce(i.goal_id::text, p.goal_id::text) ' +
      'WHERE r.company_id = $1 AND r.id = $2 LIMIT 1',
    [companyId, runId],
  );
  const row = rows[0];
  if (!row) return;

  await ensureChangeLink(ctx, companyId, changeSetId, "run", row.runId, "Run " + row.runId.slice(0, 8));
  if (row.issueId) {
    const issueLabel = [row.issueIdentifier, row.issueTitle].filter(Boolean).join(" · ");
    await ensureChangeLink(ctx, companyId, changeSetId, "issue", row.issueId, issueLabel || null);
    if (issueLabel) {
      await ctx.db.execute(
        'UPDATE change_sets SET title = $3, updated_at = now() ' +
          'WHERE company_id = $1 AND id = $2 AND title LIKE \'Operational changes · %\'',
        [companyId, changeSetId, issueLabel],
      );
    }
  }
  if (row.projectId) await ensureChangeLink(ctx, companyId, changeSetId, "project", row.projectId, row.projectName);
  if (row.goalId) await ensureChangeLink(ctx, companyId, changeSetId, "goal", row.goalId, row.goalTitle);
}

async function latestSnapshot(
  ctx: PluginContext,
  companyId: string,
  entityType: string,
  entityId: string,
): Promise<{ id: string; snapshotHash: string; snapshot: unknown; sourceType: string; sourceRef: string | null } | null> {
  const rows = await ctx.db.query<{ id: string; snapshotHash: string; snapshot: unknown; sourceType: string; sourceRef: string | null }>(
    'SELECT id, snapshot_hash AS "snapshotHash", snapshot, source_type AS "sourceType", source_ref AS "sourceRef" FROM change_snapshots ' +
      'WHERE company_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY captured_at DESC, created_at DESC LIMIT 1',
    [companyId, entityType, entityId],
  );
  return rows[0] ?? null;
}

async function writeSnapshot(
  ctx: PluginContext,
  input: {
    companyId: string;
    entityType: string;
    entityId: string;
    entityName?: string | null;
    snapshot: unknown;
    sourceType: string;
    sourceRef?: string | null;
    capturedAt: string;
  },
): Promise<string> {
  const clean = sanitizeSnapshot(input.snapshot);
  const hash = snapshotHash(clean);
  const previous = await latestSnapshot(ctx, input.companyId, input.entityType, input.entityId);
  if (previous?.snapshotHash === hash && previous.sourceType === input.sourceType && previous.sourceRef === (input.sourceRef ?? null)) {
    return previous.id;
  }

  const id = globalThis.crypto.randomUUID();
  await ctx.db.execute(
    'INSERT INTO change_snapshots (id, company_id, entity_type, entity_id, entity_name, snapshot_hash, snapshot, source_type, source_ref, captured_at) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::timestamptz)',
    [
      id,
      input.companyId,
      input.entityType,
      input.entityId,
      input.entityName ?? null,
      hash,
      JSON.stringify(clean),
      input.sourceType,
      input.sourceRef ?? null,
      input.capturedAt,
    ],
  );
  return id;
}

async function writeItem(
  ctx: PluginContext,
  input: {
    companyId: string;
    changeSetId: string;
    entityType: string;
    entityId: string;
    entityName?: string | null;
    changeKind: string;
    changedKeys?: unknown[];
    beforeSnapshotId?: string | null;
    afterSnapshotId?: string | null;
    sourceType: string;
    sourceRef?: string | null;
    sourceActivityId?: string | null;
    metadata?: Record<string, unknown>;
    occurredAt: string;
  },
): Promise<boolean> {
  if (input.sourceRef) {
    const prior = await ctx.db.query<{ id: string }>(
      'SELECT id FROM change_items WHERE company_id = $1 AND source_type = $2 AND source_ref = $3 LIMIT 1',
      [input.companyId, input.sourceType, input.sourceRef],
    );
    if (prior[0]) {
      if (input.sourceActivityId) {
        await ctx.db.execute(
          'UPDATE change_items SET source_activity_id = coalesce(source_activity_id, $3) WHERE company_id = $1 AND id = $2',
          [input.companyId, prior[0].id, input.sourceActivityId],
        );
      }
      return false;
    }
  }

  await ctx.db.execute(
    'INSERT INTO change_items ' +
      '(id, company_id, change_set_id, entity_type, entity_id, entity_name, change_kind, changed_keys, before_snapshot_id, after_snapshot_id, source_type, source_ref, source_activity_id, metadata, occurred_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14::jsonb,$15::timestamptz) ON CONFLICT DO NOTHING',
    [
      globalThis.crypto.randomUUID(),
      input.companyId,
      input.changeSetId,
      input.entityType,
      input.entityId,
      input.entityName ?? null,
      input.changeKind,
      JSON.stringify(input.changedKeys ?? []),
      input.beforeSnapshotId ?? null,
      input.afterSnapshotId ?? null,
      input.sourceType,
      input.sourceRef ?? null,
      input.sourceActivityId ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.occurredAt,
    ],
  );
  return true;
}

async function currentAgent(ctx: PluginContext, companyId: string, agentId: string) {
  const rows = await ctx.db.query<{
    id: string;
    name: string;
    role: string | null;
    title: string | null;
    status: string;
    adapterType: string;
    adapterConfig: unknown;
    runtimeConfig: unknown;
    permissions: unknown;
    capabilities: unknown;
    defaultEnvironmentId: string | null;
    budgetMonthlyCents: number;
    updatedAt: string | Date;
  }>(
    'SELECT id, name, role, title, status, adapter_type AS "adapterType", adapter_config AS "adapterConfig", ' +
      'runtime_config AS "runtimeConfig", permissions, capabilities, default_environment_id AS "defaultEnvironmentId", budget_monthly_cents AS "budgetMonthlyCents", updated_at AS "updatedAt" ' +
      'FROM public.agents WHERE company_id = $1 AND id = $2 LIMIT 1',
    [companyId, agentId],
  );
  return rows[0] ?? null;
}

function compactAgentSnapshot(agent: Awaited<ReturnType<typeof currentAgent>>) {
  if (!agent) return {};
  return sanitize({
    name: agent.name,
    role: agent.role,
    title: agent.title,
    status: agent.status,
    adapterType: agent.adapterType,
    adapterConfig: agent.adapterConfig,
    runtimeConfig: agent.runtimeConfig,
    permissions: agent.permissions,
    capabilities: agent.capabilities,
    defaultEnvironmentId: agent.defaultEnvironmentId,
    budgetMonthlyCents: agent.budgetMonthlyCents,
  });
}

async function latestAgentRevisionNear(
  ctx: PluginContext,
  companyId: string,
  agentId: string,
  occurredAt: string,
) {
  const rows = await ctx.db.query<{
    id: string;
    changedKeys: unknown;
    beforeConfig: unknown;
    afterConfig: unknown;
    createdAt: string | Date;
  }>(
    'SELECT id, changed_keys AS "changedKeys", before_config AS "beforeConfig", after_config AS "afterConfig", created_at AS "createdAt" ' +
      'FROM public.agent_config_revisions WHERE company_id = $1 AND agent_id = $2 ' +
      'AND created_at <= $3::timestamptz + interval \'10 seconds\' ' +
      'AND created_at >= $3::timestamptz - interval \'10 seconds\' ORDER BY created_at DESC LIMIT 1',
    [companyId, agentId, occurredAt],
  );
  return rows[0] ?? null;
}

async function agentRevisionById(ctx: PluginContext, companyId: string, agentId: string, revisionId: string) {
  const rows = await ctx.db.query<{
    id: string;
    changedKeys: unknown;
    beforeConfig: unknown;
    afterConfig: unknown;
    createdAt: string | Date;
  }>(
    'SELECT id, changed_keys AS "changedKeys", before_config AS "beforeConfig", after_config AS "afterConfig", created_at AS "createdAt" ' +
      'FROM public.agent_config_revisions WHERE company_id = $1 AND agent_id = $2 AND id::text = $3 LIMIT 1',
    [companyId, agentId, revisionId],
  );
  return rows[0] ?? null;
}

async function recordAgentEvent(ctx: PluginContext, event: PluginEvent) {
  const companyId = event.companyId;
  const agentId = event.entityId;
  if (!companyId || !agentId) return;
  const occurredAt = iso(event.occurredAt);
  if (!occurredAt) return;
  const payload = asRecord(event.payload);
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  const agent = await currentAgent(ctx, companyId, agentId);
  if (!agent) return;

  const explicitRevisionId = revisionReferenceFromActivity(payload);
  const revision = event.eventType === "agent.updated"
    ? explicitRevisionId
      ? await agentRevisionById(ctx, companyId, agentId, explicitRevisionId)
      : await latestAgentRevisionNear(ctx, companyId, agentId, occurredAt)
    : null;
  const temporalRevisionMatch = Boolean(revision && !explicitRevisionId);
  const activityReadAt = new Date().toISOString();
  // Temporal candidates are identified by their plugin event. Their native
  // revision is metadata/evidence only; it must not contend for the canonical
  // revision item's identity or suppress another distinct event.
  const sourceType = revision && !temporalRevisionMatch ? "agent_config_revision" : "plugin_event";
  const sourceRef = revision && !temporalRevisionMatch ? revision.id : event.eventId;
  const existing = await ctx.db.query<{ id: string; changeSetId: string }>(
    'SELECT id, change_set_id AS "changeSetId" FROM change_items WHERE company_id = $1 AND source_type = $2 AND source_ref = $3 LIMIT 1',
    [companyId, sourceType, sourceRef],
  );
  if (existing[0]) {
    const activityId = typeof payload.activityId === "string" ? payload.activityId : null;
    if (revision && explicitRevisionId && activityId) {
      await ctx.db.execute(
        'UPDATE change_items SET source_activity_id = coalesce(source_activity_id, $3), change_kind = $4, ' +
          'metadata = $5::jsonb WHERE company_id = $1 AND id = $2',
        [companyId, existing[0].id, activityId, event.eventType, JSON.stringify({ activityAssociation: "explicit_revision_id" })],
      );
      await attachRunContext(ctx, companyId, existing[0].changeSetId, runId);
    }
    return;
  }

  let beforeId: string | null = null;
  let afterId: string | null = null;
  let changedKeys: unknown[] = [];

  if (revision) {
    changedKeys = asArray(revision.changedKeys);
    beforeId = await writeSnapshot(ctx, {
      companyId,
      entityType: "agent",
      entityId: agentId,
      entityName: agent.name,
      snapshot: revision.beforeConfig,
      sourceType: "agent_config_revision_before",
      sourceRef: revision.id,
      capturedAt: requiredIso(revision.createdAt),
    });
    afterId = await writeSnapshot(ctx, {
      companyId,
      entityType: "agent",
      entityId: agentId,
      entityName: agent.name,
      snapshot: revision.afterConfig,
      sourceType: "agent_config_revision_after",
      sourceRef: revision.id,
      capturedAt: requiredIso(revision.createdAt),
    });
  } else {
    const previous = await latestSnapshot(ctx, companyId, "agent", agentId);
    beforeId = previous?.id ?? null;
    afterId = await writeSnapshot(ctx, {
      companyId,
      entityType: "agent",
      entityId: agentId,
      entityName: agent.name,
      snapshot: agentActivitySnapshot(
        asRecord(compactAgentSnapshot(agent)),
        event.eventType,
        sanitize(payload),
        activityReadAt,
        iso(agent.updatedAt),
      ),
      sourceType: event.eventType,
      sourceRef: event.eventId,
      capturedAt: activityReadAt,
    });
  }

  const itemOccurredAt = temporalRevisionMatch ? occurredAt : revision ? requiredIso(revision.createdAt) : occurredAt;
  const sourceContextKey = bucketContext(itemOccurredAt, event.actorType, event.actorId, temporalRevisionMatch ? null : runId);
  const changeSetId = await ensureChangeSet(ctx, {
    companyId,
    sourceContextKey,
    occurredAt: itemOccurredAt,
    actorType: temporalRevisionMatch ? null : event.actorType,
    actorId: temporalRevisionMatch ? null : event.actorId,
  });
  if (!temporalRevisionMatch) await attachRunContext(ctx, companyId, changeSetId, runId);

  await writeItem(ctx, {
    companyId,
    changeSetId,
    entityType: "agent",
    entityId: agentId,
    entityName: agent.name,
    changeKind: temporalRevisionMatch ? event.eventType + " (temporal revision candidate)" : event.eventType,
    changedKeys,
    beforeSnapshotId: beforeId,
    afterSnapshotId: afterId,
    sourceType,
    sourceRef,
    sourceActivityId: temporalRevisionMatch ? null : (typeof payload.activityId === "string" ? payload.activityId : null),
    metadata: temporalRevisionMatch
      ? {
          partialSnapshot: true,
          activityAssociation: "temporal_candidate",
          candidateRevisionId: revision!.id,
          reason: "No revision ID was supplied; this same-agent revision is a time-proximity candidate only. The event retains its own identity and is not linked to the revision's Audit or run provenance.",
          activityTimestamp: occurredAt,
          revisionTimestamp: requiredIso(revision!.createdAt),
          matchWindowSeconds: 10,
        }
      : revision && explicitRevisionId
        ? { activityAssociation: "explicit_revision_id" }
        : {},
    occurredAt: itemOccurredAt,
  });
}

async function currentSkill(ctx: PluginContext, companyId: string, skillId: string) {
  const rows = await ctx.db.query<{
    id: string;
    key: string;
    slug: string;
    name: string;
    description: string | null;
    markdown: string;
    sourceType: string;
    sourceRef: string | null;
    compatibility: string;
    categories: string[];
    currentVersionId: string | null;
    updatedAt: string | Date;
  }>(
    'SELECT id, key, slug, name, description, markdown, source_type AS "sourceType", source_ref AS "sourceRef", ' +
      'compatibility, categories, current_version_id AS "currentVersionId", updated_at AS "updatedAt" ' +
      'FROM public.company_skills WHERE company_id = $1 AND id = $2 LIMIT 1',
    [companyId, skillId],
  );
  return rows[0] ?? null;
}

function compactSkillSnapshot(skill: Awaited<ReturnType<typeof currentSkill>>) {
  if (!skill) return {};
  return {
    key: skill.key,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    markdown: sanitizeTextSnapshot(skill.markdown),
    sourceType: skill.sourceType,
    sourceRef: skill.sourceRef,
    compatibility: skill.compatibility,
    categories: skill.categories,
    currentVersionId: skill.currentVersionId,
  };
}

function compactVersionFiles(value: unknown): unknown {
  return asArray(value).map((entry) => {
    const row = asRecord(entry);
    const path = typeof row.path === "string" ? row.path : "";
    return {
      path,
      kind: typeof row.kind === "string" ? row.kind : null,
      content: path === "SKILL.md" && typeof row.content === "string"
        ? sanitizeTextSnapshot(row.content)
        : undefined,
    };
  });
}

async function recordActivityEvent(ctx: PluginContext, event: PluginEvent) {
  const payload = asRecord(event.payload);
  const action = typeof payload.activityAction === "string" ? payload.activityAction : "";
  if (!action) return;
  const relevant =
    SKILL_ACTIVITY_ACTIONS.has(action) ||
    action.startsWith("agent.instructions_") ||
    AGENT_ACTIVITY_ACTIONS.has(action);
  if (!relevant) return;

  const companyId = event.companyId;
  if (!companyId || !event.entityId) return;
  const isSkillAction = SKILL_ACTIVITY_ACTIONS.has(action);
  const isAgentAction = action.startsWith("agent.instructions_") || AGENT_ACTIVITY_ACTIONS.has(action);
  if ((isSkillAction && event.entityType !== "company_skill") || (isAgentAction && event.entityType !== "agent")) return;
  const occurredAt = iso(event.occurredAt);
  if (!occurredAt) return;
  const currentStateReadAt = new Date().toISOString();
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  const entityType = isSkillAction ? "skill" : "agent";
  let entityName: string | null = null;
  let afterSnapshot: unknown = { activityAction: action, details: sanitize(payload) };
  let revision: {
    id: string;
    changedKeys: unknown;
    beforeConfig: unknown;
    afterConfig: unknown;
    createdAt: string | Date;
  } | null = null;

  if (entityType === "skill") {
    const skill = await currentSkill(ctx, companyId, event.entityId);
    entityName = skill?.name ?? null;
    afterSnapshot = skillActivitySnapshot(
      skill ? compactSkillSnapshot(skill) : {},
      action,
      sanitize(payload),
      currentStateReadAt,
      skill ? iso(skill.updatedAt) : null,
    );
  } else {
    const agent = await currentAgent(ctx, companyId, event.entityId);
    entityName = agent?.name ?? null;
    if (isRevisionProducingActivity(action)) {
      const revisionId = revisionReferenceFromActivity(payload);
      revision = revisionId ? await agentRevisionById(ctx, companyId, event.entityId, revisionId) : null;
    }
    if (revision) {
      afterSnapshot = revision.afterConfig;
    } else if (agent) {
      afterSnapshot = agentActivitySnapshot(
        asRecord(compactAgentSnapshot(agent)),
        action,
        sanitize(payload),
        currentStateReadAt,
        agent ? iso(agent.updatedAt) : null,
      );
    }
  }

  const previous = await latestSnapshot(ctx, companyId, entityType, event.entityId);
  let beforeId = previous?.id ?? null;
  if (revision) {
    const revisionCapturedAt = requiredIso(revision.createdAt);
    beforeId = await writeSnapshot(ctx, {
      companyId,
      entityType: "agent",
      entityId: event.entityId,
      entityName,
      snapshot: revision.beforeConfig,
      sourceType: "agent_config_revision_before",
      sourceRef: revision.id,
      capturedAt: revisionCapturedAt,
    });
  }

  const afterId = await writeSnapshot(ctx, {
    companyId,
    entityType,
    entityId: event.entityId,
    entityName,
    snapshot: afterSnapshot,
    sourceType: revision ? "agent_config_revision_after" : "activity",
    sourceRef: revision?.id ?? (typeof payload.activityId === "string" ? payload.activityId : event.eventId),
    capturedAt: revision ? requiredIso(revision.createdAt) : currentStateReadAt,
  });
  const changeSetId = await ensureChangeSet(ctx, {
    companyId,
    sourceContextKey: bucketContext(occurredAt, event.actorType, event.actorId, runId),
    occurredAt,
    actorType: event.actorType,
    actorId: event.actorId,
  });
  await attachRunContext(ctx, companyId, changeSetId, runId);
  await writeItem(ctx, {
    companyId,
    changeSetId,
    entityType,
    entityId: event.entityId,
    entityName,
    changeKind: action,
    changedKeys: revision
      ? asArray(revision.changedKeys)
      : Object.keys(payload).filter((key) => !["runId", "agentId", "responsibleUserId", "activityAction"].includes(key)),
    beforeSnapshotId: beforeId,
    afterSnapshotId: afterId,
    sourceType: revision ? "agent_config_revision" : "activity",
    sourceRef: revision?.id ?? (typeof payload.activityId === "string" ? payload.activityId : event.eventId),
    sourceActivityId: typeof payload.activityId === "string" ? payload.activityId : null,
    occurredAt,
  });
}

function authorBucket(
  occurredAt: string,
  authorAgentId?: string | null,
  authorUserId?: string | null,
): string {
  const millis = Date.parse(occurredAt);
  const bucket = Number.isFinite(millis) ? Math.floor(millis / (30 * 60 * 1000)) : 0;
  return "backfill:" + (authorAgentId ? "agent:" + authorAgentId : "user:" + (authorUserId ?? "unknown")) + ":" + bucket;
}

async function backfill(ctx: PluginContext, companyId: string, days: number) {
  const boundedDays = Math.min(30, Math.max(1, Math.floor(days)));
  const skillActionsSql = [...SKILL_ACTIVITY_ACTIONS].map((action) => "'" + action + "'").join(",");
  const agentActionsSql = [...AGENT_ACTIVITY_ACTIONS].map((action) => "'" + action + "'").join(",");
  const agentRevisions = await ctx.db.query<{
    id: string;
    agentId: string;
    agentName: string;
    changedKeys: unknown;
    beforeConfig: unknown;
    afterConfig: unknown;
    createdByAgentId: string | null;
    createdByUserId: string | null;
    createdAt: string | Date;
  }>(
    'SELECT r.id, r.agent_id AS "agentId", a.name AS "agentName", r.changed_keys AS "changedKeys", ' +
      'r.before_config AS "beforeConfig", r.after_config AS "afterConfig", r.created_by_agent_id AS "createdByAgentId", ' +
      'r.created_by_user_id AS "createdByUserId", r.created_at AS "createdAt" ' +
      'FROM public.agent_config_revisions r JOIN public.agents a ON a.id = r.agent_id ' +
      'WHERE r.company_id = $1 AND r.created_at >= now() - ($2::text || \' days\')::interval ' +
      'ORDER BY r.created_at ASC LIMIT 1000',
    [companyId, String(boundedDays)],
  );

  let agentItems = 0;
  for (const revision of agentRevisions) {
    if (await sourceItemExists(ctx.db, companyId, "agent_config_revision", revision.id)) continue;
    const occurredAt = iso(revision.createdAt);
    if (!occurredAt) continue;
    const changeSetId = await ensureChangeSet(ctx, {
      companyId,
      sourceContextKey: authorBucket(occurredAt, revision.createdByAgentId, revision.createdByUserId),
      occurredAt,
      actorType: revision.createdByAgentId ? "agent" : "user",
      actorId: revision.createdByAgentId ?? revision.createdByUserId,
    });
    const beforeId = await writeSnapshot(ctx, {
      companyId,
      entityType: "agent",
      entityId: revision.agentId,
      entityName: revision.agentName,
      snapshot: revision.beforeConfig,
      sourceType: "agent_config_revision_before",
      sourceRef: revision.id,
      capturedAt: occurredAt,
    });
    const afterId = await writeSnapshot(ctx, {
      companyId,
      entityType: "agent",
      entityId: revision.agentId,
      entityName: revision.agentName,
      snapshot: revision.afterConfig,
      sourceType: "agent_config_revision_after",
      sourceRef: revision.id,
      capturedAt: occurredAt,
    });
    if (await writeItem(ctx, {
      companyId,
      changeSetId,
      entityType: "agent",
      entityId: revision.agentId,
      entityName: revision.agentName,
      changeKind: "agent.updated",
      changedKeys: asArray(revision.changedKeys),
      beforeSnapshotId: beforeId,
      afterSnapshotId: afterId,
      sourceType: "agent_config_revision",
      sourceRef: revision.id,
      occurredAt,
    })) agentItems += 1;
  }

  const versions = await ctx.db.query<{
    id: string;
    skillId: string;
    skillName: string;
    revisionNumber: number;
    fileInventory: unknown;
    authorAgentId: string | null;
    authorUserId: string | null;
    createdAt: string | Date;
  }>(
    'SELECT v.id, v.company_skill_id AS "skillId", s.name AS "skillName", v.revision_number AS "revisionNumber", ' +
      'v.file_inventory AS "fileInventory", v.author_agent_id AS "authorAgentId", v.author_user_id AS "authorUserId", ' +
      'v.created_at AS "createdAt" FROM public.company_skill_versions v ' +
      'JOIN public.company_skills s ON s.id = v.company_skill_id ' +
      'WHERE v.company_id = $1 AND v.created_at >= now() - ($2::text || \' days\')::interval ' +
      'ORDER BY v.company_skill_id ASC, v.revision_number ASC LIMIT 1000',
    [companyId, String(boundedDays)],
  );

  const previousVersion = new Map<string, { id: string; snapshotId: string }>();
  let skillItems = 0;
  for (const version of versions) {
    const prior = previousVersion.get(version.skillId);
    if (await sourceItemExists(ctx.db, companyId, "company_skill_version", version.id)) {
      const existingAfterId = await sourceSnapshotId(
        ctx.db,
        companyId,
        "skill",
        version.skillId,
        "company_skill_version",
        version.id,
      );
      if (existingAfterId) previousVersion.set(version.skillId, { id: version.id, snapshotId: existingAfterId });
      continue;
    }
    const occurredAt = iso(version.createdAt);
    if (!occurredAt) continue;
    let priorSnapshotId = prior?.snapshotId ?? null;
    if (!priorSnapshotId) {
      const priorVersions = await ctx.db.query<{
        id: string;
        revisionNumber: number;
        fileInventory: unknown;
        createdAt: string | Date;
      }>(
        'SELECT id, revision_number AS "revisionNumber", file_inventory AS "fileInventory", created_at AS "createdAt" ' +
          'FROM public.company_skill_versions WHERE company_id = $1 AND company_skill_id = $2 ' +
          'AND created_at < $3::timestamptz ORDER BY created_at DESC, revision_number DESC LIMIT 1',
        [companyId, version.skillId, occurredAt],
      );
      const priorVersion = priorVersions[0];
      const priorAt = priorVersion ? iso(priorVersion.createdAt) : null;
      if (priorVersion && priorAt) {
        priorSnapshotId = await writeSnapshot(ctx, {
          companyId,
          entityType: "skill",
          entityId: version.skillId,
          entityName: version.skillName,
          snapshot: { revisionNumber: priorVersion.revisionNumber, files: compactVersionFiles(priorVersion.fileInventory) },
          sourceType: "company_skill_version",
          sourceRef: priorVersion.id,
          capturedAt: priorAt,
        });
        previousVersion.set(version.skillId, { id: priorVersion.id, snapshotId: priorSnapshotId });
      }
    }
    const afterId = await writeSnapshot(ctx, {
      companyId,
      entityType: "skill",
      entityId: version.skillId,
      entityName: version.skillName,
      snapshot: { revisionNumber: version.revisionNumber, files: compactVersionFiles(version.fileInventory) },
      sourceType: "company_skill_version",
      sourceRef: version.id,
      capturedAt: occurredAt,
    });
    const changeSetId = await ensureChangeSet(ctx, {
      companyId,
      sourceContextKey: authorBucket(occurredAt, version.authorAgentId, version.authorUserId),
      occurredAt,
      actorType: version.authorAgentId ? "agent" : "user",
      actorId: version.authorAgentId ?? version.authorUserId,
    });
    if (await writeItem(ctx, {
      companyId,
      changeSetId,
      entityType: "skill",
      entityId: version.skillId,
      entityName: version.skillName,
      changeKind: "company.skill_version_created",
      changedKeys: ["files"],
      beforeSnapshotId: priorSnapshotId,
      afterSnapshotId: afterId,
      sourceType: "company_skill_version",
      sourceRef: version.id,
      occurredAt,
    })) skillItems += 1;
    previousVersion.set(version.skillId, { id: version.id, snapshotId: afterId });
  }

  const activityRows = await ctx.db.query<{
    id: string;
    actorType: string;
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    agentId: string | null;
    runId: string | null;
    details: unknown;
    createdAt: string | Date;
  }>(
    'SELECT id, actor_type AS "actorType", actor_id AS "actorId", action, entity_type AS "entityType", entity_id AS "entityId", ' +
      'agent_id AS "agentId", run_id AS "runId", details, created_at AS "createdAt" FROM public.activity_log ' +
      'WHERE company_id = $1 AND created_at >= now() - ($2::text || \' days\')::interval ' +
      'AND ((entity_type = \'company_skill\' AND action IN (' + skillActionsSql + ')) OR ' +
      '(entity_type = \'agent\' AND (action LIKE \'agent.instructions_%\' OR action IN (' + agentActionsSql + ')))) ' +
      'ORDER BY created_at ASC LIMIT 1500',
    [companyId, String(boundedDays)],
  );

  let activityItems = 0;
  for (const row of activityRows) {
    if (await sourceItemExists(ctx.db, companyId, "activity", row.id)) continue;
    const occurredAt = iso(row.createdAt);
    if (!occurredAt) continue;
    const entityType = row.entityType === "company_skill" ? "skill" : "agent";
    let entityName: string | null = null;

    if (entityType === "agent" && isRevisionProducingActivity(row.action)) {
      const revisionId = revisionReferenceFromActivity(asRecord(row.details));
      const revision = revisionId
        ? await agentRevisionById(ctx, companyId, row.entityId, revisionId)
        : null;
      if (revision) {
        const existingRevisionItem = await ctx.db.query<{ id: string; changeSetId: string }>(
          'SELECT id, change_set_id AS "changeSetId" FROM change_items WHERE company_id = $1 AND source_type = \'agent_config_revision\' AND source_ref = $2 LIMIT 1',
          [companyId, revision.id],
        );
        if (existingRevisionItem[0]) {
          await ctx.db.execute(
            'UPDATE change_items SET source_activity_id = coalesce(source_activity_id, $3) WHERE company_id = $1 AND id = $2',
            [companyId, existingRevisionItem[0].id, row.id],
          );
          await attachRunContext(ctx, companyId, existingRevisionItem[0].changeSetId, row.runId);
          continue;
        }
      }
    }

    let activitySnapshot: unknown = { activityAction: row.action, details: sanitize(asRecord(row.details)) };
    const currentStateReadAt = new Date().toISOString();
    if (entityType === "skill") {
      const skill = await currentSkill(ctx, companyId, row.entityId);
      entityName = skill?.name ?? null;
      activitySnapshot = skillActivitySnapshot(
        skill ? compactSkillSnapshot(skill) : {},
        row.action,
        sanitize(asRecord(row.details)),
        currentStateReadAt,
        skill ? iso(skill.updatedAt) : null,
      );
    } else {
      const agent = await currentAgent(ctx, companyId, row.entityId);
      entityName = agent?.name ?? null;
      if (agent) {
        activitySnapshot = agentActivitySnapshot(
          asRecord(compactAgentSnapshot(agent)),
          row.action,
          sanitize(asRecord(row.details)),
          currentStateReadAt,
          iso(agent.updatedAt),
        );
      }
    }

    const afterId = await writeSnapshot(ctx, {
      companyId,
      entityType,
      entityId: row.entityId,
      entityName,
      snapshot: activitySnapshot,
      sourceType: "activity",
      sourceRef: row.id,
      capturedAt: currentStateReadAt,
    });
    const changeSetId = await ensureChangeSet(ctx, {
      companyId,
      sourceContextKey: row.runId ? "run:" + row.runId : authorBucket(occurredAt, row.agentId, row.actorType === "user" ? row.actorId : null),
      occurredAt,
      actorType: row.actorType,
      actorId: row.actorId,
    });
    await attachRunContext(ctx, companyId, changeSetId, row.runId);
    if (await writeItem(ctx, {
      companyId,
      changeSetId,
      entityType,
      entityId: row.entityId,
      entityName,
      changeKind: row.action,
      changedKeys: Object.keys(asRecord(row.details)),
      afterSnapshotId: afterId,
      sourceType: "activity",
      sourceRef: row.id,
      sourceActivityId: row.id,
      occurredAt,
    })) activityItems += 1;
  }

  return { agentItems, skillItems, activityItems, days: boundedDays };
}

function placeholders(start: number, count: number): string {
  return Array.from({ length: count }, (_, i) => "$" + String(start + i)).join(",");
}

export async function queryRunStats(
  ctx: PluginContext,
  companyId: string,
  agentIds: string[],
  startAt: string,
  endAt: string,
) {
  const params: unknown[] = [companyId, startAt, endAt, ...agentIds];
  const agentFilter = agentIds.length
    ? " AND agent_id IN (" + placeholders(4, agentIds.length) + ")"
    : "";
  const rows = await ctx.db.query<{
    runs: number | string;
    successes: number | string;
    avgDuration: number | string | null;
  }>(
    'SELECT ' + RUN_METRIC_AGGREGATION_SQL + ', ' +
      'avg(extract(epoch from (finished_at - started_at))) FILTER (WHERE finished_at IS NOT NULL)::float AS "avgDuration" ' +
      'FROM public.heartbeat_runs WHERE company_id = $1 AND started_at >= $2::timestamptz AND started_at < $3::timestamptz' +
      agentFilter,
    params,
  );
  const row = rows[0];
  const runs = Number(row?.runs ?? 0);
  const successes = Number(row?.successes ?? 0);
  return {
    runs,
    successRate: runs > 0 ? (successes / runs) * 100 : null,
    avgDuration: row?.avgDuration == null ? null : Number(row.avgDuration),
  };
}

export async function queryCostStats(
  ctx: PluginContext,
  companyId: string,
  agentIds: string[],
  startAt: string,
  endAt: string,
) {
  const params: unknown[] = [companyId, startAt, endAt, ...agentIds];
  const agentFilter = agentIds.length
    ? " AND agent_id IN (" + placeholders(4, agentIds.length) + ")"
    : "";
  const rows = await ctx.db.query<{
    costCents: number | string | null;
    inputTokens: number | string;
    cachedInputTokens: number | string;
    outputTokens: number | string;
    pricedEvents: number | string;
    events: number | string;
  }>(
    'SELECT sum(cost_cents) FILTER (WHERE cost_status = \'reported\')::float AS "costCents", ' +
      'coalesce(sum(input_tokens),0)::float AS "inputTokens", ' +
      'coalesce(sum(cached_input_tokens),0)::float AS "cachedInputTokens", coalesce(sum(output_tokens),0)::float AS "outputTokens", ' +
      'count(*) FILTER (WHERE cost_status = \'reported\')::int AS "pricedEvents", ' +
      'count(*)::int AS events FROM public.cost_events WHERE company_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz' +
      agentFilter,
    params,
  );
  const row = rows[0];
  const pricedEvents = Number(row?.pricedEvents ?? 0);
  const events = Number(row?.events ?? 0);
  return {
    costUsd: pricedEvents > 0 && row?.costCents != null ? Number(row.costCents) / 100 : null,
    inputTokens: events > 0 ? Number(row?.inputTokens ?? 0) : null,
    cachedInputTokens: events > 0 ? Number(row?.cachedInputTokens ?? 0) : null,
    outputTokens: events > 0 ? Number(row?.outputTokens ?? 0) : null,
    pricedEvents,
    events,
  };
}

async function upsertMetric(
  ctx: PluginContext,
  companyId: string,
  changeSetId: string,
  metricKey: string,
  baseline: number | null,
  current: number | null,
  unit: string,
  baselineSample: number,
  currentSample: number,
  metadata: Record<string, unknown>,
) {
  const delta = baseline == null || current == null ? null : current - baseline;
  await ctx.db.execute(
    'INSERT INTO change_metrics (id, company_id, change_set_id, metric_key, baseline_value, current_value, delta_value, unit, baseline_sample_size, current_sample_size, metadata, computed_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,now()) ' +
      'ON CONFLICT (company_id, change_set_id, metric_key) DO UPDATE SET baseline_value = excluded.baseline_value, current_value = excluded.current_value, ' +
      'delta_value = excluded.delta_value, unit = excluded.unit, baseline_sample_size = excluded.baseline_sample_size, current_sample_size = excluded.current_sample_size, metadata = excluded.metadata, computed_at = now()',
    [
      globalThis.crypto.randomUUID(),
      companyId,
      changeSetId,
      metricKey,
      baseline,
      current,
      delta,
      unit,
      baselineSample,
      currentSample,
      JSON.stringify(metadata),
    ],
  );
}

async function recomputeMetrics(ctx: PluginContext, companyId: string, changeSetId: string) {
  const sets = await ctx.db.query<{ appliedAt: string | Date; validationEndsAt: string | Date | null }>(
    'SELECT applied_at AS "appliedAt", validation_ends_at AS "validationEndsAt" FROM change_sets WHERE company_id = $1 AND id = $2 LIMIT 1',
    [companyId, changeSetId],
  );
  const set = sets[0];
  if (!set) throw new Error("Change Set not found");
  const appliedAt = new Date(requiredIso(set.appliedAt));
  const baselineStart = new Date(appliedAt.getTime() - 7 * 86400000).toISOString();
  const currentEnd = new Date(Math.min(
    Date.now(),
    appliedAt.getTime() + 7 * 86400000,
    set.validationEndsAt ? new Date(requiredIso(set.validationEndsAt)).getTime() : Infinity,
  )).toISOString();

  const agentRows = await ctx.db.query<{ entityId: string }>(
    'SELECT DISTINCT entity_id AS "entityId" FROM change_items WHERE company_id = $1 AND change_set_id = $2 AND entity_type = \'agent\'',
    [companyId, changeSetId],
  );
  const agentIds = agentRows.map((row) => row.entityId);
  if (agentIds.length === 0) {
    await ctx.db.execute(
      'DELETE FROM change_metrics WHERE company_id = $1 AND change_set_id = $2',
      [companyId, changeSetId],
    );
    return { agentIds, baselineStart, appliedAt: appliedAt.toISOString(), currentEnd };
  }
  const [baselineRuns, currentRuns, baselineCosts, currentCosts] = await Promise.all([
    queryRunStats(ctx, companyId, agentIds, baselineStart, appliedAt.toISOString()),
    queryRunStats(ctx, companyId, agentIds, appliedAt.toISOString(), currentEnd),
    queryCostStats(ctx, companyId, agentIds, baselineStart, appliedAt.toISOString()),
    queryCostStats(ctx, companyId, agentIds, appliedAt.toISOString(), currentEnd),
  ]);

  const windows = {
    baseline: {
      startAt: baselineStart,
      endAt: appliedAt.toISOString(),
      durationSeconds: Math.max(0, (appliedAt.getTime() - new Date(baselineStart).getTime()) / 1000),
    },
    current: {
      startAt: appliedAt.toISOString(),
      endAt: currentEnd,
      durationSeconds: Math.max(0, (new Date(currentEnd).getTime() - appliedAt.getTime()) / 1000),
    },
  };
  const metricMetadata = { windows };

  await upsertMetric(ctx, companyId, changeSetId, "run_success_rate", baselineRuns.successRate, currentRuns.successRate, "%", baselineRuns.runs, currentRuns.runs, metricMetadata);
  await upsertMetric(ctx, companyId, changeSetId, "avg_run_duration", baselineRuns.avgDuration, currentRuns.avgDuration, "seconds", baselineRuns.runs, currentRuns.runs, metricMetadata);
  await upsertMetric(ctx, companyId, changeSetId, "cost", baselineCosts.costUsd, currentCosts.costUsd, "USD", baselineCosts.pricedEvents, currentCosts.pricedEvents, metricMetadata);
  await upsertMetric(ctx, companyId, changeSetId, "input_tokens", baselineCosts.inputTokens, currentCosts.inputTokens, "tokens", baselineCosts.events, currentCosts.events, metricMetadata);
  await upsertMetric(ctx, companyId, changeSetId, "cached_input_tokens", baselineCosts.cachedInputTokens, currentCosts.cachedInputTokens, "tokens", baselineCosts.events, currentCosts.events, metricMetadata);
  await upsertMetric(ctx, companyId, changeSetId, "output_tokens", baselineCosts.outputTokens, currentCosts.outputTokens, "tokens", baselineCosts.events, currentCosts.events, metricMetadata);
  return { agentIds, baselineStart, appliedAt: appliedAt.toISOString(), currentEnd };
}

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

async function overview(ctx: PluginContext, companyId: string) {
  const changeSets = await ctx.db.query<Record<string, unknown>>(
    'SELECT cs.id, cs.title, cs.description, cs.hypothesis, cs.status, cs.causality_level AS "causalityLevel", ' +
      'cs.applied_at AS "appliedAt", cs.validation_ends_at AS "validationEndsAt", cs.updated_at AS "updatedAt", ' +
      'max(ca.outcome) AS "assessmentOutcome", max(ca.reason_code) AS "assessmentReason", max(ca.evaluated_at) AS "assessmentEvaluatedAt", ' +
      'count(DISTINCT ci.id)::int AS "itemCount", count(DISTINCT ce.id)::int AS "evidenceCount", count(DISTINCT cm.id)::int AS "metricCount" ' +
      'FROM change_sets cs LEFT JOIN change_items ci ON ci.change_set_id = cs.id ' +
      'LEFT JOIN change_evidence ce ON ce.change_set_id = cs.id LEFT JOIN change_metrics cm ON cm.change_set_id = cs.id ' +
      'LEFT JOIN change_assessments ca ON ca.company_id = cs.company_id AND ca.change_set_id = cs.id ' +
      'WHERE cs.company_id = $1 GROUP BY cs.id ORDER BY cs.applied_at DESC LIMIT 100',
    [companyId],
  );
  const counts = await ctx.db.query<{ status: string; count: number | string }>(
    'SELECT status, count(*)::int AS count FROM change_sets WHERE company_id = $1 GROUP BY status',
    [companyId],
  );
  return {
    changeSets,
    counts: Object.fromEntries(counts.map((row) => [row.status, Number(row.count)])),
  };
}

async function detail(ctx: PluginContext, companyId: string, changeSetId: string) {
  const sets = await ctx.db.query<Record<string, unknown>>(
    'SELECT id, title, description, hypothesis, status, causality_level AS "causalityLevel", source_context_key AS "sourceContextKey", ' +
      'applied_at AS "appliedAt", validation_ends_at AS "validationEndsAt", created_by_type AS "createdByType", created_by_id AS "createdById", ' +
      'created_at AS "createdAt", updated_at AS "updatedAt" FROM change_sets WHERE company_id = $1 AND id = $2 LIMIT 1',
    [companyId, changeSetId],
  );
  if (!sets[0]) throw new Error("Change Set not found");

  const [items, evidence, metrics, conclusions, links, assessments] = await Promise.all([
    ctx.db.query<Record<string, unknown>>(
      'SELECT ci.id, ci.entity_type AS "entityType", ci.entity_id AS "entityId", ci.entity_name AS "entityName", ci.change_kind AS "changeKind", ' +
        'ci.changed_keys AS "changedKeys", ci.source_type AS "sourceType", ci.source_ref AS "sourceRef", ci.source_activity_id AS "sourceActivityId", ci.metadata, ci.occurred_at AS "occurredAt", ' +
        'bs.snapshot AS "beforeSnapshot", asn.snapshot AS "afterSnapshot" FROM change_items ci ' +
        'LEFT JOIN change_snapshots bs ON bs.id = ci.before_snapshot_id LEFT JOIN change_snapshots asn ON asn.id = ci.after_snapshot_id ' +
        'WHERE ci.company_id = $1 AND ci.change_set_id = $2 ORDER BY ci.occurred_at ASC',
      [companyId, changeSetId],
    ),
    ctx.db.query<Record<string, unknown>>(
      'SELECT id, evidence_type AS "evidenceType", reference_id AS "referenceId", label, verdict, notes, metadata, observed_at AS "observedAt", created_at AS "createdAt" ' +
        'FROM change_evidence WHERE company_id = $1 AND change_set_id = $2 ORDER BY created_at DESC',
      [companyId, changeSetId],
    ),
    ctx.db.query<Record<string, unknown>>(
      'SELECT metric_key AS "metricKey", baseline_value::float AS "baselineValue", current_value::float AS "currentValue", delta_value::float AS "deltaValue", ' +
        'unit, baseline_sample_size AS "baselineSampleSize", current_sample_size AS "currentSampleSize", metadata, computed_at AS "computedAt" ' +
        'FROM change_metrics WHERE company_id = $1 AND change_set_id = $2 ORDER BY metric_key',
      [companyId, changeSetId],
    ),
    ctx.db.query<Record<string, unknown>>(
      'SELECT id, outcome, confidence, summary, evidence_summary AS "evidenceSummary", created_at AS "createdAt" ' +
        'FROM change_conclusions WHERE company_id = $1 AND change_set_id = $2 ORDER BY created_at DESC',
      [companyId, changeSetId],
    ),
    ctx.db.query<Record<string, unknown>>(
      'SELECT id, link_type AS "linkType", reference_id AS "referenceId", label, metadata, created_at AS "createdAt" ' +
        'FROM change_links WHERE company_id = $1 AND change_set_id = $2 ORDER BY created_at ASC',
      [companyId, changeSetId],
    ),
    ctx.db.query<Record<string, unknown>>(
      'SELECT outcome, confidence, reason_code AS "reasonCode", summary, signals, baseline_run_count AS "baselineRunCount", ' +
        'current_run_count AS "currentRunCount", evidence_count AS "evidenceCount", evaluated_at AS "evaluatedAt" ' +
        'FROM change_assessments WHERE company_id = $1 AND change_set_id = $2 LIMIT 1',
      [companyId, changeSetId],
    ),
  ]);

  const agentIds = [...new Set(items.filter((item) => item.entityType === "agent").map((item) => String(item.entityId)))];
  let suggestedRuns: Record<string, unknown>[] = [];
  if (agentIds.length > 0) {
    const inSql = placeholders(3, agentIds.length);
    suggestedRuns = await ctx.db.query<Record<string, unknown>>(
      'SELECT r.id, r.agent_id AS "agentId", a.name AS "agentName", r.status, r.started_at AS "startedAt", r.finished_at AS "finishedAt", ' +
        'r.invocation_source AS "invocationSource" FROM public.heartbeat_runs r JOIN public.agents a ON a.id = r.agent_id ' +
        'WHERE r.company_id = $1 AND r.started_at >= $2::timestamptz AND r.agent_id IN (' + inSql + ') ORDER BY r.started_at DESC LIMIT 25',
      [companyId, String(sets[0].appliedAt), ...agentIds],
    );
  }

  return { changeSet: sets[0], items, evidence, metrics, conclusions, links, suggestedRuns, assessment: assessments[0] ?? null };
}

/**
 * Minimal MCP projection, separate from the board's full change detail.
 * Bounded SELECTs prevent copying raw snapshots, metadata and suggested runs
 * into worker memory; exact counts preserve coverage/truncation semantics.
 */
async function mcpChangeSummary(ctx: PluginContext, companyId: string, changeSetId: string) {
  const [changeSet] = await ctx.db.query<Record<string, unknown>>(
    'SELECT id, title, status, hypothesis, causality_level AS "causalityLevel", ' +
      'applied_at AS "appliedAt", validation_ends_at AS "validationEndsAt" ' +
      'FROM change_sets WHERE company_id = $1 AND id = $2 LIMIT 1',
    [companyId, changeSetId],
  );
  if (!changeSet) throw new Error("Change Set not found");

  const params = [companyId, changeSetId];
  const [items, metrics, conclusions, itemTotals, metricTotals, conclusionTotals] = await Promise.all([
    ctx.db.query<Record<string, unknown>>(
      'SELECT entity_type AS "entityType", entity_name AS "entityName", ' +
        'change_kind AS "changeKind", occurred_at AS "occurredAt" ' +
        'FROM change_items WHERE company_id = $1 AND change_set_id = $2 ' +
        'ORDER BY occurred_at ASC, id ASC LIMIT 51',
      params,
    ),
    ctx.db.query<Record<string, unknown>>(
      'SELECT metric_key AS "metricKey", baseline_value::float AS "baselineValue", ' +
        'current_value::float AS "currentValue", delta_value::float AS "deltaValue", ' +
        'unit, baseline_sample_size AS "baselineSampleSize", current_sample_size AS "currentSampleSize" ' +
        'FROM change_metrics WHERE company_id = $1 AND change_set_id = $2 ' +
        'ORDER BY metric_key ASC LIMIT 51',
      params,
    ),
    ctx.db.query<Record<string, unknown>>(
      'SELECT outcome, confidence, summary ' +
        'FROM change_conclusions WHERE company_id = $1 AND change_set_id = $2 ' +
        'ORDER BY created_at DESC, id DESC LIMIT 21',
      params,
    ),
    ctx.db.query<{ count: number | string }>(
      'SELECT count(*)::int AS count FROM change_items WHERE company_id = $1 AND change_set_id = $2',
      params,
    ),
    ctx.db.query<{ count: number | string }>(
      'SELECT count(*)::int AS count FROM change_metrics WHERE company_id = $1 AND change_set_id = $2',
      params,
    ),
    ctx.db.query<{ count: number | string }>(
      'SELECT count(*)::int AS count FROM change_conclusions WHERE company_id = $1 AND change_set_id = $2',
      params,
    ),
  ]);
  const itemCount = Number(itemTotals[0]?.count ?? 0);
  const metricCount = Number(metricTotals[0]?.count ?? 0);
  const conclusionCount = Number(conclusionTotals[0]?.count ?? 0);
  return {
    companyId,
    changeSet,
    items: items.slice(0, 50),
    metrics: metrics.slice(0, 50),
    conclusions: conclusions.slice(0, 20),
    coverage: {
      itemCount, metricCount, conclusionCount,
      itemsTruncated: itemCount > 50,
      metricsTruncated: metricCount > 50,
      conclusionsTruncated: conclusionCount > 20,
    },
  };
}

async function assertChangeSet(ctx: PluginContext, companyId: string, changeSetId: string) {
  const rows = await ctx.db.query<{ id: string }>(
    'SELECT id FROM change_sets WHERE company_id = $1 AND id = $2 LIMIT 1',
    [companyId, changeSetId],
  );
  if (!rows[0]) throw new Error("Change Set not found");
}

function actorAttribution(context: PluginPerformActionContext) {
  const actor = context.actor;
  return {
    type: actor.type,
    id: actor.userId ?? actor.agentId ?? actor.runId ?? null,
  };
}

async function conclusionIdempotencyKey(
  params: Record<string, unknown>,
  companyId: string,
  changeSetId: string,
  context: PluginPerformActionContext,
) {
  const requestKey = stringParam(params, "idempotencyKey");
  if (requestKey) return requestKey;
  const actor = actorAttribution(context);
  const material = JSON.stringify([
    companyId,
    changeSetId,
    requiredString(params, "outcome"),
    stringParam(params, "confidence") ?? "low",
    requiredString(params, "summary"),
    sortDeep(asRecord(params.evidenceSummary)),
    actor.type,
    actor.id,
  ]);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function assertCompanyRun(ctx: PluginContext, companyId: string, runId: string) {
  const rows = await ctx.db.query<{ id: string }>(
    'SELECT id FROM public.heartbeat_runs WHERE company_id = $1 AND id::text = $2 LIMIT 1',
    [companyId, runId],
  );
  if (!rows[0]) throw new Error("Run not found in authorized company");
}

function registerActions(ctx: PluginContext) {
  ctx.actions.register("create-change-set", async (params, actionContext) => {
    const companyId = authorizedCompanyId(params, actionContext);
    const title = requiredString(params, "title").slice(0, 180);
    const id = globalThis.crypto.randomUUID();
    const status = stringParam(params, "status") ?? "draft";
    if (!CHANGE_STATUSES.has(status)) throw new Error("Invalid status");
    const causality = stringParam(params, "causalityLevel") ?? "observed";
    if (!CAUSALITY_LEVELS.has(causality)) throw new Error("Invalid causality level");
    const actor = actorAttribution(actionContext);
    await ctx.db.execute(
      'INSERT INTO change_sets (id, company_id, title, description, hypothesis, status, causality_level, applied_at, validation_ends_at, created_by_type, created_by_id) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8::timestamptz,now()),$9::timestamptz,$10,$11)',
      [
        id,
        companyId,
        title,
        stringParam(params, "description") ?? null,
        stringParam(params, "hypothesis") ?? null,
        status,
        causality,
        stringParam(params, "appliedAt") ?? null,
        stringParam(params, "validationEndsAt") ?? null,
        actor.type,
        actor.id,
      ],
    );
    return { ok: true, id };
  });

  ctx.actions.register("update-change-set", async (params, actionContext) => {
    const companyId = authorizedCompanyId(params, actionContext);
    const changeSetId = requiredString(params, "changeSetId");
    const rows = await ctx.db.query<Record<string, unknown>>(
      'SELECT title, description, hypothesis, status, causality_level AS "causalityLevel", validation_ends_at AS "validationEndsAt" FROM change_sets WHERE company_id = $1 AND id = $2 LIMIT 1',
      [companyId, changeSetId],
    );
    const current = rows[0];
    if (!current) throw new Error("Change Set not found");
    const status = stringParam(params, "status") ?? String(current.status);
    const causality = stringParam(params, "causalityLevel") ?? String(current.causalityLevel);
    if (!CHANGE_STATUSES.has(status)) throw new Error("Invalid status");
    if (!CAUSALITY_LEVELS.has(causality)) throw new Error("Invalid causality level");
    await ctx.db.execute(
      'UPDATE change_sets SET title=$3, description=$4, hypothesis=$5, status=$6, causality_level=$7, validation_ends_at=$8::timestamptz, updated_at=now() ' +
        'WHERE company_id=$1 AND id=$2',
      [
        companyId,
        changeSetId,
        stringParam(params, "title") ?? String(current.title),
        stringParam(params, "description") ?? (current.description ?? null),
        stringParam(params, "hypothesis") ?? (current.hypothesis ?? null),
        status,
        causality,
        stringParam(params, "validationEndsAt") ?? (current.validationEndsAt ? iso(current.validationEndsAt) : null),
      ],
    );
    return { ok: true };
  });

  ctx.actions.register("add-evidence", async (params, actionContext) => {
    const companyId = authorizedCompanyId(params, actionContext);
    const changeSetId = requiredString(params, "changeSetId");
    await assertChangeSet(ctx, companyId, changeSetId);
    const evidenceType = requiredString(params, "evidenceType");
    const referenceId = evidenceType === "run"
      ? requiredString(params, "referenceId")
      : stringParam(params, "referenceId") ?? null;
    if (evidenceType === "run") await assertCompanyRun(ctx, companyId, referenceId!);
    const verdict = stringParam(params, "verdict") ?? "neutral";
    if (!EVIDENCE_VERDICTS.has(verdict)) throw new Error("Invalid evidence verdict");
    const id = globalThis.crypto.randomUUID();
    await ctx.db.execute(
      'INSERT INTO change_evidence (id, company_id, change_set_id, evidence_type, reference_id, label, verdict, notes, metadata, observed_at) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::timestamptz)',
      [
        id,
        companyId,
        changeSetId,
        evidenceType,
        referenceId,
        stringParam(params, "label") ?? null,
        verdict,
        stringParam(params, "notes") ?? null,
        JSON.stringify(asRecord(params.metadata)),
        stringParam(params, "observedAt") ?? null,
      ],
    );
    if (evidenceType === "run") await attachRunContext(ctx, companyId, changeSetId, referenceId);
    return { ok: true, id };
  });

  ctx.actions.register("add-link", async (params, actionContext) => {
    const companyId = authorizedCompanyId(params, actionContext);
    const changeSetId = requiredString(params, "changeSetId");
    await assertChangeSet(ctx, companyId, changeSetId);
    const linkType = requiredString(params, "linkType");
    const referenceId = requiredString(params, "referenceId");
    if (linkType === "run") await assertCompanyRun(ctx, companyId, referenceId);
    await ctx.db.execute(
      'INSERT INTO change_links (id, company_id, change_set_id, link_type, reference_id, label, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING',
      [
        globalThis.crypto.randomUUID(),
        companyId,
        changeSetId,
        linkType,
        referenceId,
        stringParam(params, "label") ?? null,
        JSON.stringify(asRecord(params.metadata)),
      ],
    );
    if (linkType === "run") await attachRunContext(ctx, companyId, changeSetId, referenceId);
    return { ok: true };
  });

  ctx.actions.register("add-conclusion", async (params, actionContext) => {
    const companyId = authorizedCompanyId(params, actionContext);
    const changeSetId = requiredString(params, "changeSetId");
    await assertChangeSet(ctx, companyId, changeSetId);
    const outcome = requiredString(params, "outcome");
    const confidence = stringParam(params, "confidence") ?? "low";
    if (!["proven", "regressed", "inconclusive", "reverted"].includes(outcome)) throw new Error("Invalid outcome");
    if (!CONFIDENCE_LEVELS.has(confidence)) throw new Error("Invalid confidence");
    const idempotencyKey = await conclusionIdempotencyKey(params, companyId, changeSetId, actionContext);
    const actor = actorAttribution(actionContext);
    await ctx.db.execute(
      'WITH inserted AS (' +
        'INSERT INTO change_conclusions (id, company_id, change_set_id, outcome, confidence, summary, evidence_summary, created_by_type, created_by_id, idempotency_key) ' +
        'SELECT $1, cs.company_id, cs.id, $4, $5, $6, $7::jsonb, $8, $9, $10 FROM change_sets cs WHERE cs.company_id = $2 AND cs.id = $3 ' +
        'ON CONFLICT (company_id, change_set_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET idempotency_key = excluded.idempotency_key ' +
        'RETURNING id, company_id, change_set_id, outcome' +
      '), updated AS (' +
        'UPDATE change_sets cs SET status = inserted.outcome, updated_at = now() FROM inserted ' +
        'WHERE cs.company_id = inserted.company_id AND cs.id = inserted.change_set_id RETURNING cs.id' +
      ') SELECT inserted.id FROM inserted JOIN updated ON updated.id = inserted.change_set_id LIMIT 1',
      [
        globalThis.crypto.randomUUID(),
        companyId,
        changeSetId,
        outcome,
        confidence,
        requiredString(params, "summary"),
        JSON.stringify(asRecord(params.evidenceSummary)),
        actor.type,
        actor.id,
        idempotencyKey,
      ],
    );
    const rows = await ctx.db.query<{ id: string }>(
      'SELECT id FROM change_conclusions WHERE company_id = $1 AND change_set_id = $2 AND idempotency_key = $3 LIMIT 1',
      [companyId, changeSetId, idempotencyKey],
    );
    if (!rows[0]) throw new Error("Change Set not found");
    return { ok: true, id: rows[0].id };
  });

  ctx.actions.register("move-selected-change-items", async (params, actionContext) => {
    const companyId = authorizedCompanyId(params, actionContext);
    const sourceChangeSetId = requiredString(params, "sourceChangeSetId");
    const targetChangeSetId = requiredString(params, "targetChangeSetId");
    const changeItemIds = selectedChangeItemIds(params);
    // The host SQL binder expands JavaScript arrays as a parameter list, not a
    // PostgreSQL array. IDs are format-validated above, so this literal is safe
    // as one scalar parameter for the explicit ::uuid[] casts below.
    const changeItemIdsPgArray = `{${changeItemIds.join(",")}}`;
    if (sourceChangeSetId === targetChangeSetId) throw new Error("Source and target Change Sets must differ");

    // Lock both parents in UUID order to serialize overlapping moves without deadlocks.
    // The CTE validates that every selected item is still at the source or was already
    // moved to this target by a previous attempt before changing any row.
    await ctx.db.execute(
      'WITH locked_sets AS MATERIALIZED (' +
        'SELECT id FROM change_sets WHERE company_id = $1 AND id IN ($2, $3) ORDER BY id FOR UPDATE' +
      '), valid AS MATERIALIZED (' +
        'SELECT count(*) = 2 AND (' +
          'SELECT count(*) = cardinality($4::uuid[]) FROM change_items ' +
          'WHERE company_id = $1 AND id = ANY($4::uuid[]) AND change_set_id IN ($2, $3)' +
        ') AS can_move FROM locked_sets' +
      '), moved AS (' +
        'UPDATE change_items SET change_set_id = $3 WHERE company_id = $1 AND change_set_id = $2 ' +
        'AND id = ANY($4::uuid[]) AND (SELECT can_move FROM valid) RETURNING id' +
      '), linked AS (' +
        'INSERT INTO change_links (id, company_id, change_set_id, link_type, reference_id, label, metadata) ' +
        'SELECT gen_random_uuid(), $1, $3, \'change_set\', $2::text, \'Selected changes from source Change Set\', ' +
          'jsonb_build_object(\'movedItemIds\', to_jsonb($4::uuid[])) FROM valid WHERE can_move ' +
        'ON CONFLICT (company_id, change_set_id, link_type, reference_id) DO UPDATE SET ' +
          'metadata = jsonb_set(COALESCE(change_links.metadata, \'{}\'::jsonb) || excluded.metadata, \'{movedItemIds}\', (' +
            'SELECT jsonb_agg(to_jsonb(item_id) ORDER BY item_id) FROM (' +
              'SELECT jsonb_array_elements_text(COALESCE(change_links.metadata->\'movedItemIds\', \'[]\'::jsonb)) AS item_id ' +
              'UNION SELECT unnest($4::uuid[])::text AS item_id' +
            ') AS merged' +
          '), true) RETURNING id' +
      ') SELECT (SELECT count(*) FROM moved) AS moved_count, (SELECT count(*) FROM linked) AS link_count',
      [companyId, sourceChangeSetId, targetChangeSetId, changeItemIdsPgArray],
    );

    const outcome = await ctx.db.query<{ parentCount: number; targetCount: number; linkCount: number }>(
      'SELECT (SELECT count(*)::int FROM change_sets WHERE company_id = $1 AND id IN ($2, $3)) AS "parentCount", ' +
        '(SELECT count(*)::int FROM change_items WHERE company_id = $1 AND id = ANY($4::uuid[]) AND change_set_id = $3) AS "targetCount", ' +
        '(SELECT count(*)::int FROM change_links WHERE company_id = $1 AND change_set_id = $3 AND link_type = \'change_set\' AND reference_id = $2::text) AS "linkCount"',
      [companyId, sourceChangeSetId, targetChangeSetId, changeItemIdsPgArray],
    );
    if (outcome[0]?.parentCount !== 2) throw new Error("Source or target Change Set not found");
    if (outcome[0]?.targetCount !== changeItemIds.length || outcome[0]?.linkCount !== 1) {
      throw new Error("Every selected change item must belong to the source or target Change Set");
    }

    // If a metric query fails after the atomic move, the same action can be retried:
    // its items already at target are accepted and both sets are recomputed again.
    await recomputeMetrics(ctx, companyId, sourceChangeSetId);
    await recomputeMetrics(ctx, companyId, targetChangeSetId);
    return { ok: true, selectedCount: changeItemIds.length, sourceChangeSetId, targetChangeSetId };
  });

  ctx.actions.register("merge-change-set", async (params, actionContext) => {
    const companyId = authorizedCompanyId(params, actionContext);
    const sourceChangeSetId = requiredString(params, "sourceChangeSetId");
    const targetChangeSetId = requiredString(params, "targetChangeSetId");
    if (sourceChangeSetId === targetChangeSetId) throw new Error("Source and target Change Sets must differ");
    const prior = await ctx.db.query<{ targetChangeSetId: string }>(
      'SELECT target_change_set_id AS "targetChangeSetId" FROM merge_operations WHERE company_id = $1 AND source_change_set_id = $2 LIMIT 1',
      [companyId, sourceChangeSetId],
    );
    if (prior[0] && prior[0].targetChangeSetId !== targetChangeSetId) {
      throw new Error("Source Change Set was already merged into another target");
    }

    await ctx.db.execute(
      'WITH locked_sets AS MATERIALIZED (' +
        'SELECT id FROM change_sets WHERE company_id = $1 AND id IN ($2, $3) ORDER BY id FOR UPDATE' +
      '), prior_merge AS MATERIALIZED (' +
        'SELECT target_change_set_id FROM merge_operations WHERE company_id = $1 AND source_change_set_id = $2' +
      '), valid AS MATERIALIZED (' +
        'SELECT count(*) = 2 AS parents_exist FROM locked_sets' +
      '), operation AS (' +
        'INSERT INTO merge_operations (company_id, source_change_set_id, target_change_set_id) ' +
        'SELECT $1, $2, $3 FROM valid WHERE parents_exist AND NOT EXISTS (SELECT 1 FROM prior_merge) ' +
        'ON CONFLICT (company_id, source_change_set_id) DO NOTHING RETURNING source_change_set_id' +
      '), moved_items AS (' +
        'UPDATE change_items SET change_set_id = $3 WHERE company_id = $1 AND change_set_id = $2 ' +
        'AND EXISTS (SELECT 1 FROM operation) RETURNING id' +
      '), dropped_duplicate_evidence AS (' +
        'DELETE FROM change_evidence source WHERE source.company_id = $1 AND source.change_set_id = $2 ' +
        'AND EXISTS (SELECT 1 FROM operation) AND source.evidence_type = \'run\' ' +
        'AND source.metadata->>\'capture\' = \'automatic\' AND EXISTS (' +
          'SELECT 1 FROM change_evidence target WHERE target.company_id = $1 AND target.change_set_id = $3 ' +
          'AND target.evidence_type = \'run\' AND target.reference_id = source.reference_id' +
        ') RETURNING source.id' +
      '), moved_evidence AS (' +
        'UPDATE change_evidence SET change_set_id = $3 WHERE company_id = $1 AND change_set_id = $2 ' +
        'AND EXISTS (SELECT 1 FROM operation) ' +
        'AND id NOT IN (SELECT id FROM dropped_duplicate_evidence) RETURNING id' +
      '), moved_conclusions AS (' +
        'UPDATE change_conclusions SET change_set_id = $3 WHERE company_id = $1 AND change_set_id = $2 ' +
        'AND EXISTS (SELECT 1 FROM operation) RETURNING id' +
      '), copied_links AS (' +
        'INSERT INTO change_links (id, company_id, change_set_id, link_type, reference_id, label, metadata) ' +
        'SELECT gen_random_uuid(), company_id, $3, link_type, reference_id, label, metadata FROM change_links ' +
        'WHERE company_id = $1 AND change_set_id = $2 AND EXISTS (SELECT 1 FROM operation) ' +
        'ON CONFLICT (company_id, change_set_id, link_type, reference_id) DO NOTHING RETURNING id' +
      '), removed_links AS (' +
        'DELETE FROM change_links WHERE company_id = $1 AND change_set_id = $2 AND EXISTS (SELECT 1 FROM operation) ' +
        'AND (SELECT count(*) FROM copied_links) >= 0 RETURNING id' +
      '), removed_metrics AS (' +
        'DELETE FROM change_metrics WHERE company_id = $1 AND change_set_id = $2 AND EXISTS (SELECT 1 FROM operation) RETURNING id' +
      '), retargeted_history AS (' +
        'UPDATE merge_operations SET target_change_set_id = $3 WHERE company_id = $1 AND target_change_set_id = $2 ' +
        'AND EXISTS (SELECT 1 FROM operation) RETURNING source_change_set_id' +
      '), removed_source AS (' +
      'DELETE FROM change_sets WHERE company_id = $1 AND id = $2 AND EXISTS (SELECT 1 FROM operation) ' +
        'AND (SELECT count(*) FROM moved_items) >= 0 AND (SELECT count(*) FROM moved_evidence) >= 0 ' +
        'AND (SELECT count(*) FROM moved_conclusions) >= 0 AND (SELECT count(*) FROM removed_links) >= 0 ' +
        'AND (SELECT count(*) FROM removed_metrics) >= 0 AND (SELECT count(*) FROM retargeted_history) >= 0 RETURNING id' +
      ') SELECT 1',
      [companyId, sourceChangeSetId, targetChangeSetId],
    );
    const merged = await ctx.db.query<{ targetChangeSetId: string }>(
      'SELECT target_change_set_id AS "targetChangeSetId" FROM merge_operations WHERE company_id = $1 AND source_change_set_id = $2 LIMIT 1',
      [companyId, sourceChangeSetId],
    );
    if (!merged[0]) {
      throw new Error("Source or target Change Set not found, or source was merged elsewhere");
    }
    if (merged[0].targetChangeSetId !== targetChangeSetId) {
      throw new Error("Source Change Set was already merged into another target");
    }
    await recomputeMetrics(ctx, companyId, targetChangeSetId);
    return { ok: true, targetChangeSetId, alreadyMerged: prior.length > 0 };
  });

  ctx.actions.register("backfill-recent", async (params, actionContext) => {
    return backfill(ctx, authorizedCompanyId(params, actionContext), numberParam(params, "days", 7));
  });

  ctx.actions.register("recompute-metrics", async (params, actionContext) => {
    const companyId = authorizedCompanyId(params, actionContext);
    const changeSetId = requiredString(params, "changeSetId");
    await recomputeMetrics(ctx, companyId, changeSetId);
    return assessSet(ctx, companyId, changeSetId);
  });

  ctx.actions.register("refresh-assessment", async (params, actionContext) => {
    return refreshSet(ctx, authorizedCompanyId(params, actionContext), requiredString(params, "changeSetId"));
  });
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
    const result = await overview(ctx, companyId);
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

let mcpCtx: PluginContext;
const mcpHandler = createPluginMcpEndpoint({
  name: "journeystudios.evolution",
  version: "0.2.0",
  tools: [
    {
      name: "orgTrackerOverview",
      title: "Org Tracker Overview",
      description: "List up to 100 tracked change sets and status counts within the authorized company.",
      readOnly: true,
      inputSchema: { type: "object", additionalProperties: false },
      execute: async (_args, { companyId }) => ({ companyId, ...await overview(mcpCtx, companyId) }),
    },
    {
      name: "orgTrackerChangeSummary",
      title: "Org Tracker Change Summary",
      description: "Read a bounded, redacted change set summary without raw before/after snapshots or metadata.",
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: { changeSetId: { type: "string", format: "uuid" } },
        required: ["changeSetId"], additionalProperties: false,
      },
      execute: (args, { companyId }) => mcpChangeSummary(mcpCtx, companyId, args.changeSetId as string),
    },
  ],
});

const plugin = definePlugin({
  async onApiRequest(input) {
    if (input.routeKey !== "mcp") return { status: 404, body: { error: "Unknown Org Tracker API route" } };
    return mcpHandler(input);
  },
  async setup(ctx) {
    const workerCtx = withEvolutionDatabaseNamespace(ctx);
    mcpCtx = workerCtx;
    workerCtx.data.register("changes-overview", async (params) => overview(workerCtx, requiredString(params, "companyId")));
    workerCtx.data.register("change-detail", async (params) =>
      detail(workerCtx, requiredString(params, "companyId"), requiredString(params, "changeSetId")));

    registerActions(workerCtx);
    registerTools(workerCtx);
    workerCtx.jobs.register("refresh-assessments", async () => refreshAllCompanies(workerCtx));

    workerCtx.events.on("agent.created", async (event) => recordAgentEvent(workerCtx, event));
    workerCtx.events.on("agent.updated", async (event) => recordAgentEvent(workerCtx, event));
    workerCtx.events.on("agent.status_changed", async (event) => recordAgentEvent(workerCtx, event));
    workerCtx.events.on("agent.error_cleared", async (event) => recordAgentEvent(workerCtx, event));
    workerCtx.events.on("activity.logged", async (event) => recordActivityEvent(workerCtx, event));
    for (const kind of ["agent.run.finished", "agent.run.failed", "agent.run.cancelled"] as const) {
      workerCtx.events.on(kind, async (event) => onRunTerminal(workerCtx, event));
    }

    workerCtx.logger.info("Evolution Change Intelligence ready");
  },

  async onHealth() {
    return { status: "ok", message: "Evolution is ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

export { backfill, recordActivityEvent };
