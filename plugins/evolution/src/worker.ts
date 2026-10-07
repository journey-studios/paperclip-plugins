import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";

import { mergeChangeSets } from "./merge.ts";
import { withCaptureRetry } from "./capture-retry.ts";

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

function assertDatabaseNamespace(namespace: string): void {
  if (!/^plugin_[a-z0-9_]+$/.test(namespace) || namespace.length > 63) {
    throw new Error("Invalid plugin database namespace");
  }
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = stringParam(params, key);
  if (!value) throw new Error(key + " is required");
  return value;
}

function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
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
  const normalized = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
  return /(^|_)(api_?key|access_token|refresh_token|id_token|token|secret|password|credential|authorization|cookie)($|_)/.test(normalized) ||
    /(^|_)(private_?key|ssh_?key|passphrase|pwd|dsn|bearer|database_?url|connection_?string)$/.test(normalized);
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
  const contextParams = [input.companyId, input.sourceContextKey];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const aliases = await ctx.db.query<{ id: string }>(
      `SELECT change_set_id AS id FROM ${ctx.db.namespace}.change_context_aliases WHERE company_id = $1 AND source_context_key = $2 LIMIT 1`,
      contextParams,
    );
    if (aliases[0]) return aliases[0].id;

    let candidate = (await ctx.db.query<{ id: string }>(
      `SELECT id FROM ${ctx.db.namespace}.change_sets WHERE company_id = $1 AND source_context_key = $2 LIMIT 1`,
      contextParams,
    ))[0];
    let createdId: string | undefined;
    if (!candidate) {
      const id = globalThis.crypto.randomUUID();
      await ctx.db.execute(
        `INSERT INTO ${ctx.db.namespace}.change_sets (id, company_id, title, status, causality_level, source_context_key, applied_at, created_by_type, created_by_id) ` +
          'VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9) ON CONFLICT DO NOTHING',
        [id, input.companyId, input.title ?? "Operational changes · " + humanTimestamp(input.occurredAt),
          "applied", "observed", input.sourceContextKey, input.occurredAt, input.actorType ?? null, input.actorId ?? null],
      );
      candidate = (await ctx.db.query<{ id: string }>(
        `SELECT id FROM ${ctx.db.namespace}.change_sets WHERE company_id = $1 AND source_context_key = $2 LIMIT 1`,
        contextParams,
      ))[0];
      if (candidate?.id === id) createdId = id;
    }
    // A concurrent merge can remove the candidate before this lookup resolves.
    if (!candidate) continue;

    try {
      await ctx.db.execute(
        `INSERT INTO ${ctx.db.namespace}.change_context_aliases (company_id, source_context_key, change_set_id) ` +
          'VALUES ($1, $2, $3) ON CONFLICT (company_id, source_context_key) DO NOTHING',
        [...contextParams, candidate.id],
      );
    } catch (error) {
      const failure = error && typeof error === "object" ? error as Record<string, unknown> : {};
      const constraint = failure.constraint_name ?? failure.constraint ?? failure.constraintName;
      const message = typeof error === "string" ? error : typeof failure.message === "string" ? failure.message : "";
      const aliasConstraint = "evolution_change_context_aliases_company_set_fkey";
      const code = failure.code === undefined ? undefined : String(failure.code);
      const foreignKeyRace = code === "23503" && constraint === aliasConstraint ||
        (code === undefined || code === "23503" || code === "-32603") &&
        /foreign\s+key|\b23503\b/i.test(message) && new RegExp("\\b" + aliasConstraint + "\\b").test(message);
      if (foreignKeyRace) continue;
      throw error;
    }

    // The unique context registry is the authority. In particular, an alias
    // inserted by a merge wins over a candidate created after the initial read.
    const winner = (await ctx.db.query<{ id: string }>(
      `SELECT change_set_id AS id FROM ${ctx.db.namespace}.change_context_aliases WHERE company_id = $1 AND source_context_key = $2 LIMIT 1`,
      contextParams,
    ))[0];
    if (!winner) continue;
    if (createdId && winner.id !== createdId) {
      await ctx.db.execute(
        `DELETE FROM ${ctx.db.namespace}.change_sets WHERE company_id = $1 AND id = $2 ` +
          `AND NOT EXISTS (SELECT 1 FROM ${ctx.db.namespace}.change_items WHERE company_id = $1 AND change_set_id = $2) ` +
          `AND NOT EXISTS (SELECT 1 FROM ${ctx.db.namespace}.change_evidence WHERE company_id = $1 AND change_set_id = $2) ` +
          `AND NOT EXISTS (SELECT 1 FROM ${ctx.db.namespace}.change_conclusions WHERE company_id = $1 AND change_set_id = $2) ` +
          `AND NOT EXISTS (SELECT 1 FROM ${ctx.db.namespace}.change_links WHERE company_id = $1 AND change_set_id = $2) ` +
          `AND NOT EXISTS (SELECT 1 FROM ${ctx.db.namespace}.change_metrics WHERE company_id = $1 AND change_set_id = $2) ` +
          `AND NOT EXISTS (SELECT 1 FROM ${ctx.db.namespace}.change_context_aliases WHERE company_id = $1 AND change_set_id = $2)`,
        [input.companyId, createdId],
      );
    }
    return winner.id;
  }
  throw new Error("Could not resolve Change Set after concurrent updates");
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
    `INSERT INTO ${ctx.db.namespace}.change_links (id, company_id, change_set_id, link_type, reference_id, label) ` +
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
        `UPDATE ${ctx.db.namespace}.change_sets SET title = $3, updated_at = now() ` +
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
): Promise<{ id: string; snapshotHash: string; snapshot: unknown } | null> {
  const rows = await ctx.db.query<{ id: string; snapshotHash: string; snapshot: unknown }>(
    `SELECT id, snapshot_hash AS "snapshotHash", snapshot FROM ${ctx.db.namespace}.change_snapshots ` +
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
  const clean = sanitize(input.snapshot);
  const hash = snapshotHash(clean);
  const previous = await latestSnapshot(ctx, input.companyId, input.entityType, input.entityId);
  if (previous?.snapshotHash === hash) return previous.id;

  const id = globalThis.crypto.randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${ctx.db.namespace}.change_snapshots (id, company_id, entity_type, entity_id, entity_name, snapshot_hash, snapshot, source_type, source_ref, captured_at) ` +
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
    occurredAt: string;
  },
): Promise<boolean> {
  if (input.sourceRef) {
    const prior = await ctx.db.query<{ id: string }>(
      `SELECT id FROM ${ctx.db.namespace}.change_items WHERE company_id = $1 AND source_type = $2 AND source_ref = $3 LIMIT 1`,
      [input.companyId, input.sourceType, input.sourceRef],
    );
    if (prior[0]) {
      if (input.sourceActivityId) {
        await ctx.db.execute(
          `UPDATE ${ctx.db.namespace}.change_items SET source_activity_id = coalesce(source_activity_id, $3) WHERE company_id = $1 AND id = $2`,
          [input.companyId, prior[0].id, input.sourceActivityId],
        );
      }
      return false;
    }
  }

  await ctx.db.execute(
    `INSERT INTO ${ctx.db.namespace}.change_items ` +
      '(id, company_id, change_set_id, entity_type, entity_id, entity_name, change_kind, changed_keys, before_snapshot_id, after_snapshot_id, source_type, source_ref, source_activity_id, occurred_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14::timestamptz) ON CONFLICT DO NOTHING',
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

async function recordAgentEvent(ctx: PluginContext, event: PluginEvent) {
  const companyId = event.companyId;
  const agentId = event.entityId;
  if (!companyId || !agentId) return;
  const occurredAt = event.occurredAt;
  const payload = asRecord(event.payload);
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  const agent = await currentAgent(ctx, companyId, agentId);
  if (!agent) return;

  const revision = event.eventType === "agent.updated"
    ? await latestAgentRevisionNear(ctx, companyId, agentId, occurredAt)
    : null;

  let beforeId: string | null = null;
  let afterId: string | null = null;
  let sourceRef = event.eventId;
  let changedKeys: unknown[] = [];

  if (revision) {
    sourceRef = revision.id;
    changedKeys = asArray(revision.changedKeys);
    beforeId = await writeSnapshot(ctx, {
      companyId,
      entityType: "agent",
      entityId: agentId,
      entityName: agent.name,
      snapshot: revision.beforeConfig,
      sourceType: "agent_config_revision_before",
      sourceRef: revision.id,
      capturedAt: iso(revision.createdAt),
    });
    afterId = await writeSnapshot(ctx, {
      companyId,
      entityType: "agent",
      entityId: agentId,
      entityName: agent.name,
      snapshot: revision.afterConfig,
      sourceType: "agent_config_revision_after",
      sourceRef: revision.id,
      capturedAt: iso(revision.createdAt),
    });
  } else {
    const previous = await latestSnapshot(ctx, companyId, "agent", agentId);
    beforeId = previous?.id ?? null;
    afterId = await writeSnapshot(ctx, {
      companyId,
      entityType: "agent",
      entityId: agentId,
      entityName: agent.name,
      snapshot: compactAgentSnapshot(agent),
      sourceType: event.eventType,
      sourceRef: event.eventId,
      capturedAt: occurredAt,
    });
  }

  const sourceContextKey = bucketContext(occurredAt, event.actorType, event.actorId, runId);
  const changeSetId = await ensureChangeSet(ctx, {
    companyId,
    sourceContextKey,
    occurredAt,
    actorType: event.actorType,
    actorId: event.actorId,
  });
  await attachRunContext(ctx, companyId, changeSetId, runId);

  await writeItem(ctx, {
    companyId,
    changeSetId,
    entityType: "agent",
    entityId: agentId,
    entityName: agent.name,
    changeKind: event.eventType,
    changedKeys,
    beforeSnapshotId: beforeId,
    afterSnapshotId: afterId,
    sourceType: revision ? "agent_config_revision" : "plugin_event",
    sourceRef,
    occurredAt,
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
    markdown: skill.markdown,
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
      content: path === "SKILL.md" && typeof row.content === "string" ? row.content : undefined,
    };
  });
}

async function recordActivityEvent(ctx: PluginContext, event: PluginEvent) {
  if (event.entityType !== "agent" && event.entityType !== "company_skill") return;
  const payload = asRecord(event.payload);
  const action = typeof payload.activityAction === "string" ? payload.activityAction : "";
  if (!action) return;
  const relevant =
    action.startsWith("company.skill_") ||
    action.startsWith("company.skills_") ||
    action.startsWith("agent.instructions_") ||
    action === "agent.skills_synced" ||
    action === "agent.permissions_updated" ||
    action === "agent.config_rolled_back" ||
    action === "agent.budget_updated" ||
    action === "plugin.managed_agent.reset" ||
    action === "plugin.managed_skill.reconciled" ||
    action === "plugin.managed_skill.reset";
  if (!relevant) return;

  const companyId = event.companyId;
  if (!companyId || !event.entityId) return;
  const occurredAt = event.occurredAt;
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  const entityType = event.entityType === "company_skill" ? "skill" : "agent";
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
    if (skill) afterSnapshot = compactSkillSnapshot(skill);
  } else {
    const agent = await currentAgent(ctx, companyId, event.entityId);
    entityName = agent?.name ?? null;
    revision = await latestAgentRevisionNear(ctx, companyId, event.entityId, occurredAt);
    if (revision) {
      afterSnapshot = revision.afterConfig;
    } else if (agent) {
      afterSnapshot = {
        ...asRecord(compactAgentSnapshot(agent)),
        activity: {
          action,
          details: sanitize(payload),
          partialSnapshot: action.startsWith("agent.instructions_"),
        },
      };
    }
  }

  const previous = await latestSnapshot(ctx, companyId, entityType, event.entityId);
  let beforeId = previous?.id ?? null;
  if (revision) {
    beforeId = await writeSnapshot(ctx, {
      companyId,
      entityType: "agent",
      entityId: event.entityId,
      entityName,
      snapshot: revision.beforeConfig,
      sourceType: "agent_config_revision_before",
      sourceRef: revision.id,
      capturedAt: occurredAt,
    });
  }

  const afterId = await writeSnapshot(ctx, {
    companyId,
    entityType,
    entityId: event.entityId,
    entityName,
    snapshot: afterSnapshot,
    sourceType: revision ? "agent_config_revision_after" : "activity",
    sourceRef: revision?.id ?? event.eventId,
    capturedAt: occurredAt,
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
    sourceRef: revision?.id ?? event.eventId,
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
  return withCaptureRetry(() => backfillOnce(ctx, companyId, days));
}

async function backfillOnce(ctx: PluginContext, companyId: string, days: number) {
  const boundedDays = Math.min(30, Math.max(1, Math.floor(days)));
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
      'FROM public.agent_config_revisions r JOIN public.agents a ON a.id = r.agent_id AND a.company_id = r.company_id ' +
      'WHERE r.company_id = $1 AND r.created_at >= now() - ($2::text || \' days\')::interval ' +
      'ORDER BY r.created_at ASC LIMIT 1000',
    [companyId, String(boundedDays)],
  );

  let agentItems = 0;
  for (const revision of agentRevisions) {
    const occurredAt = iso(revision.createdAt);
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
      'JOIN public.company_skills s ON s.id = v.company_skill_id AND s.company_id = v.company_id ' +
      'WHERE v.company_id = $1 AND v.created_at >= now() - ($2::text || \' days\')::interval ' +
      'ORDER BY v.company_skill_id ASC, v.revision_number ASC LIMIT 1000',
    [companyId, String(boundedDays)],
  );

  const previousVersion = new Map<string, { id: string; snapshotId: string }>();
  let skillItems = 0;
  for (const version of versions) {
    const occurredAt = iso(version.createdAt);
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
    const prior = previousVersion.get(version.skillId);
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
      beforeSnapshotId: prior?.snapshotId ?? null,
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
      'AND entity_type IN (\'agent\', \'company_skill\') ' +
      'AND (entity_type = \'company_skill\' OR action LIKE \'agent.instructions_%\' OR action IN ' +
      '(\'agent.skills_synced\',\'agent.permissions_updated\',\'agent.config_rolled_back\',\'agent.budget_updated\',\'plugin.managed_agent.reset\')) ' +
      'ORDER BY created_at ASC LIMIT 1500',
    [companyId, String(boundedDays)],
  );

  let activityItems = 0;
  for (const row of activityRows) {
    if (row.entityType !== "agent" && row.entityType !== "company_skill") continue;
    const occurredAt = iso(row.createdAt);
    const entityType = row.entityType === "company_skill" ? "skill" : "agent";
    let entityName: string | null = null;

    if (entityType === "agent") {
      const revision = await latestAgentRevisionNear(ctx, companyId, row.entityId, occurredAt);
      if (revision) {
        const existingRevisionItem = await ctx.db.query<{ id: string; changeSetId: string }>(
          `SELECT id, change_set_id AS "changeSetId" FROM ${ctx.db.namespace}.change_items WHERE company_id = $1 AND source_type = 'agent_config_revision' AND source_ref = $2 LIMIT 1`,
          [companyId, revision.id],
        );
        if (existingRevisionItem[0]) {
          await ctx.db.execute(
            `UPDATE ${ctx.db.namespace}.change_items SET source_activity_id = coalesce(source_activity_id, $3) WHERE company_id = $1 AND id = $2`,
            [companyId, existingRevisionItem[0].id, row.id],
          );
          await attachRunContext(ctx, companyId, existingRevisionItem[0].changeSetId, row.runId);
          continue;
        }
      }
    }

    let activitySnapshot: unknown = { activityAction: row.action, details: sanitize(asRecord(row.details)) };
    if (entityType === "skill") {
      const skill = await currentSkill(ctx, companyId, row.entityId);
      entityName = skill?.name ?? null;
      if (skill) activitySnapshot = compactSkillSnapshot(skill);
    } else {
      const agent = await currentAgent(ctx, companyId, row.entityId);
      entityName = agent?.name ?? null;
      if (agent) {
        activitySnapshot = {
          ...asRecord(compactAgentSnapshot(agent)),
          activity: {
            action: row.action,
            details: sanitize(asRecord(row.details)),
            partialSnapshot: row.action.startsWith("agent.instructions_"),
          },
        };
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
      capturedAt: occurredAt,
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

async function queryRunStats(
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
    'SELECT count(*)::int AS runs, count(*) FILTER (WHERE status = \'succeeded\')::int AS successes, ' +
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

async function queryCostStats(
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
    costCents: number | string;
    inputTokens: number | string;
    cachedInputTokens: number | string;
    outputTokens: number | string;
    events: number | string;
  }>(
    'SELECT coalesce(sum(cost_cents),0)::float AS "costCents", coalesce(sum(input_tokens),0)::float AS "inputTokens", ' +
      'coalesce(sum(cached_input_tokens),0)::float AS "cachedInputTokens", coalesce(sum(output_tokens),0)::float AS "outputTokens", ' +
      'count(*)::int AS events FROM public.cost_events WHERE company_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz' +
      agentFilter,
    params,
  );
  const row = rows[0];
  const events = Number(row?.events ?? 0);
  return {
    costUsd: events > 0 ? Number(row?.costCents ?? 0) / 100 : null,
    inputTokens: events > 0 ? Number(row?.inputTokens ?? 0) : null,
    cachedInputTokens: events > 0 ? Number(row?.cachedInputTokens ?? 0) : null,
    outputTokens: events > 0 ? Number(row?.outputTokens ?? 0) : null,
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
) {
  const delta = baseline == null || current == null ? null : current - baseline;
  await ctx.db.execute(
    `INSERT INTO ${ctx.db.namespace}.change_metrics (id, company_id, change_set_id, metric_key, baseline_value, current_value, delta_value, unit, baseline_sample_size, current_sample_size, computed_at) ` +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()) ' +
      'ON CONFLICT (company_id, change_set_id, metric_key) DO UPDATE SET baseline_value = excluded.baseline_value, current_value = excluded.current_value, ' +
      'delta_value = excluded.delta_value, unit = excluded.unit, baseline_sample_size = excluded.baseline_sample_size, current_sample_size = excluded.current_sample_size, computed_at = now()',
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
    ],
  );
}

async function recomputeMetrics(ctx: PluginContext, companyId: string, changeSetId: string) {
  const sets = await ctx.db.query<{ appliedAt: string | Date; validationEndsAt: string | Date | null }>(
    `SELECT applied_at AS "appliedAt", validation_ends_at AS "validationEndsAt" FROM ${ctx.db.namespace}.change_sets WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, changeSetId],
  );
  const set = sets[0];
  if (!set) throw new Error("Change Set not found");
  const appliedAt = new Date(iso(set.appliedAt));
  const baselineStart = new Date(appliedAt.getTime() - 7 * 86400000).toISOString();
  const currentEnd = set.validationEndsAt
    ? new Date(Math.min(Date.now(), new Date(iso(set.validationEndsAt)).getTime())).toISOString()
    : new Date(Math.min(Date.now(), appliedAt.getTime() + 7 * 86400000)).toISOString();

  const agentRows = await ctx.db.query<{ entityId: string }>(
    `SELECT DISTINCT entity_id AS "entityId" FROM ${ctx.db.namespace}.change_items WHERE company_id = $1 AND change_set_id = $2 AND entity_type = 'agent'`,
    [companyId, changeSetId],
  );
  const agentIds = agentRows.map((row) => row.entityId);
  if (agentIds.length === 0) {
    await ctx.db.execute(
      `DELETE FROM ${ctx.db.namespace}.change_metrics WHERE company_id = $1 AND change_set_id = $2`,
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

  await upsertMetric(ctx, companyId, changeSetId, "run_success_rate", baselineRuns.successRate, currentRuns.successRate, "%", baselineRuns.runs, currentRuns.runs);
  await upsertMetric(ctx, companyId, changeSetId, "avg_run_duration", baselineRuns.avgDuration, currentRuns.avgDuration, "seconds", baselineRuns.runs, currentRuns.runs);
  await upsertMetric(ctx, companyId, changeSetId, "cost", baselineCosts.costUsd, currentCosts.costUsd, "USD", baselineCosts.events, currentCosts.events);
  await upsertMetric(ctx, companyId, changeSetId, "input_tokens", baselineCosts.inputTokens, currentCosts.inputTokens, "tokens", baselineCosts.events, currentCosts.events);
  await upsertMetric(ctx, companyId, changeSetId, "cached_input_tokens", baselineCosts.cachedInputTokens, currentCosts.cachedInputTokens, "tokens", baselineCosts.events, currentCosts.events);
  await upsertMetric(ctx, companyId, changeSetId, "output_tokens", baselineCosts.outputTokens, currentCosts.outputTokens, "tokens", baselineCosts.events, currentCosts.events);
  return { agentIds, baselineStart, appliedAt: appliedAt.toISOString(), currentEnd };
}

async function overview(ctx: PluginContext, companyId: string) {
  const changeSets = await ctx.db.query<Record<string, unknown>>(
    'SELECT cs.id, cs.title, cs.description, cs.hypothesis, cs.status, cs.causality_level AS "causalityLevel", ' +
      'cs.applied_at AS "appliedAt", cs.validation_ends_at AS "validationEndsAt", cs.updated_at AS "updatedAt", ' +
      'count(DISTINCT ci.id)::int AS "itemCount", count(DISTINCT ce.id)::int AS "evidenceCount", count(DISTINCT cm.id)::int AS "metricCount" ' +
      `FROM ${ctx.db.namespace}.change_sets cs LEFT JOIN ${ctx.db.namespace}.change_items ci ON ci.change_set_id = cs.id AND ci.company_id = cs.company_id ` +
      `LEFT JOIN ${ctx.db.namespace}.change_evidence ce ON ce.change_set_id = cs.id AND ce.company_id = cs.company_id ` +
      `LEFT JOIN ${ctx.db.namespace}.change_metrics cm ON cm.change_set_id = cs.id AND cm.company_id = cs.company_id ` +
      'WHERE cs.company_id = $1 GROUP BY cs.id ORDER BY cs.applied_at DESC LIMIT 100',
    [companyId],
  );
  const counts = await ctx.db.query<{ status: string; count: number | string }>(
    `SELECT status, count(*)::int AS count FROM ${ctx.db.namespace}.change_sets WHERE company_id = $1 GROUP BY status`,
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
      `created_at AS "createdAt", updated_at AS "updatedAt" FROM ${ctx.db.namespace}.change_sets WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, changeSetId],
  );
  if (!sets[0]) throw new Error("Change Set not found");

  const [items, evidence, metrics, conclusions, links] = await Promise.all([
    ctx.db.query<Record<string, unknown>>(
      'SELECT ci.id, ci.entity_type AS "entityType", ci.entity_id AS "entityId", ci.entity_name AS "entityName", ci.change_kind AS "changeKind", ' +
        'ci.changed_keys AS "changedKeys", ci.source_type AS "sourceType", ci.source_ref AS "sourceRef", ci.source_activity_id AS "sourceActivityId", ci.occurred_at AS "occurredAt", ' +
        `bs.snapshot AS "beforeSnapshot", asn.snapshot AS "afterSnapshot" FROM ${ctx.db.namespace}.change_items ci ` +
        `LEFT JOIN ${ctx.db.namespace}.change_snapshots bs ON bs.id = ci.before_snapshot_id AND bs.company_id = ci.company_id ` +
        `LEFT JOIN ${ctx.db.namespace}.change_snapshots asn ON asn.id = ci.after_snapshot_id AND asn.company_id = ci.company_id ` +
        'WHERE ci.company_id = $1 AND ci.change_set_id = $2 ORDER BY ci.occurred_at ASC',
      [companyId, changeSetId],
    ),
    ctx.db.query<Record<string, unknown>>(
      'SELECT id, evidence_type AS "evidenceType", reference_id AS "referenceId", label, verdict, notes, metadata, observed_at AS "observedAt", created_at AS "createdAt" ' +
        `FROM ${ctx.db.namespace}.change_evidence WHERE company_id = $1 AND change_set_id = $2 ORDER BY created_at DESC`,
      [companyId, changeSetId],
    ),
    ctx.db.query<Record<string, unknown>>(
      'SELECT metric_key AS "metricKey", baseline_value::float AS "baselineValue", current_value::float AS "currentValue", delta_value::float AS "deltaValue", ' +
        'unit, baseline_sample_size AS "baselineSampleSize", current_sample_size AS "currentSampleSize", computed_at AS "computedAt" ' +
        `FROM ${ctx.db.namespace}.change_metrics WHERE company_id = $1 AND change_set_id = $2 ORDER BY metric_key`,
      [companyId, changeSetId],
    ),
    ctx.db.query<Record<string, unknown>>(
      'SELECT id, outcome, confidence, summary, evidence_summary AS "evidenceSummary", created_at AS "createdAt" ' +
        `FROM ${ctx.db.namespace}.change_conclusions WHERE company_id = $1 AND change_set_id = $2 ORDER BY created_at DESC`,
      [companyId, changeSetId],
    ),
    ctx.db.query<Record<string, unknown>>(
      'SELECT id, link_type AS "linkType", reference_id AS "referenceId", label, metadata, created_at AS "createdAt" ' +
        `FROM ${ctx.db.namespace}.change_links WHERE company_id = $1 AND change_set_id = $2 ORDER BY created_at ASC`,
      [companyId, changeSetId],
    ),
  ]);

  const agentIds = [...new Set(items.filter((item) => item.entityType === "agent").map((item) => String(item.entityId)))];
  let suggestedRuns: Record<string, unknown>[] = [];
  if (agentIds.length > 0) {
    const inSql = placeholders(3, agentIds.length);
    suggestedRuns = await ctx.db.query<Record<string, unknown>>(
      'SELECT r.id, r.agent_id AS "agentId", a.name AS "agentName", r.status, r.started_at AS "startedAt", r.finished_at AS "finishedAt", ' +
        'r.invocation_source AS "invocationSource" FROM public.heartbeat_runs r JOIN public.agents a ON a.id = r.agent_id AND a.company_id = r.company_id ' +
        'WHERE r.company_id = $1 AND r.started_at >= $2::timestamptz AND r.agent_id IN (' + inSql + ') ORDER BY r.started_at DESC LIMIT 25',
      [companyId, String(sets[0].appliedAt), ...agentIds],
    );
  }

  return { changeSet: sets[0], items, evidence, metrics, conclusions, links, suggestedRuns };
}

async function assertChangeSet(ctx: PluginContext, companyId: string, changeSetId: string): Promise<void> {
  const rows = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ${ctx.db.namespace}.change_sets WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, changeSetId],
  );
  if (!rows[0]) throw new Error("Change Set not found");
}

function registerActions(ctx: PluginContext) {
  ctx.actions.register("create-change-set", async (params) => {
    const companyId = requiredString(params, "companyId");
    const title = requiredString(params, "title").slice(0, 180);
    const id = globalThis.crypto.randomUUID();
    const status = stringParam(params, "status") ?? "draft";
    if (!CHANGE_STATUSES.has(status)) throw new Error("Invalid status");
    const causality = stringParam(params, "causalityLevel") ?? "observed";
    if (!CAUSALITY_LEVELS.has(causality)) throw new Error("Invalid causality level");
    await ctx.db.execute(
      `INSERT INTO ${ctx.db.namespace}.change_sets (id, company_id, title, description, hypothesis, status, causality_level, applied_at, validation_ends_at, created_by_type, created_by_id) ` +
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
        stringParam(params, "createdByType") ?? "user",
        stringParam(params, "createdById") ?? null,
      ],
    );
    return { ok: true, id };
  });

  ctx.actions.register("update-change-set", async (params) => {
    const companyId = requiredString(params, "companyId");
    const changeSetId = requiredString(params, "changeSetId");
    const rows = await ctx.db.query<Record<string, unknown>>(
      `SELECT title, description, hypothesis, status, causality_level AS "causalityLevel", validation_ends_at AS "validationEndsAt" FROM ${ctx.db.namespace}.change_sets WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, changeSetId],
    );
    const current = rows[0];
    if (!current) throw new Error("Change Set not found");
    const status = stringParam(params, "status") ?? String(current.status);
    const causality = stringParam(params, "causalityLevel") ?? String(current.causalityLevel);
    if (!CHANGE_STATUSES.has(status)) throw new Error("Invalid status");
    if (!CAUSALITY_LEVELS.has(causality)) throw new Error("Invalid causality level");
    await ctx.db.execute(
      `UPDATE ${ctx.db.namespace}.change_sets SET title=$3, description=$4, hypothesis=$5, status=$6, causality_level=$7, validation_ends_at=$8::timestamptz, updated_at=now() ` +
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

  ctx.actions.register("add-evidence", async (params) => {
    const companyId = requiredString(params, "companyId");
    const changeSetId = requiredString(params, "changeSetId");
    await assertChangeSet(ctx, companyId, changeSetId);
    const evidenceType = requiredString(params, "evidenceType");
    const verdict = stringParam(params, "verdict") ?? "neutral";
    if (!EVIDENCE_VERDICTS.has(verdict)) throw new Error("Invalid evidence verdict");
    const id = globalThis.crypto.randomUUID();
    await ctx.db.execute(
      `INSERT INTO ${ctx.db.namespace}.change_evidence (id, company_id, change_set_id, evidence_type, reference_id, label, verdict, notes, metadata, observed_at) ` +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::timestamptz)',
      [
        id,
        companyId,
        changeSetId,
        evidenceType,
        stringParam(params, "referenceId") ?? null,
        stringParam(params, "label") ?? null,
        verdict,
        stringParam(params, "notes") ?? null,
        JSON.stringify(asRecord(params.metadata)),
        stringParam(params, "observedAt") ?? null,
      ],
    );
    return { ok: true, id };
  });

  ctx.actions.register("add-link", async (params) => {
    const companyId = requiredString(params, "companyId");
    const changeSetId = requiredString(params, "changeSetId");
    await assertChangeSet(ctx, companyId, changeSetId);
    const linkType = requiredString(params, "linkType");
    const referenceId = requiredString(params, "referenceId");
    await ctx.db.execute(
      `INSERT INTO ${ctx.db.namespace}.change_links (id, company_id, change_set_id, link_type, reference_id, label, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
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
    return { ok: true };
  });

  ctx.actions.register("add-conclusion", async (params) => {
    const companyId = requiredString(params, "companyId");
    const changeSetId = requiredString(params, "changeSetId");
    await assertChangeSet(ctx, companyId, changeSetId);
    const outcome = requiredString(params, "outcome");
    const confidence = stringParam(params, "confidence") ?? "low";
    if (!["proven", "regressed", "inconclusive", "reverted"].includes(outcome)) throw new Error("Invalid outcome");
    if (!CONFIDENCE_LEVELS.has(confidence)) throw new Error("Invalid confidence");
    await ctx.db.execute(
      `INSERT INTO ${ctx.db.namespace}.change_conclusions (id, company_id, change_set_id, outcome, confidence, summary, evidence_summary, created_by_type, created_by_id) ` +
        'VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)',
      [
        globalThis.crypto.randomUUID(),
        companyId,
        changeSetId,
        outcome,
        confidence,
        requiredString(params, "summary"),
        JSON.stringify(asRecord(params.evidenceSummary)),
        stringParam(params, "createdByType") ?? "user",
        stringParam(params, "createdById") ?? null,
      ],
    );
    await ctx.db.execute(
      `UPDATE ${ctx.db.namespace}.change_sets SET status=$3, updated_at=now() WHERE company_id=$1 AND id=$2`,
      [companyId, changeSetId, outcome],
    );
    return { ok: true };
  });

  ctx.actions.register("merge-change-set", async (params) => {
    const companyId = requiredString(params, "companyId");
    const sourceChangeSetId = requiredString(params, "sourceChangeSetId");
    const targetChangeSetId = requiredString(params, "targetChangeSetId");
    await mergeChangeSets(ctx, companyId, sourceChangeSetId, targetChangeSetId);
    // The transfer is committed; stale derived metrics must not report a failed
    // merge or leave the client retrying a source that has already been deleted.
    try {
      await recomputeMetrics(ctx, companyId, targetChangeSetId);
      return { ok: true, targetChangeSetId };
    } catch {
      return { ok: true, targetChangeSetId, metricsStale: true };
    }
  });

  ctx.actions.register("backfill-recent", async (params) => {
    return backfill(ctx, requiredString(params, "companyId"), numberParam(params, "days", 7));
  });

  ctx.actions.register("recompute-metrics", async (params) => {
    return recomputeMetrics(ctx, requiredString(params, "companyId"), requiredString(params, "changeSetId"));
  });
}

const plugin = definePlugin({
  async setup(ctx) {
    assertDatabaseNamespace(ctx.db.namespace);
    ctx.data.register("changes-overview", async (params) => overview(ctx, requiredString(params, "companyId")));
    ctx.data.register("change-detail", async (params) =>
      detail(ctx, requiredString(params, "companyId"), requiredString(params, "changeSetId")));

    registerActions(ctx);

    ctx.events.on("agent.created", async (event) => withCaptureRetry(() => recordAgentEvent(ctx, event)));
    ctx.events.on("agent.updated", async (event) => withCaptureRetry(() => recordAgentEvent(ctx, event)));
    ctx.events.on("agent.status_changed", async (event) => withCaptureRetry(() => recordAgentEvent(ctx, event)));
    ctx.events.on("agent.error_cleared", async (event) => withCaptureRetry(() => recordAgentEvent(ctx, event)));
    ctx.events.on("activity.logged", async (event) => withCaptureRetry(() => recordActivityEvent(ctx, event)));

    ctx.logger.info("Evolution Change Intelligence ready");
  },

  async onHealth() {
    return { status: "ok", message: "Evolution is ready" };
  },
});

export default plugin;
export { sanitize, recordActivityEvent, backfill, queryCostStats, recomputeMetrics, overview, registerActions, attachRunContext, ensureChangeSet };
runWorker(plugin, import.meta.url);
