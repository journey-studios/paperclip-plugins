import type { PluginContext, Project } from "@paperclipai/plugin-sdk";
import type { Actor, ProjectHierarchy, ProjectNode, ProjectTree } from "./contracts.js";
import { HierarchyError } from "./errors.js";
import { ancestorIds, descendantIds, wouldCycle } from "./tree.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !GUID.test(value)) {
    throw new HierarchyError("invalid_input", `${label} must be a UUID`);
  }
  return value.toLowerCase();
}

/** A parent id, or null to make the project top-level. Undefined is a caller mistake, not "no change". */
export function parentInput(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return uuid(value, "parentProjectId");
}

function table(ctx: PluginContext): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) {
    throw new Error("Invalid plugin database namespace");
  }
  return `${ctx.db.namespace}.project_parents`;
}

/** Stored links of a company: child id → parent id. */
async function loadLinks(ctx: PluginContext, companyId: string): Promise<Map<string, string>> {
  const rows = await ctx.db.query<{ project_id: string; parent_project_id: string }>(
    `SELECT project_id, parent_project_id FROM ${table(ctx)} WHERE company_id = $1`,
    [companyId],
  );
  return new Map(rows.map((row) => [String(row.project_id), String(row.parent_project_id)]));
}

function toNode(project: Project, parentId: string | null): ProjectNode {
  return {
    id: project.id,
    name: project.name,
    urlKey: project.urlKey ?? null,
    status: project.status ?? null,
    color: project.color ?? null,
    archived: Boolean(project.archivedAt),
    parentId,
  };
}

function byName(left: ProjectNode, right: ProjectNode): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.id.localeCompare(right.id);
}

export async function getTree(ctx: PluginContext, companyId: string): Promise<ProjectTree> {
  const [projects, links] = await Promise.all([ctx.projects.list({ companyId }), loadLinks(ctx, companyId)]);
  const ids = new Set(projects.map((project) => project.id));
  const nodes = projects
    .map((project) => {
      // A link whose parent left the company's project list renders as top-level.
      const parentId = links.get(project.id);
      return toNode(project, parentId && ids.has(parentId) ? parentId : null);
    })
    .sort(byName);
  return { companyId, projects: nodes };
}

export async function getHierarchy(ctx: PluginContext, companyId: string, projectId: string): Promise<ProjectHierarchy> {
  const { projects } = await getTree(ctx, companyId);
  const byId = new Map(projects.map((node) => [node.id, node]));
  const project = byId.get(projectId);
  if (!project) {
    throw new HierarchyError("project_not_found", "Project not found in this company");
  }
  const parentOf = new Map(projects.filter((node) => node.parentId).map((node) => [node.id, node.parentId!]));
  return {
    companyId,
    project,
    parent: project.parentId ? (byId.get(project.parentId) ?? null) : null,
    ancestors: ancestorIds(projectId, parentOf).map((id) => byId.get(id)!),
    children: projects.filter((node) => node.parentId === projectId),
    descendantCount: descendantIds(projectId, projects).size,
  };
}

export interface SetParentInput {
  companyId: string;
  projectId: unknown;
  parentProjectId: unknown;
  actor: Actor;
}

/**
 * Place a project under a parent of the same company, or make it top-level
 * (parentProjectId null). Callers serialize per company so two concurrent
 * moves cannot each pass the cycle check and close a loop together.
 */
export async function setParent(ctx: PluginContext, input: SetParentInput): Promise<ProjectHierarchy> {
  const { companyId, actor } = input;
  const projectId = uuid(input.projectId, "projectId");
  const parentId = parentInput(input.parentProjectId);
  const project = await ctx.projects.get(projectId, companyId);
  if (!project) {
    throw new HierarchyError("project_not_found", "Project not found in this company");
  }

  if (parentId === null) {
    const { rowCount } = await ctx.db.execute(`DELETE FROM ${table(ctx)} WHERE company_id = $1 AND project_id = $2`, [
      companyId,
      projectId,
    ]);
    if (rowCount > 0) {
      await audit(ctx, companyId, projectId, `Made project "${project.name}" top-level`, { parentProjectId: null, actor });
    }
    return getHierarchy(ctx, companyId, projectId);
  }

  if (parentId === projectId) {
    throw new HierarchyError("self_parent", "A project cannot be its own parent");
  }
  const parent = await ctx.projects.get(parentId, companyId);
  if (!parent) {
    throw new HierarchyError("parent_not_found", `Parent project not found in this company: ${parentId}`);
  }
  if (parent.archivedAt) {
    throw new HierarchyError("parent_archived", `Parent project "${parent.name}" is archived`);
  }
  if (wouldCycle(projectId, parentId, await loadLinks(ctx, companyId))) {
    throw new HierarchyError("cycle", `"${parent.name}" is a sub-project of "${project.name}"; moving it there would create a cycle`);
  }

  await ctx.db.execute(
    `INSERT INTO ${table(ctx)} AS current_link (project_id, company_id, parent_project_id, updated_by_kind, updated_by_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_id) DO UPDATE SET parent_project_id = EXCLUDED.parent_project_id,
       updated_by_kind = EXCLUDED.updated_by_kind, updated_by_id = EXCLUDED.updated_by_id, updated_at = now()
     WHERE current_link.company_id = EXCLUDED.company_id`,
    [projectId, companyId, parentId, actor.kind, actor.id],
  );
  await audit(ctx, companyId, projectId, `Moved project "${project.name}" under "${parent.name}"`, {
    parentProjectId: parentId,
    actor,
  });
  return getHierarchy(ctx, companyId, projectId);
}

async function audit(
  ctx: PluginContext,
  companyId: string,
  projectId: string,
  message: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.activity.log({ companyId, message, entityType: "project", entityId: projectId, metadata });
  } catch (error) {
    // The link is already stored; a failed audit write must not report the move as failed.
    ctx.logger.error("project hierarchy activity log failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Paperclip runs one worker per plugin; a per-company queue serializes moves within it. */
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

export type Serial = ReturnType<typeof companySerialQueue>;

/** Indented plain-text tree for agents. */
export function describeTree(tree: ProjectTree): string {
  const childrenOf = new Map<string | null, ProjectNode[]>();
  for (const node of tree.projects) {
    childrenOf.set(node.parentId, [...(childrenOf.get(node.parentId) ?? []), node]);
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const node of childrenOf.get(parentId) ?? []) {
      if (seen.has(node.id)) {
        continue;
      }
      seen.add(node.id);
      const flags = [node.status, node.archived ? "archived" : null].filter(Boolean).join(", ");
      lines.push(`${"  ".repeat(depth)}- ${node.name} (${node.id}${flags ? `, ${flags}` : ""})`);
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  // Projects caught in a stored cycle have no root; list them rather than hide them.
  for (const node of tree.projects) {
    if (!seen.has(node.id)) {
      walk(node.parentId, 0);
    }
  }
  return lines.join("\n");
}
