import { randomUUID } from "node:crypto";
import type { PluginContext, Project } from "@paperclipai/plugin-sdk";
import type {
  Actor,
  DashboardRecord,
  DashboardSettings,
  DashboardSpec,
  DashboardSummary,
  Dataset,
  RevisionSummary,
} from "./contracts.js";
import { DashboardError, NotFoundError } from "./errors.js";
import { getOwn } from "./keys.js";
import { projectUrlKeys } from "./project-lookup.js";
import { validateSpec } from "./spec.js";
import { agentNames, iso, table, uuid } from "./store-util.js";

const SLUG = /^[a-z0-9-]{1,64}$/;

/** Every dashboard belongs to a project; these codes are part of the REST contract. */
export class ProjectError extends DashboardError {
  constructor(
    readonly code: "project_required" | "project_not_found" | "project_archived",
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

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

export function slugOf(value: unknown): string {
  if (typeof value !== "string" || !SLUG.test(value)) {
    throw new DashboardError("slug must be lowercase letters, digits and hyphens (1-64 characters)");
  }
  return value;
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

const updaters = (rows: DashboardRow[]) => rows.map((row) => ({ kind: row.updated_by_kind, id: row.updated_by_id }));

function summarize(row: DashboardRow, names: Map<string, string>, urlKeys: Map<string, string | null>): DashboardSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    projectUrlKey: row.project_id ? (urlKeys.get(row.project_id) ?? null) : null,
    orphan: row.project_id === null,
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
  const [names, urlKeys] = await Promise.all([
    agentNames(ctx, companyId, updaters(rows)),
    projectUrlKeys(ctx, companyId, rows.map((row) => row.project_id)),
  ]);
  return rows.map((row) => summarize(row, names, urlKeys));
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
  const [names, urlKeys] = await Promise.all([
    agentNames(ctx, companyId, updaters([row])),
    projectUrlKeys(ctx, companyId, [row.project_id]),
  ]);
  const { spec, errors } = parseStoredSpec(row.spec);
  return {
    ...summarize(row, names, urlKeys),
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

/**
 * A project a dashboard may be assigned to: it must exist in the company and
 * must not be archived.
 */
export async function requireAssignableProject(ctx: PluginContext, companyId: string, projectId: string): Promise<Project> {
  const project = await ctx.projects.get(projectId, companyId);
  if (!project) {
    throw new ProjectError("project_not_found", `project ${projectId} does not exist in this company`);
  }
  if (project.archivedAt) {
    throw new ProjectError("project_archived", `project "${project.name}" is archived; choose an active project`);
  }
  return project;
}

export interface UpsertInput {
  companyId: string;
  slug: string;
  title?: string;
  /** Required for a new dashboard; undefined keeps an existing dashboard's project (or lack of one). */
  projectId?: string;
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
  const existing = await ctx.db.query<{ id: string; revision: number; project_id: string | null }>(
    `SELECT id, revision, project_id FROM ${table(ctx, "dashboards")} WHERE company_id = $1 AND slug = $2`,
    [companyId, slug],
  );
  const current = existing[0];
  const requested = input.projectId === undefined ? undefined : uuid(input.projectId, "projectId");
  if (!current && requested === undefined) {
    throw new ProjectError("project_required", "a new dashboard needs projectId (a project UUID of this company)");
  }
  // Keeping the current project never re-checks it, so archiving a project does not block updates.
  if (requested !== undefined && requested !== current?.project_id) {
    await requireAssignableProject(ctx, companyId, requested);
  }
  let id: string;
  let revision: number;
  // The dashboard row, its revision row and the prune are ONE statement (a
  // data-modifying CTE): the host offers no transactions, and this way a
  // failure in any step leaves the previous state untouched.
  if (current) {
    id = current.id;
    revision = Number(current.revision) + 1;
    const projectId = requested ?? current.project_id;
    await ctx.db.execute(
      `WITH upd AS (
         UPDATE ${table(ctx, "dashboards")}
            SET title = $3, spec = $4::jsonb, revision = $5, project_id = $6,
                updated_by_kind = $7, updated_by_id = $8, updated_at = now()
          WHERE company_id = $1 AND id = $2 AND revision = $9
          RETURNING id, revision, spec, updated_by_kind, updated_by_id
       ), ins AS (
         INSERT INTO ${table(ctx, "dashboard_revisions")} (dashboard_id, revision, spec, updated_by_kind, updated_by_id)
         SELECT id, revision, spec, updated_by_kind, updated_by_id FROM upd
         ON CONFLICT (dashboard_id, revision) DO UPDATE SET spec = EXCLUDED.spec,
           updated_by_kind = EXCLUDED.updated_by_kind, updated_by_id = EXCLUDED.updated_by_id
         RETURNING dashboard_id
       )
       DELETE FROM ${table(ctx, "dashboard_revisions")}
        WHERE dashboard_id IN (SELECT id FROM upd) AND revision <= $10`,
      [
        companyId,
        id,
        title,
        JSON.stringify(spec),
        revision,
        projectId,
        actor.kind,
        actor.id,
        Number(current.revision),
        revision - settings.maxRevisions,
      ],
    );
  } else {
    id = randomUUID();
    revision = 1;
    await ctx.db.execute(
      `WITH ins AS (
         INSERT INTO ${table(ctx, "dashboards")}
           (id, company_id, project_id, slug, title, spec, revision, updated_by_kind, updated_by_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, $7, $8)
         RETURNING id, revision, spec, updated_by_kind, updated_by_id
       )
       INSERT INTO ${table(ctx, "dashboard_revisions")} (dashboard_id, revision, spec, updated_by_kind, updated_by_id)
       SELECT id, revision, spec, updated_by_kind, updated_by_id FROM ins`,
      [id, companyId, requested ?? null, slug, title, JSON.stringify(spec), actor.kind, actor.id],
    );
  }
  const record = await getDashboard(ctx, { companyId, id });
  if (!record || record.revision !== revision) {
    // The revision guard matched no row: another writer got there first.
    throw new Error("Dashboard changed during write; retry");
  }
  await ctx.activity.log({
    companyId,
    message: input.activityMessage ?? `${current ? "Updated" : "Created"} dashboard "${title}" (revision ${revision})`,
    entityType: "plugin_dashboard",
    entityId: id,
    metadata: { slug, revision, actor: actor.kind },
  });
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
  const existing = getOwn(record.spec.datasets, input.datasetId);
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

/**
 * Move a dashboard (orphans included) to another project of the company. The
 * spec is unchanged but the move is written as a new revision so it shows in
 * the history.
 */
export async function setDashboardProject(
  ctx: PluginContext,
  params: { companyId: string; id: unknown; projectId: unknown; actor: Actor; settings: DashboardSettings },
): Promise<DashboardRecord> {
  const id = uuid(params.id, "id");
  if (typeof params.projectId !== "string") {
    throw new ProjectError("project_required", "projectId must be a project UUID of this company");
  }
  const projectId = uuid(params.projectId, "projectId");
  const record = await getDashboard(ctx, { companyId: params.companyId, id });
  if (!record) {
    throw new NotFoundError("Dashboard not found");
  }
  if (record.projectId === projectId) {
    return record;
  }
  if (!record.spec) {
    throw new DashboardError(`Dashboard "${record.slug}" has a stored spec that no longer validates; resend it with upsert_dashboard`);
  }
  const project = await requireAssignableProject(ctx, params.companyId, projectId);
  const { record: moved } = await upsertDashboard(ctx, {
    companyId: params.companyId,
    slug: record.slug,
    title: record.title,
    projectId,
    spec: record.spec,
    actor: params.actor,
    settings: params.settings,
    activityMessage: `Moved dashboard "${record.title}" to project "${project.name}"`,
  });
  return moved;
}
