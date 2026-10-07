import { createHash, randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
type CompanyArtifact = Awaited<ReturnType<PluginContext["artifacts"]["list"]>>["artifacts"][number];
import type {
  ArtifactMetadata,
  LibraryFilters,
  LibraryFolder,
  LibraryNavigation,
  LibraryResponse,
  LibraryTag,
  LibraryView,
} from "./contracts.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ["all", "image", "video", "text", "document", "file"];
const COLORS = ["slate", "blue", "green", "amber", "rose", "violet"];
const FILTER_KEYS = [
  "q",
  "projectId",
  "agentId",
  "taskId",
  "kind",
  "folderId",
  "tagId",
  "starred",
];
const DEFAULT_METADATA: ArtifactMetadata = {
  folderId: null,
  tagIds: [],
  starred: false,
};
type Params = Record<string, unknown>;
type MetadataRow = {
  artifact_id: string;
  folder_id: string | null;
  tag_ids: string[];
  starred: boolean;
};

function record(value: unknown, label: string): Params {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Params;
}
export function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !GUID.test(value))
    throw new Error(`${label} must be a UUID`);
  return value.toLowerCase();
}
function name(value: unknown, label = "name", max = 100): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new Error(`${label} must contain 1 to ${max} characters`);
  return value.trim();
}
function has(params: Params, key: string) {
  return Object.prototype.hasOwnProperty.call(params, key);
}
function table(ctx: PluginContext, key: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace))
    throw new Error("Invalid plugin database namespace");
  return `${ctx.db.namespace}.${key}`;
}
export function parseFilters(value: unknown = {}): LibraryFilters {
  const input = record(value, "filters");
  if (Object.keys(input).some((key) => !FILTER_KEYS.includes(key)))
    throw new Error("Unknown library filter");
  const result: LibraryFilters = {};
  // Stable property order makes continuation cursors bound to the same query.
  if (has(input, "q") && input.q !== undefined) {
    if (typeof input.q !== "string" || input.q.trim().length > 160)
      throw new Error("Search must contain at most 160 characters");
    if (input.q.trim()) result.q = input.q.trim();
  }
  for (const key of ["projectId", "agentId", "taskId", "tagId"] as const) {
    if (input[key] !== undefined) result[key] = uuid(input[key], key);
  }
  if (has(input, "folderId") && input.folderId !== undefined)
    result.folderId =
      input.folderId === null ? null : uuid(input.folderId, "folderId");
  if (input.kind !== undefined) {
    if (typeof input.kind !== "string" || !KINDS.includes(input.kind))
      throw new Error("Unknown artifact kind");
    result.kind = input.kind as LibraryFilters["kind"];
  }
  if (input.starred !== undefined) {
    if (typeof input.starred !== "boolean")
      throw new Error("starred must be a boolean");
    if (input.starred) result.starred = true;
  }
  return result;
}

async function company(ctx: PluginContext, params: Params): Promise<string> {
  const companyId = uuid(params.companyId, "companyId");
  if (!(await ctx.companies.get(companyId)))
    throw new Error("Company not found");
  return companyId;
}
async function requireFolder(
  ctx: PluginContext,
  companyId: string,
  id: string,
): Promise<LibraryFolder> {
  const rows = await ctx.db.query<LibraryFolder>(
    `SELECT id, name, parent_id AS "parentId" FROM ${table(ctx, "folders")} WHERE company_id = $1 AND id = $2`,
    [companyId, id],
  );
  if (!rows[0]) throw new Error("Folder not found in this company");
  return rows[0];
}
async function requireTag(
  ctx: PluginContext,
  companyId: string,
  id: string,
): Promise<void> {
  if (
    !(
      await ctx.db.query(
        `SELECT id FROM ${table(ctx, "tags")} WHERE company_id = $1 AND id = $2 AND archived = false`,
        [companyId, id],
      )
    ).length
  )
    throw new Error("Tag not found in this company");
}
async function validateFilterReferences(
  ctx: PluginContext,
  companyId: string,
  filters: LibraryFilters,
): Promise<void> {
  await Promise.all([
    filters.folderId
      ? requireFolder(ctx, companyId, filters.folderId)
      : Promise.resolve(),
    filters.tagId
      ? requireTag(ctx, companyId, filters.tagId)
      : Promise.resolve(),
    filters.projectId
      ? ctx.projects.get(filters.projectId, companyId).then((v) => {
          if (!v) throw new Error("Project not found in this company");
        })
      : Promise.resolve(),
    filters.agentId
      ? ctx.agents.get(filters.agentId, companyId).then((v) => {
          if (!v) throw new Error("Agent not found in this company");
        })
      : Promise.resolve(),
  ]);
}

export async function navigation(
  ctx: PluginContext,
  params: Params,
): Promise<LibraryNavigation> {
  const companyId = await company(ctx, params);
  const [folders, tags, views, projects, agents] = await Promise.all([
    ctx.db.query<LibraryFolder>(
      `SELECT id, name, parent_id AS "parentId" FROM ${table(ctx, "folders")} WHERE company_id = $1 ORDER BY lower(name), id`,
      [companyId],
    ),
    ctx.db.query<LibraryTag>(
      `SELECT id, name, color FROM ${table(ctx, "tags")} WHERE company_id = $1 AND archived = false ORDER BY lower(name), id`,
      [companyId],
    ),
    ctx.db.query<LibraryView>(
      `SELECT id, name, filters, layout FROM ${table(ctx, "saved_views")} WHERE company_id = $1 ORDER BY lower(name), id`,
      [companyId],
    ),
    ctx.projects.list({ companyId }),
    ctx.agents.list({ companyId }),
  ]);
  const folderIds = new Set(folders.map((f) => f.id));
  const tagIds = new Set(tags.map((t) => t.id));
  const projectIds = new Set(projects.map((p) => p.id));
  const agentIds = new Set(agents.map((a) => a.id));
  return {
    companyId,
    folders,
    tags,
    views: views.map((view) => {
      const filters = parseFilters(view.filters);
      if (filters.folderId && !folderIds.has(filters.folderId))
        delete filters.folderId;
      if (filters.tagId && !tagIds.has(filters.tagId)) delete filters.tagId;
      if (filters.projectId && !projectIds.has(filters.projectId))
        delete filters.projectId;
      if (filters.agentId && !agentIds.has(filters.agentId))
        delete filters.agentId;
      return { ...view, filters };
    }),
    projects: projects.map(({ id, name }) => ({ id, name })),
    agents: agents.map(({ id, name }) => ({ id, name })),
  };
}

function filterHash(companyId: string, filters: LibraryFilters): string {
  return createHash("sha256")
    .update(JSON.stringify({ companyId, filters }))
    .digest("hex")
    .slice(0, 24);
}
function encodeCursor(core: string, hash: string): string {
  return Buffer.from(JSON.stringify({ version: 1, core, hash })).toString(
    "base64url",
  );
}
function decodeCursor(value: unknown, hash: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    if (typeof value !== "string" || value.length > 5000) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      cursor.version !== 1 ||
      cursor.hash !== hash ||
      typeof cursor.core !== "string" ||
      !cursor.core
    )
      throw new Error();
    return cursor.core;
  } catch {
    throw new Error("Invalid library cursor; restart this search");
  }
}
function matches(
  artifact: CompanyArtifact,
  metadata: ArtifactMetadata,
  filters: LibraryFilters,
): boolean {
  return (
    (!filters.agentId || artifact.createdByAgent?.id === filters.agentId) &&
    (!filters.taskId || artifact.issue.id === filters.taskId) &&
    (!has(filters as Params, "folderId") ||
      metadata.folderId === filters.folderId) &&
    (!filters.tagId || metadata.tagIds.includes(filters.tagId)) &&
    (!filters.starred || metadata.starred)
  );
}

export async function listLibrary(
  ctx: PluginContext,
  params: Params,
): Promise<LibraryResponse> {
  const companyId = await company(ctx, params);
  const queryKey = params.queryKey ?? null;
  if (
    queryKey !== null &&
    (typeof queryKey !== "string" || queryKey.length > 2000)
  )
    throw new Error("queryKey must contain at most 2000 characters");
  const filters = parseFilters(params.filters);
  await validateFilterReferences(ctx, companyId, filters);
  const limit = params.limit === undefined ? 30 : params.limit;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("limit must be between 1 and 100");
  const hash = filterHash(companyId, filters);
  let coreCursor = decodeCursor(params.cursor, hash);
  const nav = await navigation(ctx, { companyId });
  const activeTagIds = new Set(nav.tags.map((tag) => tag.id));
  const artifacts: LibraryResponse["artifacts"] = [];
  const seenCursors = new Set<string>();
  // Each core page fits in the remaining output capacity, so no overfetched
  // artifact can be skipped. A bounded scan returns a continuation even when
  // a sparse filter yields an empty page; null means core exhaustion only.
  for (let scan = 0; scan < 20 && artifacts.length < limit; scan++) {
    const page = await ctx.artifacts.list({
      companyId,
      kind: filters.kind,
      q: filters.q,
      projectId: filters.projectId,
      groupBy: "none",
      limit: limit - artifacts.length,
      cursor: coreCursor,
    });
    // Metadata crosses the worker bridge only for artifacts in this core
    // page. JSON is a scalar bind parameter even in hosts whose SQL template
    // expands JavaScript arrays as tuples.
    const pageIds = page.artifacts.map((artifact) => artifact.id);
    const rows = pageIds.length
      ? await ctx.db.query<MetadataRow>(
          `SELECT artifact_id, folder_id, tag_ids, starred FROM ${table(ctx, "artifact_metadata")} WHERE company_id = $1 AND artifact_id = ANY (SELECT jsonb_array_elements_text($2::jsonb))`,
          [companyId, JSON.stringify(pageIds)],
        )
      : [];
    const metadata = new Map(
      rows.map((row) => [
        row.artifact_id,
        {
          folderId: row.folder_id,
          tagIds: row.tag_ids.filter((id) => activeTagIds.has(id)),
          starred: row.starred,
        },
      ]),
    );
    for (const artifact of page.artifacts) {
      const itemMetadata = metadata.get(artifact.id) ?? {
        ...DEFAULT_METADATA,
        tagIds: [],
      };
      if (matches(artifact, itemMetadata, filters))
        artifacts.push({ ...artifact, metadata: itemMetadata });
    }
    if (!page.nextCursor)
      return { ...nav, queryKey, artifacts, nextCursor: null };
    if (page.nextCursor === coreCursor || seenCursors.has(page.nextCursor))
      throw new Error("Artifact pagination did not advance");
    seenCursors.add(page.nextCursor);
    coreCursor = page.nextCursor;
  }
  return {
    ...nav,
    queryKey,
    artifacts,
    nextCursor: coreCursor ? encodeCursor(coreCursor, hash) : null,
  };
}

async function requireArtifact(
  ctx: PluginContext,
  companyId: string,
  artifactId: string,
  issueId?: string,
): Promise<void> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const page = await ctx.artifacts.list({
      companyId,
      groupBy: issueId ? "task" : "none",
      ...(issueId ? { groupIssueId: issueId } : {}),
      limit: 100,
      cursor,
    });
    if (
      page.artifacts.some(
        (item) =>
          item.id === artifactId && (!issueId || item.issue.id === issueId),
      )
    )
      return;
    if (!page.nextCursor) throw new Error("Artifact not found in this company");
    if (seen.has(page.nextCursor))
      throw new Error("Artifact pagination did not advance");
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export async function updateArtifact(ctx: PluginContext, params: Params) {
  const companyId = await company(ctx, params);
  const artifactId = name(params.artifactId, "artifactId", 500);
  const issueId =
    params.issueId === undefined ? undefined : uuid(params.issueId, "issueId");
  await requireArtifact(ctx, companyId, artifactId, issueId);
  const setFolder = has(params, "folderId");
  const folderId =
    setFolder && params.folderId !== null
      ? uuid(params.folderId, "folderId")
      : null;
  const setStarred = has(params, "starred");
  if (setStarred && typeof params.starred !== "boolean")
    throw new Error("starred must be a boolean");
  const addTagId =
    params.addTagId === undefined ? null : uuid(params.addTagId, "addTagId");
  const removeTagId =
    params.removeTagId === undefined
      ? null
      : uuid(params.removeTagId, "removeTagId");
  if (!setFolder && !setStarred && !addTagId && !removeTagId)
    throw new Error("No metadata change supplied");
  if (addTagId && addTagId === removeTagId)
    throw new Error("Cannot add and remove the same tag");
  await Promise.all([
    folderId ? requireFolder(ctx, companyId, folderId) : Promise.resolve(),
    addTagId ? requireTag(ctx, companyId, addTagId) : Promise.resolve(),
    removeTagId ? requireTag(ctx, companyId, removeTagId) : Promise.resolve(),
  ]);
  const metadataTable = table(ctx, "artifact_metadata");
  // Update only requested fields. Concurrent tag/favorite/folder actions use
  // PostgreSQL's conflict row lock instead of read-modify-write snapshots.
  await ctx.db.execute(
    `INSERT INTO ${metadataTable} AS current_metadata (company_id, artifact_id, folder_id, starred, tag_ids)
    VALUES ($1, $2, $3::uuid, $4::boolean, array_remove(ARRAY[$5::uuid], NULL))
    ON CONFLICT (company_id, artifact_id) DO UPDATE SET
      folder_id = CASE WHEN $7::boolean THEN EXCLUDED.folder_id ELSE current_metadata.folder_id END,
      starred = CASE WHEN $8::boolean THEN EXCLUDED.starred ELSE current_metadata.starred END,
      tag_ids = array_remove(CASE WHEN $5::uuid IS NOT NULL AND NOT ($5::uuid = ANY(current_metadata.tag_ids)) THEN array_append(current_metadata.tag_ids, $5::uuid) ELSE current_metadata.tag_ids END, $6::uuid),
      updated_at = now()`,
    [
      companyId,
      artifactId,
      folderId,
      setStarred ? params.starred : false,
      addTagId,
      removeTagId,
      setFolder,
      setStarred,
    ],
  );
  await audit(
    ctx,
    companyId,
    "Updated artifact organization",
    "artifact",
    artifactId,
  );
  return { ok: true };
}

async function audit(
  ctx: PluginContext,
  companyId: string,
  message: string,
  entityType: string,
  entityId: string,
) {
  await ctx.activity.log({ companyId, message, entityType, entityId });
}

export async function saveFolder(ctx: PluginContext, params: Params) {
  const companyId = await company(ctx, params);
  const id = params.id === undefined ? randomUUID() : uuid(params.id, "id");
  const displayName = name(params.name);
  const parentId =
    params.parentId === undefined || params.parentId === null
      ? null
      : uuid(params.parentId, "parentId");
  if (params.id !== undefined) await requireFolder(ctx, companyId, id);
  if (parentId) {
    await requireFolder(ctx, companyId, parentId);
    const rows = await ctx.db.query<{ id: string }>(
      `WITH RECURSIVE descendants AS (
      SELECT id FROM ${table(ctx, "folders")} WHERE company_id = $1 AND id = $2
      UNION SELECT f.id FROM ${table(ctx, "folders")} f JOIN descendants d ON f.parent_id = d.id WHERE f.company_id = $1
    ) SELECT id FROM descendants WHERE id = $3`,
      [companyId, id, parentId],
    );
    if (rows.length)
      throw new Error(
        "A folder cannot be moved into itself or its descendants",
      );
  }
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "folders")} AS current_folder (id, company_id, name, parent_id)
    VALUES ($1, $2, $3, $4::uuid) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id, updated_at = now() WHERE current_folder.company_id = EXCLUDED.company_id`,
    [id, companyId, displayName, parentId],
  );
  await audit(ctx, companyId, "Saved artifact folder", "folder", id);
  return { ok: true, id };
}
export async function deleteFolder(ctx: PluginContext, params: Params) {
  const companyId = await company(ctx, params);
  const id = uuid(params.id, "id");
  await requireFolder(ctx, companyId, id);
  // Detaching a child must not fail when a same-name root folder exists.
  // Reserve names for every survivor and choose predictable suffixes first.
  const folderRows = await ctx.db.query<{
    id: string;
    name: string;
    name_key: string;
    parent_id: string | null;
  }>(
    `SELECT id, name, lower(name) AS name_key, parent_id FROM ${table(ctx, "folders")} WHERE company_id = $1 ORDER BY id`,
    [companyId],
  );
  const roots = new Set(
    folderRows
      .filter((folder) => folder.parent_id === null && folder.id !== id)
      .map((folder) => folder.name_key),
  );
  const children = folderRows.filter((folder) => folder.parent_id === id);
  const reserved = new Set([
    ...roots,
    ...children.map((folder) => folder.name_key),
  ]);
  for (const child of children) {
    if (!roots.has(child.name_key)) continue;
    for (let suffixNumber = 2; ; suffixNumber++) {
      const suffix = ` (${suffixNumber})`;
      const candidate =
        Array.from(child.name)
          .slice(0, 100 - suffix.length)
          .join("") + suffix;
      const [normalized] = await ctx.db.query<{ name_key: string }>(
        "SELECT lower($1::text) AS name_key",
        [candidate],
      );
      if (reserved.has(normalized!.name_key)) continue;
      reserved.add(normalized!.name_key);
      await ctx.db.execute(
        `UPDATE ${table(ctx, "folders")} SET name = $1, updated_at = now() WHERE company_id = $2 AND id = $3`,
        [candidate, companyId, child.id],
      );
      break;
    }
  }
  // Composite FK actions detach children and artifacts atomically while
  // preserving their company; the underlying artifact is never touched.
  await ctx.db.execute(
    `DELETE FROM ${table(ctx, "folders")} WHERE company_id = $1 AND id = $2`,
    [companyId, id],
  );
  await ctx.db.execute(
    `UPDATE ${table(ctx, "saved_views")} SET filters = filters - 'folderId', updated_at = now() WHERE company_id = $1 AND filters->>'folderId' = $2`,
    [companyId, id],
  );
  await audit(
    ctx,
    companyId,
    "Deleted artifact folder; contents are unfiled",
    "folder",
    id,
  );
  return { ok: true };
}
export async function saveTag(ctx: PluginContext, params: Params) {
  const companyId = await company(ctx, params);
  const id = params.id === undefined ? randomUUID() : uuid(params.id, "id");
  if (params.id !== undefined) await requireTag(ctx, companyId, id);
  const displayName = name(params.name, "name", 50);
  const color = params.color ?? "slate";
  if (typeof color !== "string" || !COLORS.includes(color))
    throw new Error("Unknown tag color");
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "tags")} AS current_tag (id, company_id, name, color)
    VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color, updated_at = now() WHERE current_tag.company_id = EXCLUDED.company_id`,
    [id, companyId, displayName, color],
  );
  await audit(ctx, companyId, "Saved artifact tag", "tag", id);
  return { ok: true, id };
}
export async function deleteTag(ctx: PluginContext, params: Params) {
  const companyId = await company(ctx, params);
  const id = uuid(params.id, "id");
  await requireTag(ctx, companyId, id);
  // Soft deletion removes the tag from all visible metadata atomically and
  // permits its name to be reused, without racing concurrent array updates.
  await ctx.db.execute(
    `UPDATE ${table(ctx, "tags")} SET archived = true, updated_at = now() WHERE company_id = $1 AND id = $2`,
    [companyId, id],
  );
  await ctx.db.execute(
    `UPDATE ${table(ctx, "saved_views")} SET filters = filters - 'tagId', updated_at = now() WHERE company_id = $1 AND filters->>'tagId' = $2`,
    [companyId, id],
  );
  await audit(ctx, companyId, "Deleted artifact tag", "tag", id);
  return { ok: true };
}
export async function saveView(ctx: PluginContext, params: Params) {
  const companyId = await company(ctx, params);
  const id = params.id === undefined ? randomUUID() : uuid(params.id, "id");
  if (
    params.id !== undefined &&
    !(
      await ctx.db.query(
        `SELECT id FROM ${table(ctx, "saved_views")} WHERE company_id = $1 AND id = $2`,
        [companyId, id],
      )
    ).length
  )
    throw new Error("Saved view not found in this company");
  const displayName = name(params.name);
  const filters = parseFilters(params.filters);
  await validateFilterReferences(ctx, companyId, filters);
  if (params.layout !== "grid" && params.layout !== "list")
    throw new Error("layout must be grid or list");
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "saved_views")} AS current_view (id, company_id, name, filters, layout)
    VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, filters = EXCLUDED.filters, layout = EXCLUDED.layout, updated_at = now() WHERE current_view.company_id = EXCLUDED.company_id`,
    [id, companyId, displayName, JSON.stringify(filters), params.layout],
  );
  await audit(ctx, companyId, "Saved artifact view", "view", id);
  return { ok: true, id };
}
export async function deleteView(ctx: PluginContext, params: Params) {
  const companyId = await company(ctx, params);
  const id = uuid(params.id, "id");
  await ctx.db.execute(
    `DELETE FROM ${table(ctx, "saved_views")} WHERE company_id = $1 AND id = $2`,
    [companyId, id],
  );
  await audit(ctx, companyId, "Deleted artifact view", "view", id);
  return { ok: true };
}
