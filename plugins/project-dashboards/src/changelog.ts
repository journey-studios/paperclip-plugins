import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  isChangelogKind,
  LIMITS,
  parseInstant,
  type EntryFields,
  type EntryPatch,
} from "./changelog-input.js";
import type { Actor, ChangelogEntry, ChangelogKind, ChangelogLink, ChangelogPage } from "./contracts.js";
import { DashboardError, NotFoundError } from "./errors.js";
import { isRecord } from "./keys.js";
import { GUID, agentNames, iso, requireProject, table, uuid } from "./store-util.js";

/** Rows per INSERT statement; at 13 parameters each this stays far below the driver limit. */
const INSERT_BATCH = 100;

interface EntryRow {
  id: string;
  project_id: string;
  project_name: string | null;
  kind: string;
  title: string;
  body: string | null;
  version: string | null;
  refs: unknown;
  links: unknown;
  occurred_at: unknown;
  issue_id: string | null;
  milestone_id: string | null;
  created_by_kind: Actor["kind"];
  created_by_id: string | null;
  updated_by_kind: Actor["kind"];
  updated_by_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const COLUMNS = `e.id, e.project_id, p.name AS project_name, e.kind, e.title, e.body, e.version, e.refs, e.links,
  e.occurred_at, e.issue_id, e.milestone_id, e.created_by_kind, e.created_by_id, e.updated_by_kind, e.updated_by_id,
  e.created_at, e.updated_at`;
const FROM = (ctx: PluginContext) =>
  `${table(ctx, "changelog_entries")} e LEFT JOIN public.projects p ON p.id = e.project_id`;

function jsonArray(raw: unknown): unknown[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function storedRefs(raw: unknown): string[] {
  return jsonArray(raw).filter((item): item is string => typeof item === "string");
}

function storedLinks(raw: unknown): ChangelogLink[] {
  return jsonArray(raw).flatMap((item) =>
    isRecord(item) && typeof item.label === "string" && typeof item.url === "string"
      ? [{ label: item.label, url: item.url }]
      : [],
  );
}

function actorOf(kind: Actor["kind"], id: string | null, names: Map<string, string>): Actor {
  return { kind, id, name: id ? (names.get(id) ?? null) : null };
}

function toEntry(row: EntryRow, names: Map<string, string>): ChangelogEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    kind: isChangelogKind(row.kind) ? row.kind : "note",
    title: row.title,
    body: row.body ?? null,
    version: row.version ?? null,
    refs: storedRefs(row.refs),
    links: storedLinks(row.links),
    occurredAt: iso(row.occurred_at),
    issueId: row.issue_id ?? null,
    milestoneId: row.milestone_id ?? null,
    createdBy: actorOf(row.created_by_kind, row.created_by_id, names),
    updatedBy: actorOf(row.updated_by_kind, row.updated_by_id, names),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function toEntries(ctx: PluginContext, companyId: string, rows: EntryRow[]): Promise<ChangelogEntry[]> {
  const actors = rows.flatMap((row) => [
    { kind: row.created_by_kind, id: row.created_by_id },
    { kind: row.updated_by_kind, id: row.updated_by_id },
  ]);
  const names = await agentNames(ctx, companyId, actors);
  return rows.map((row) => toEntry(row, names));
}

/* ---------------------------------------------------------------- listing */

interface Cursor {
  occurredAt: string;
  id: string;
}

export function encodeCursor(entry: Cursor): string {
  return Buffer.from(JSON.stringify([entry.occurredAt, entry.id]), "utf8").toString("base64url");
}

function decodeCursor(value: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2) {
      const occurredAt = parseInstant(parsed[0]);
      const id = typeof parsed[1] === "string" && GUID.test(parsed[1]) ? parsed[1].toLowerCase() : null;
      if (occurredAt && id) {
        return { occurredAt, id };
      }
    }
  } catch {
    // Fall through to the user-facing error.
  }
  throw new DashboardError("before: not a valid cursor; pass the nextCursor of a previous response");
}

export interface ListQuery {
  projectId?: string;
  kinds: ChangelogKind[];
  includeIssues: boolean;
  before?: Cursor;
  limit: number;
}

function kindList(value: unknown): ChangelogKind[] {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  const items = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(items) || items.length > LIMITS.kinds) {
    throw new DashboardError("kinds: must be a list of changelog kinds");
  }
  const kinds: ChangelogKind[] = [];
  for (const item of items) {
    const kind = typeof item === "string" ? item.trim() : item;
    if (!isChangelogKind(kind)) {
      throw new DashboardError(`kinds: unknown kind ${JSON.stringify(item)}`);
    }
    if (!kinds.includes(kind)) {
      kinds.push(kind);
    }
  }
  return kinds;
}

function flag(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  throw new DashboardError(`${label} must be true or false`);
}

function pageSize(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return LIMITS.pageDefault;
  }
  const size = typeof value === "string" && /^\d{1,4}$/.test(value) ? parseInt(value, 10) : value;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > LIMITS.pageMax) {
    throw new DashboardError(`limit must be an integer from 1 to ${LIMITS.pageMax}`);
  }
  return size;
}

/** One reader for tool, REST and UI parameters: native types and their query-string spellings are both accepted. */
export function parseListQuery(params: Record<string, unknown>): ListQuery {
  const { projectId, before } = params;
  if (before !== undefined && before !== null && before !== "" && (typeof before !== "string" || before.length > LIMITS.cursor)) {
    throw new DashboardError("before: not a valid cursor; pass the nextCursor of a previous response");
  }
  return {
    projectId: projectId === undefined || projectId === null || projectId === "" ? undefined : uuid(projectId, "projectId"),
    kinds: kindList(params.kinds),
    includeIssues: flag(params.includeIssues, "includeIssues", true),
    before: typeof before === "string" && before !== "" ? decodeCursor(before) : undefined,
    limit: pageSize(params.limit),
  };
}

export async function listChangelog(ctx: PluginContext, companyId: string, params: Record<string, unknown>): Promise<ChangelogPage> {
  const query = parseListQuery(params);
  const args: unknown[] = [companyId];
  const bind = (value: unknown) => {
    args.push(value);
    return `$${args.length}`;
  };
  const where = ["e.company_id = $1", "e.deleted_at IS NULL"];
  if (query.projectId) {
    where.push(`e.project_id = ${bind(query.projectId)}::uuid`);
  }
  if (query.kinds.length > 0) {
    where.push(`e.kind IN (${query.kinds.map((kind) => bind(kind)).join(", ")})`);
  }
  if (!query.includeIssues) {
    where.push("e.kind <> 'issue'");
  }
  if (query.before) {
    where.push(`(e.occurred_at, e.id) < (${bind(query.before.occurredAt)}::timestamptz, ${bind(query.before.id)}::uuid)`);
  }
  // One extra row tells whether another page exists without a second count query.
  const rows = await ctx.db.query<EntryRow>(
    `SELECT ${COLUMNS} FROM ${FROM(ctx)} WHERE ${where.join(" AND ")} ORDER BY e.occurred_at DESC, e.id DESC LIMIT ${query.limit + 1}`,
    args,
  );
  const entries = await toEntries(ctx, companyId, rows.slice(0, query.limit));
  const last = entries.at(-1);
  return { entries, nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null };
}

export async function getEntry(ctx: PluginContext, companyId: string, entryId: string): Promise<ChangelogEntry | null> {
  const rows = await ctx.db.query<EntryRow>(
    `SELECT ${COLUMNS} FROM ${FROM(ctx)} WHERE e.company_id = $1 AND e.id = $2 AND e.deleted_at IS NULL`,
    [companyId, entryId],
  );
  return (await toEntries(ctx, companyId, rows))[0] ?? null;
}

/* ----------------------------------------------------------------- writes */

export interface NewRow {
  id: string;
  companyId: string;
  projectId: string;
  kind: ChangelogKind;
  title: string;
  body: string | null;
  version: string | null;
  refs: string[];
  links: ChangelogLink[];
  occurredAt: string;
  issueId: string | null;
  actor: Actor;
}

const ROW_PARAMS = 13;
const valuesTuple = (offset: number) => {
  const p = (n: number) => `$${offset + n}`;
  // created_by and updated_by start out identical, so they share two parameters.
  return `(${p(1)}::uuid, ${p(2)}::uuid, ${p(3)}::uuid, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}::jsonb, ${p(9)}::jsonb, ${p(10)}::timestamptz, ${p(11)}::uuid, ${p(12)}, ${p(13)}, ${p(12)}, ${p(13)})`;
};

/**
 * Insert rows in batches. A row for an issue that already has one (live or deleted) is
 * skipped by the unique index, so replays and imports never duplicate or resurrect.
 * Returns how many rows were actually inserted.
 */
export async function insertEntries(ctx: PluginContext, rows: NewRow[]): Promise<number> {
  let inserted = 0;
  for (let start = 0; start < rows.length; start += INSERT_BATCH) {
    const batch = rows.slice(start, start + INSERT_BATCH);
    const args = batch.flatMap((item) => [
      item.id,
      item.companyId,
      item.projectId,
      item.kind,
      item.title,
      item.body,
      item.version,
      JSON.stringify(item.refs),
      JSON.stringify(item.links),
      item.occurredAt,
      item.issueId,
      item.actor.kind,
      item.actor.id,
    ]);
    const result = await ctx.db.execute(
      `INSERT INTO ${table(ctx, "changelog_entries")}
         (id, company_id, project_id, kind, title, body, version, refs, links, occurred_at, issue_id,
          created_by_kind, created_by_id, updated_by_kind, updated_by_id)
       VALUES ${batch.map((_, index) => valuesTuple(index * ROW_PARAMS)).join(", ")}
       ON CONFLICT (company_id, issue_id) WHERE issue_id IS NOT NULL DO NOTHING`,
      args,
    );
    inserted += result.rowCount;
  }
  return inserted;
}

export interface AddEntryInput {
  companyId: string;
  projectId: string;
  fields: EntryFields;
  actor: Actor;
}

export async function addEntry(ctx: PluginContext, input: AddEntryInput): Promise<ChangelogEntry> {
  const { companyId, fields, actor } = input;
  const projectId = uuid(input.projectId, "projectId");
  const project = await requireProject(ctx, companyId, projectId);
  const id = randomUUID();
  await insertEntries(ctx, [{ ...fields, id, companyId, projectId, issueId: null, actor }]);
  const entry = await getEntry(ctx, companyId, id);
  if (!entry) {
    throw new Error("Changelog entry was not stored; retry");
  }
  await ctx.activity.log({
    companyId,
    message: `Added ${fields.kind} changelog entry "${fields.title}" to project "${project.name}"`,
    entityType: "plugin_changelog_entry",
    entityId: id,
    metadata: { projectId, kind: fields.kind, actor: actor.kind },
  });
  return entry;
}

async function requireEntry(ctx: PluginContext, companyId: string, entryId: string): Promise<ChangelogEntry> {
  const entry = await getEntry(ctx, companyId, entryId);
  if (!entry) {
    throw new NotFoundError("Changelog entry not found");
  }
  return entry;
}

export interface UpdateEntryInput {
  companyId: string;
  entryId: unknown;
  patch: EntryPatch;
  actor: Actor;
}

export async function updateEntry(ctx: PluginContext, input: UpdateEntryInput): Promise<ChangelogEntry> {
  const { companyId, patch, actor } = input;
  const current = await requireEntry(ctx, companyId, uuid(input.entryId, "entryId"));
  if (current.kind === "issue") {
    throw new DashboardError("Entries generated from completed issues mirror the issue and cannot be edited; edit the issue instead");
  }
  if (current.milestoneId) throw new DashboardError("Milestone history is immutable; edit its originating milestone");
  const next = {
    kind: patch.kind ?? current.kind,
    title: patch.title ?? current.title,
    body: patch.body === undefined ? current.body : patch.body,
    version: patch.version === undefined ? current.version : patch.version,
    refs: patch.refs ?? current.refs,
    links: patch.links ?? current.links,
    occurredAt: patch.occurredAt ?? current.occurredAt,
  };
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "changelog_entries")}
        SET kind = $3, title = $4, body = $5, version = $6, refs = $7::jsonb, links = $8::jsonb,
            occurred_at = $9::timestamptz, updated_by_kind = $10, updated_by_id = $11, updated_at = now()
      WHERE company_id = $1 AND id = $2 AND deleted_at IS NULL AND kind <> 'issue' AND milestone_id IS NULL`,
    [
      companyId,
      current.id,
      next.kind,
      next.title,
      next.body,
      next.version,
      JSON.stringify(next.refs),
      JSON.stringify(next.links),
      next.occurredAt,
      actor.kind,
      actor.id,
    ],
  );
  if (result.rowCount === 0) {
    throw new NotFoundError("Changelog entry not found");
  }
  const entry = await getEntry(ctx, companyId, current.id);
  if (!entry) {
    throw new NotFoundError("Changelog entry not found");
  }
  await ctx.activity.log({
    companyId,
    message: `Updated changelog entry "${entry.title}"`,
    entityType: "plugin_changelog_entry",
    entityId: entry.id,
    metadata: { projectId: entry.projectId, kind: entry.kind, actor: actor.kind },
  });
  return entry;
}

/**
 * Soft delete (board only). The row stays so the unique issue index keeps blocking a
 * later import from bringing an automatic entry back.
 */
export async function deleteEntry(
  ctx: PluginContext,
  params: { companyId: string; entryId: unknown; actor: Actor },
): Promise<{ ok: true }> {
  const { companyId, actor } = params;
  const current = await requireEntry(ctx, companyId, uuid(params.entryId, "id"));
  if (current.milestoneId) throw new DashboardError("Milestone history is immutable");
  await ctx.db.execute(
    `UPDATE ${table(ctx, "changelog_entries")}
        SET deleted_at = now(), updated_by_kind = $3, updated_by_id = $4, updated_at = now()
      WHERE company_id = $1 AND id = $2 AND deleted_at IS NULL AND milestone_id IS NULL`,
    [companyId, current.id, actor.kind, actor.id],
  );
  await ctx.activity.log({
    companyId,
    message: `Deleted changelog entry "${current.title}"`,
    entityType: "plugin_changelog_entry",
    entityId: current.id,
    metadata: { projectId: current.projectId, kind: current.kind, actor: actor.kind },
  });
  return { ok: true };
}
