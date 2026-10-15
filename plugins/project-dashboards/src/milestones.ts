import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  Actor, MilestoneCriterion, MilestoneEvidence, MilestoneIssue, MilestoneRecord, MilestoneStatus,
} from "./contracts.js";
import { DashboardError, NotFoundError } from "./errors.js";
import type { MilestoneFields, MilestonePatch } from "./milestones-input.js";
import { agentNames, iso, isoOrNull, requireProject, uuid } from "./store-util.js";

interface StoredMilestone {
  id: string; company_id: string; project_id: string; project_name: string | null;
  title: string; description: string | null; status: MilestoneStatus;
  target_date: unknown; criteria: unknown; issue_ids: unknown; evidence: unknown;
  completed_at: unknown; revision: number; created_at: unknown; updated_at: unknown;
  created_by_kind: Actor["kind"]; created_by_id: string | null;
  updated_by_kind: Actor["kind"]; updated_by_id: string | null;
}

const MAX_LIST = 150;
const cols = `m.id, m.company_id, m.project_id, p.name AS project_name, m.title, m.description,
  m.status, m.target_date, m.criteria, m.issue_ids, m.evidence, m.completed_at, m.revision,
  m.created_at, m.updated_at, m.created_by_kind, m.created_by_id, m.updated_by_kind, m.updated_by_id`;
const source = (ctx: PluginContext) => `${milestoneTable(ctx)} m LEFT JOIN public.projects p ON p.id = m.project_id`;

function milestoneTable(ctx: PluginContext): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new Error("Invalid plugin database namespace");
  return `${ctx.db.namespace}.milestones`;
}
function changelogTable(ctx: PluginContext): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new Error("Invalid plugin database namespace");
  return `${ctx.db.namespace}.changelog_entries`;
}
function arrayOf<T>(raw: unknown): T[] {
  const value: unknown = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : raw;
  return Array.isArray(value) ? value as T[] : [];
}

const completed = (status: string) => status === "done";

async function issueSnapshot(
  ctx: PluginContext, companyId: string, projectId: string, ids: string[],
): Promise<{ issues: MilestoneIssue[]; notFound: string[] }> {
  const records = await Promise.all(ids.map(async (id) => {
    const found = await ctx.issues.get(id, companyId);
    if (!found || found.projectId !== projectId) return null;
    return { id, identifier: found.identifier ?? found.id, title: found.title, status: found.status } as MilestoneIssue;
  }));
  return {
    issues: records.filter((record): record is MilestoneIssue => record !== null),
    notFound: ids.filter((_id, index) => records[index] === null),
  };
}

async function hydrate(ctx: PluginContext, companyId: string, rows: StoredMilestone[]): Promise<MilestoneRecord[]> {
  const actors = rows.flatMap((row) => [
    { kind: row.created_by_kind, id: row.created_by_id },
    { kind: row.updated_by_kind, id: row.updated_by_id },
  ]);
  const names = await agentNames(ctx, companyId, actors);
  const issueCache = new Map<string, Promise<MilestoneIssue | null>>();
  const getIssue = (id: string, projectId: string) => {
    const key = `${projectId}:${id}`;
    if (!issueCache.has(key)) {
      issueCache.set(key, ctx.issues.get(id, companyId).then((item) =>
        item && item.projectId === projectId
          ? { id, identifier: item.identifier ?? item.id, title: item.title, status: item.status }
          : null,
      ));
    }
    return issueCache.get(key)!;
  };
  return Promise.all(rows.map(async (row) => {
    const criteria = arrayOf<MilestoneCriterion>(row.criteria);
    const evidence = arrayOf<MilestoneEvidence>(row.evidence);
    const issueIds = arrayOf<string>(row.issue_ids);
    const records = await Promise.all(issueIds.map((id) => getIssue(id, row.project_id)));
    const issues = records.filter((issue): issue is MilestoneIssue => issue !== null);
    const missing = issueIds.filter((_, i) => !records[i]);
    const doneIssues = issues.filter((issue) => completed(issue.status)).length;
    const verifiedCriteria = criteria.filter((criterion) => criterion.checked).length;
    const blockers = [
      ...missing.map((id) => `Issue ${id} no longer belongs to this project or is inaccessible`),
      ...issues.filter((issue) => !completed(issue.status)).map((issue) => `Issue ${issue.identifier} is ${issue.status}, not done`),
      ...criteria.filter((criterion) => !criterion.checked).map((criterion) => `Criterion pending: ${criterion.text}`),
      ...(evidence.length === 0 ? ["At least one verifiable evidence URL is required"] : []),
    ];
    const total = issueIds.length + criteria.length;
    const progress = total === 0 ? 0 : Math.round((100 * (doneIssues + verifiedCriteria)) / total);
    const actor = (kind: Actor["kind"], id: string | null): Actor => ({
      kind, id, name: id ? names.get(id) ?? null : null,
    });
    return {
      id: row.id, companyId: row.company_id, projectId: row.project_id, projectName: row.project_name,
      title: row.title, description: row.description, status: row.status, targetDate: row.target_date ? (row.target_date instanceof Date ? row.target_date.toISOString().slice(0, 10) : String(row.target_date).slice(0, 10)) : null,
      criteria, issueIds, issues, evidence, completedAt: isoOrNull(row.completed_at), revision: row.revision,
      progress, doneIssues, verifiedCriteria, readyToComplete: blockers.length === 0, blockers,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      createdBy: actor(row.created_by_kind, row.created_by_id),
      updatedBy: actor(row.updated_by_kind, row.updated_by_id),
    } satisfies MilestoneRecord;
  }));
}

export async function listMilestones(
  ctx: PluginContext, companyId: string, projectId?: string,
): Promise<MilestoneRecord[]> {
  const args: unknown[] = [uuid(companyId, "companyId")];
  let projectFilter = "";
  if (projectId) {
    projectFilter = " AND m.project_id = $2::uuid";
    args.push(uuid(projectId, "projectId"));
  }
  const rows = await ctx.db.query<StoredMilestone>(
    `SELECT ${cols} FROM ${source(ctx)} WHERE m.company_id = $1::uuid AND m.deleted_at IS NULL${projectFilter}
    ORDER BY m.target_date ASC NULLS LAST, m.created_at ASC LIMIT ${MAX_LIST}`, args,
  );
  return hydrate(ctx, companyId, rows);
}

export async function getMilestone(ctx: PluginContext, companyId: string, milestoneId: string): Promise<MilestoneRecord | null> {
  const rows = await ctx.db.query<StoredMilestone>(
    `SELECT ${cols} FROM ${source(ctx)} WHERE m.company_id = $1::uuid AND m.id = $2::uuid AND m.deleted_at IS NULL`,
    [uuid(companyId, "companyId"), uuid(milestoneId, "milestoneId")],
  );
  return (await hydrate(ctx, companyId, rows))[0] ?? null;
}

async function requireMilestone(ctx: PluginContext, companyId: string, milestoneId: string): Promise<MilestoneRecord> {
  const found = await getMilestone(ctx, companyId, milestoneId);
  if (!found) throw new NotFoundError("Milestone not found");
  return found;
}

async function validateIssues(ctx: PluginContext, companyId: string, projectId: string, ids: string[]): Promise<void> {
  const snapshot = await issueSnapshot(ctx, companyId, projectId, ids);
  if (snapshot.notFound.length) throw new DashboardError("issueIds: all linked Issues must belong to this company and project");
}

export interface CreateMilestoneInput {
  companyId: string;
  projectId: string;
  fields: MilestoneFields;
  actor: Actor;
}

export async function createMilestone(ctx: PluginContext, input: CreateMilestoneInput): Promise<MilestoneRecord> {
  const companyId = uuid(input.companyId, "companyId");
  const projectId = uuid(input.projectId, "projectId");
  const project = await requireProject(ctx, companyId, projectId);
  if (project.archivedAt) throw new DashboardError("Cannot create milestones for archived projects");
  await validateIssues(ctx, companyId, projectId, input.fields.issueIds);
  const id = randomUUID();
  const { title, description, status, targetDate, criteria, issueIds, evidence } = input.fields;
  await ctx.db.execute(
    `INSERT INTO ${milestoneTable(ctx)}
       (id, company_id, project_id, title, description, status, target_date, criteria, issue_ids, evidence,
        created_by_kind, created_by_id, updated_by_kind, updated_by_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::date, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $11, $12)`,
    [id, companyId, projectId, title, description, status, targetDate, JSON.stringify(criteria), JSON.stringify(issueIds), JSON.stringify(evidence), input.actor.kind, input.actor.id],
  );
  const record = await requireMilestone(ctx, companyId, id);
  await ctx.activity.log({
    companyId, message: `Created milestone "${title}" in project "${project.name}"`,
    entityType: "plugin_project_milestone", entityId: id, metadata: { projectId, status },
  });
  return record;
}

export class MilestoneConflictError extends DashboardError {
  constructor() { super("Milestone changed since it was read; refresh and retry with the current revision"); }
}

export interface UpdateMilestoneInput {
  companyId: string; milestoneId: string; patch: MilestonePatch; actor: Actor;
}

export async function updateMilestone(ctx: PluginContext, input: UpdateMilestoneInput): Promise<MilestoneRecord> {
  const companyId = uuid(input.companyId, "companyId");
  const milestoneId = uuid(input.milestoneId, "milestoneId");
  const before = await requireMilestone(ctx, companyId, milestoneId);
  const { revision, ...changes } = input.patch;
  if (revision !== before.revision) throw new MilestoneConflictError();
  if (before.status === "completed" &&
    (changes.status !== "in_progress" || Object.keys(changes).length !== 1)) {
    throw new DashboardError("Completed milestones are immutable; reopen to in_progress first");
  }
  const next: MilestoneFields = {
    title: changes.title ?? before.title,
    description: changes.description === undefined ? before.description : changes.description,
    status: changes.status ?? before.status,
    targetDate: changes.targetDate === undefined ? before.targetDate : changes.targetDate,
    criteria: changes.criteria ?? before.criteria,
    issueIds: changes.issueIds ?? before.issueIds,
    evidence: changes.evidence ?? before.evidence,
  };
  await validateIssues(ctx, companyId, before.projectId, next.issueIds);
  const closing = next.status === "completed" && before.status !== "completed";
  let completionIssues: MilestoneIssue[] = [];
  if (closing) {
    const snapshot = await issueSnapshot(ctx, companyId, before.projectId, next.issueIds);
    completionIssues = snapshot.issues;
    const pending = snapshot.issues.filter((issue) => !completed(issue.status));
    if (!next.criteria.length || next.criteria.some((criterion) => !criterion.checked) ||
        !next.evidence.length || snapshot.notFound.length || pending.length) {
      throw new DashboardError("Cannot complete milestone: verify every criterion, finish all linked Issues, and attach evidence");
    }
  }
  const params: unknown[] = [
    companyId, milestoneId, revision, next.title, next.description, next.status, next.targetDate,
    JSON.stringify(next.criteria), JSON.stringify(next.issueIds), JSON.stringify(next.evidence), input.actor.kind, input.actor.id,
  ];
  const set = `title=$4, description=$5, status=$6, target_date=$7::date,
     criteria=$8::jsonb, issue_ids=$9::jsonb, evidence=$10::jsonb,
     completed_at=CASE WHEN $6='completed' THEN now() ELSE NULL END,
     updated_by_kind=$11, updated_by_id=$12, revision=revision + 1, updated_at=now()`;
  const match = `company_id=$1::uuid AND id=$2::uuid AND revision=$3 AND deleted_at IS NULL`;
  if (closing) {
    // One atomic mutation: a completed milestone cannot exist without its changelog entry.
    // Unique milestone_id prevents duplicate completion history on retry/reopen.
    const entryId = randomUUID();
    const issueRefs = completionIssues.map((issue) => issue.identifier).slice(0, 19);
    const refs = [`milestone:${milestoneId}`, ...issueRefs];
    const body = ["### Critérios atendidos", ...next.criteria.map((criterion) => `- ${criterion.text}`)].join("\n");
    await ctx.db.execute(
      `WITH changed AS (
        UPDATE ${milestoneTable(ctx)} SET ${set}
        WHERE ${match} RETURNING id, company_id, project_id, title, completed_at
      )
      INSERT INTO ${changelogTable(ctx)}
        (id, company_id, project_id, kind, title, body, version, refs, links, occurred_at,
         milestone_id, issue_id, created_by_kind, created_by_id, updated_by_kind, updated_by_id)
      SELECT $13::uuid, changed.company_id, changed.project_id, 'milestone', changed.title, $14,
             NULL, $15::jsonb, $16::jsonb, changed.completed_at,
             changed.id, NULL, $11, $12, $11, $12 FROM changed
      ON CONFLICT (company_id, milestone_id) WHERE milestone_id IS NOT NULL DO NOTHING`,
      [...params, entryId, body, JSON.stringify(refs), JSON.stringify(next.evidence)],
    );
  } else {
    const result = await ctx.db.execute(
      `UPDATE ${milestoneTable(ctx)} SET ${set} WHERE ${match}`, params,
    );
    if (result.rowCount !== 1) throw new MilestoneConflictError();
  }
  const record = await requireMilestone(ctx, companyId, milestoneId);
  if (record.revision !== revision + 1) throw new MilestoneConflictError();
  await ctx.activity.log({
    companyId, message: closing ? `Completed milestone "${record.title}"` : `Updated milestone "${record.title}"`,
    entityType: "plugin_project_milestone", entityId: milestoneId,
    metadata: { projectId: record.projectId, status: record.status, revision: record.revision },
  });
  return record;
}
