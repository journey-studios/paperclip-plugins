import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  Actor,
  DashboardRecord,
  DashboardSettings,
  DashboardSpec,
  DashboardSummary,
  Dataset,
  RevisionSummary,
} from "./contracts.js";
import { normalizeSettings } from "./settings.js";
import { validateSpec } from "./spec.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9-]{1,64}$/;

/** A user-correctable failure whose message is safe to show to agents and board users. */
export class DashboardError extends Error {}

/** The dashboard, dataset or revision does not exist in this company. */
export class NotFoundError extends DashboardError {}

/** The spec failed validation; details are path-precise messages. */
export class InvalidSpecError extends DashboardError {
  constructor(readonly details: string[]) {
    super(`Invalid dashboard spec:\n${details.map((detail) => `- ${detail}`).join("\n")}`);
  }
}

/** The serialized spec exceeds the configured limit. */
export class SpecTooLargeError extends DashboardError {
  constructor(
    readonly bytes: number,
    readonly limitBytes: number,
  ) {
    super(`spec is ${bytes} bytes, above the ${limitBytes} byte limit; send fewer rows or shorter text`);
  }
}

export function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !GUID.test(value)) {
    throw new DashboardError(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

export function slugOf(value: unknown): string {
  if (typeof value !== "string" || !SLUG.test(value)) {
    throw new DashboardError("slug must be lowercase letters, digits and hyphens (1-64 characters)");
  }
  return value;
}

/**
 * Paperclip owns one worker process per installed plugin. Serializing company
 * mutations keeps the read-modify-write revision bump race-free.
 */
export function companySerialQueue() {
  const pending = new Map<string, Promise<unknown>>();
  return async <T>(companyId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = pending.get(companyId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    pending.set(companyId, result);
    try {
      return await result;
    } finally {
      if (pending.get(companyId) === result) {
        pending.delete(companyId);
      }
    }
  };
}

function table(ctx: PluginContext, key: "dashboards" | "dashboard_revisions"): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) {
    throw new Error("Invalid plugin database namespace");
  }
  return `${ctx.db.namespace}.${key}`;
}

function iso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

export async function getSettings(ctx: PluginContext, companyId: string): Promise<DashboardSettings> {
  return normalizeSettings(await ctx.config.get(companyId));
}

interface DashboardRow {
  id: string;
  company_id: string;
  project_id: string | null;
  project_name?: string | null;
  slug: string;
  title: string;
  spec?: unknown;
  revision: number;
  updated_by_kind: Actor["kind"];
  updated_by_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const COLUMNS = `d.id, d.company_id, d.project_id, p.name AS project_name, d.slug, d.title, d.revision,
  d.updated_by_kind, d.updated_by_id, d.created_at, d.updated_at`;
const FROM = (ctx: PluginContext) =>
  `${table(ctx, "dashboards")} d LEFT JOIN public.projects p ON p.id = d.project_id`;

async function agentNames(ctx: PluginContext, companyId: string, rows: DashboardRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.filter((r) => r.updated_by_kind === "agent" && r.updated_by_id).map((r) => String(r.updated_by_id)))];
  const names = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const agent = GUID.test(id) ? await ctx.agents.get(id, companyId) : null;
        if (agent) {
          names.set(id, agent.name);
        }
      } catch {
        // A missing name must never break listing.
      }
    }),
  );
  return names;
}

function summarize(row: DashboardRow, names: Map<string, string>): DashboardSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    revision: Number(row.revision),
    updatedAt: iso(row.updated_at),
    updatedBy: {
      kind: row.updated_by_kind,
      id: row.updated_by_id,
      name: row.updated_by_id ? (names.get(row.updated_by_id) ?? null) : null,
    },
  };
}

function parseStoredSpec(raw: unknown): { spec: DashboardSpec | null; errors: string[] } {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { spec: null, errors: ["stored spec is not valid JSON"] };
    }
  }
  const result = validateSpec(value);
  return result.ok ? { spec: result.spec, errors: [] } : { spec: null, errors: result.errors };
}

export async function listDashboards(
  ctx: PluginContext,
  params: { companyId?: unknown; projectId?: unknown },
): Promise<DashboardSummary[]> {
  const companyId = uuid(params.companyId, "companyId");
  const args: unknown[] = [companyId];
  let filter = "";
  if (params.projectId !== undefined && params.projectId !== null) {
    args.push(uuid(params.projectId, "projectId"));
    filter = " AND d.project_id = $2";
  }
  const rows = await ctx.db.query<DashboardRow>(
    `SELECT ${COLUMNS} FROM ${FROM(ctx)} WHERE d.company_id = $1${filter} ORDER BY lower(p.name) NULLS FIRST, lower(d.title), d.id`,
    args,
  );
  const names = await agentNames(ctx, companyId, rows);
  return rows.map((row) => summarize(row, names));
}

export async function getDashboard(
  ctx: PluginContext,
  params: { companyId?: unknown; id?: unknown; slug?: unknown },
): Promise<DashboardRecord | null> {
  const companyId = uuid(params.companyId, "companyId");
  const byId = params.id !== undefined && params.id !== null;
  if (!byId && (params.slug === undefined || params.slug === null)) {
    throw new DashboardError("id or slug is required");
  }
  const key = byId ? uuid(params.id, "id") : slugOf(params.slug);
  const rows = await ctx.db.query<DashboardRow>(
    `SELECT ${COLUMNS}, d.spec FROM ${FROM(ctx)} WHERE d.company_id = $1 AND ${byId ? "d.id" : "d.slug"} = $2`,
    [companyId, key],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  const names = await agentNames(ctx, companyId, [row]);
  const { spec, errors } = parseStoredSpec(row.spec);
  return {
    ...summarize(row, names),
    companyId,
    createdAt: iso(row.created_at),
    spec,
    specErrors: errors,
  };
}

export async function listRevisions(
  ctx: PluginContext,
  params: { companyId?: unknown; id?: unknown },
): Promise<RevisionSummary[]> {
  const companyId = uuid(params.companyId, "companyId");
  const id = uuid(params.id, "id");
  const rows = await ctx.db.query<{
    revision: number;
    created_at: unknown;
    updated_by_kind: Actor["kind"];
    updated_by_id: string | null;
  }>(
    `SELECT r.revision, r.created_at, r.updated_by_kind, r.updated_by_id
       FROM ${table(ctx, "dashboard_revisions")} r
       JOIN ${table(ctx, "dashboards")} d ON d.id = r.dashboard_id
      WHERE d.company_id = $1 AND d.id = $2
      ORDER BY r.revision DESC`,
    [companyId, id],
  );
  return rows.map((row) => ({
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedBy: { kind: row.updated_by_kind, id: row.updated_by_id },
  }));
}

function checkSize(spec: DashboardSpec, settings: DashboardSettings): void {
  const bytes = Buffer.byteLength(JSON.stringify(spec), "utf8");
  if (bytes > settings.maxSpecBytes) {
    throw new SpecTooLargeError(bytes, settings.maxSpecBytes);
  }
}

function parseSpecOrThrow(input: unknown, settings: DashboardSettings): DashboardSpec {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      throw new InvalidSpecError(["spec: must be a JSON object, but the string is not valid JSON"]);
    }
  }
  const result = validateSpec(value);
  if (!result.ok) {
    throw new InvalidSpecError(result.errors);
  }
  checkSize(result.spec, settings);
  return result.spec;
}

export function validateDashboardSpec(input: unknown, settings: DashboardSettings): DashboardSpec {
  return parseSpecOrThrow(input, settings);
}

async function requireProject(ctx: PluginContext, companyId: string, projectId: string): Promise<void> {
  if (!(await ctx.projects.get(projectId, companyId))) {
    throw new DashboardError("Project not found in this company");
  }
}

async function writeRevision(
  ctx: PluginContext,
  dashboardId: string,
  revision: number,
  spec: DashboardSpec,
  actor: Actor,
  settings: DashboardSettings,
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "dashboard_revisions")} (dashboard_id, revision, spec, updated_by_kind, updated_by_id)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (dashboard_id, revision) DO UPDATE SET spec = EXCLUDED.spec,
       updated_by_kind = EXCLUDED.updated_by_kind, updated_by_id = EXCLUDED.updated_by_id`,
    [dashboardId, revision, JSON.stringify(spec), actor.kind, actor.id],
  );
  await ctx.db.execute(
    `DELETE FROM ${table(ctx, "dashboard_revisions")} WHERE dashboard_id = $1 AND revision <= $2`,
    [dashboardId, revision - settings.maxRevisions],
  );
}

export interface UpsertInput {
  companyId: string;
  slug: string;
  title?: string;
  /** undefined keeps the current project (or none for a new dashboard); null is company-level. */
  projectId?: string | null;
  spec: unknown;
  actor: Actor;
  settings: DashboardSettings;
  /** Overrides the activity log message (used by restore). */
  activityMessage?: string;
}

export async function upsertDashboard(
  ctx: PluginContext,
  input: UpsertInput,
): Promise<{ record: DashboardRecord; created: boolean }> {
  const { companyId, actor, settings } = input;
  const slug = slugOf(input.slug);
  const spec = parseSpecOrThrow(input.spec, settings);
  const title = (input.title ?? spec.title).trim();
  if (title.length < 1 || title.length > 200) {
    throw new DashboardError("title must contain 1 to 200 characters");
  }
  if (typeof input.projectId === "string") {
    await requireProject(ctx, companyId, uuid(input.projectId, "projectId"));
  }
  const existing = await ctx.db.query<{ id: string; revision: number; project_id: string | null }>(
    `SELECT id, revision, project_id FROM ${table(ctx, "dashboards")} WHERE company_id = $1 AND slug = $2`,
    [companyId, slug],
  );
  const current = existing[0];
  let id: string;
  let revision: number;
  if (current) {
    id = current.id;
    revision = Number(current.revision) + 1;
    const projectId = input.projectId === undefined ? current.project_id : input.projectId;
    await ctx.db.execute(
      `UPDATE ${table(ctx, "dashboards")}
          SET title = $3, spec = $4::jsonb, revision = $5, project_id = $6,
              updated_by_kind = $7, updated_by_id = $8, updated_at = now()
        WHERE company_id = $1 AND id = $2`,
      [companyId, id, title, JSON.stringify(spec), revision, projectId, actor.kind, actor.id],
    );
  } else {
    id = randomUUID();
    revision = 1;
    await ctx.db.execute(
      `INSERT INTO ${table(ctx, "dashboards")}
         (id, company_id, project_id, slug, title, spec, revision, updated_by_kind, updated_by_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, $7, $8)`,
      [id, companyId, input.projectId ?? null, slug, title, JSON.stringify(spec), actor.kind, actor.id],
    );
  }
  await writeRevision(ctx, id, revision, spec, actor, settings);
  await ctx.activity.log({
    companyId,
    message: input.activityMessage ?? `${current ? "Updated" : "Created"} dashboard "${title}" (revision ${revision})`,
    entityType: "plugin_dashboard",
    entityId: id,
    metadata: { slug, revision, actor: actor.kind },
  });
  const record = await getDashboard(ctx, { companyId, id });
  if (!record) {
    throw new Error("Dashboard disappeared after write");
  }
  return { record, created: !current };
}

export interface UpdateDatasetInput {
  companyId: string;
  slug: string;
  datasetId: string;
  rows: unknown;
  columns?: unknown;
  description?: unknown;
  source?: unknown;
  updatedAt?: unknown;
  actor: Actor;
  settings: DashboardSettings;
}

export async function updateDataset(
  ctx: PluginContext,
  input: UpdateDatasetInput,
): Promise<{ record: DashboardRecord; created: boolean }> {
  const slug = slugOf(input.slug);
  const record = await getDashboard(ctx, { companyId: input.companyId, slug });
  if (!record) {
    throw new NotFoundError(`Dashboard "${slug}" not found`);
  }
  if (!record.spec) {
    throw new DashboardError(`Dashboard "${slug}" has a stored spec that no longer validates; resend it with upsert_dashboard`);
  }
  const existing = record.spec.datasets[input.datasetId];
  if (!existing) {
    throw new NotFoundError(
      `datasetId: unknown dataset "${input.datasetId}" (declared: ${Object.keys(record.spec.datasets).join(", ") || "none"})`,
    );
  }
  const next: Record<string, unknown> = { ...existing, rows: input.rows, updatedAt: new Date().toISOString() };
  for (const key of ["columns", "description", "source", "updatedAt"] as const) {
    if (input[key] !== undefined) {
      next[key] = input[key];
    }
  }
  const datasets: Record<string, Dataset | Record<string, unknown>> = { ...record.spec.datasets, [input.datasetId]: next };
  return upsertDashboard(ctx, {
    companyId: input.companyId,
    slug,
    spec: { ...record.spec, datasets },
    actor: input.actor,
    settings: input.settings,
  });
}

export async function deleteDashboard(
  ctx: PluginContext,
  params: { companyId: string; id: unknown },
): Promise<{ ok: true }> {
  const id = uuid(params.id, "id");
  const record = await getDashboard(ctx, { companyId: params.companyId, id });
  if (!record) {
    throw new NotFoundError("Dashboard not found");
  }
  await ctx.db.execute(`DELETE FROM ${table(ctx, "dashboards")} WHERE company_id = $1 AND id = $2`, [
    params.companyId,
    id,
  ]);
  await ctx.activity.log({
    companyId: params.companyId,
    message: `Deleted dashboard "${record.title}"`,
    entityType: "plugin_dashboard",
    entityId: id,
    metadata: { slug: record.slug },
  });
  return { ok: true };
}

export async function restoreRevision(
  ctx: PluginContext,
  params: { companyId: string; id: unknown; revision: unknown; actor: Actor; settings: DashboardSettings },
): Promise<DashboardRecord> {
  const id = uuid(params.id, "id");
  const revision = params.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    throw new DashboardError("revision must be a positive integer");
  }
  const record = await getDashboard(ctx, { companyId: params.companyId, id });
  if (!record) {
    throw new NotFoundError("Dashboard not found");
  }
  const rows = await ctx.db.query<{ spec: unknown }>(
    `SELECT spec FROM ${table(ctx, "dashboard_revisions")} WHERE dashboard_id = $1 AND revision = $2`,
    [id, revision],
  );
  if (!rows[0]) {
    throw new NotFoundError(`Revision ${revision} is not available (it may have been pruned)`);
  }
  const stored = parseStoredSpec(rows[0].spec);
  if (!stored.spec) {
    throw new DashboardError(`Revision ${revision} no longer validates:\n${stored.errors.join("\n")}`);
  }
  const { record: restored } = await upsertDashboard(ctx, {
    companyId: params.companyId,
    slug: record.slug,
    spec: stored.spec,
    actor: params.actor,
    settings: params.settings,
    activityMessage: `Restored dashboard "${record.title}" from revision ${revision}`,
  });
  return restored;
}
