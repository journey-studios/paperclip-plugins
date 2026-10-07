import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CompanyArtifact, PluginContext } from "@paperclipai/plugin-sdk";
import manifest, { DATABASE_NAMESPACE } from "../src/manifest.js";
import { updateArtifact } from "../src/library.js";
import type { LibraryNavigation, LibraryResponse } from "../src/contracts.js";
import plugin from "../src/worker.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";
const OTHER_TASK = "66666666-6666-4666-8666-666666666666";
const AGENT = "44444444-4444-4444-8444-444444444444";
const OTHER_AGENT = "55555555-5555-4555-8555-555555555555";
type Handler = (params: Record<string, unknown>) => Promise<unknown>;
let db: PGlite;
let ctx: PluginContext;
let actions: Map<string, Handler>;
let data: Map<string, Handler>;
let source: Map<string, CompanyArtifact[]>;
let listCalls: {
  companyId: string;
  limit?: number;
  cursor?: string;
  groupBy?: string;
  groupIssueId?: string;
}[];
let metadataQueries: { companyId: string; artifactIds: string[]; returnedIds: string[] }[];
const schema = DATABASE_NAMESPACE;
const migration = await readFile(
  new URL("../migrations/001_artifact_library.sql", import.meta.url),
  "utf8",
);

function artifact(index = 0, agentId = AGENT): CompanyArtifact {
  return {
    id: `attachment:${index}`,
    source: "attachment",
    mediaKind: "image",
    title: `Artifact ${index}`,
    previewText: null,
    contentType: "image/png",
    contentPath: `/api/attachments/${index}/content`,
    openPath: null,
    downloadPath: null,
    issue: { id: TASK, identifier: "ACME-23", title: "Visual production" },
    project: null,
    createdByAgent: { id: agentId, name: "Designer" },
    updatedAt: "2026-10-07T12:00:00.000Z",
    href: "/ACME/issues/ACME-23",
  };
}
async function initialize(target: PGlite) {
  await target.exec(
    `CREATE TABLE public.companies (id uuid PRIMARY KEY); CREATE SCHEMA ${schema};`,
  );
  await target.exec(migration);
}
async function action<T = { ok: boolean; id: string }>(
  key: string,
  params: Record<string, unknown>,
): Promise<T> {
  return (await actions.get(key)!({ companyId: COMPANY, ...params })) as T;
}
async function read<T = LibraryResponse>(
  key: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return (await data.get(key)!({ companyId: COMPANY, ...params })) as T;
}

beforeAll(async () => {
  db = new PGlite();
  await initialize(db);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec(
    `TRUNCATE public.companies CASCADE; INSERT INTO public.companies VALUES ('${COMPANY}'), ('${OTHER_COMPANY}');`,
  );
  source = new Map([
    [COMPANY, [artifact()]],
    [OTHER_COMPANY, [artifact(999)]],
  ]);
  listCalls = [];
  metadataQueries = [];
  actions = new Map();
  data = new Map();
  ctx = {
    db: {
      namespace: schema,
      query: async (sql: string, params: unknown[] = []) => {
        const rows = (await db.query<Record<string, unknown>>(sql, params)).rows;
        if (sql.includes(`${schema}.artifact_metadata`)) {
          metadataQueries.push({
            companyId: params[0] as string,
            artifactIds: typeof params[1] === "string" ? JSON.parse(params[1]) : [],
            returnedIds: rows.map((row) => row.artifact_id as string),
          });
        }
        return rows;
      },
      execute: async (sql: string, params: unknown[] = []) => ({
        rowCount: (await db.query(sql, params)).affectedRows ?? 0,
      }),
    },
    companies: {
      get: async (id: string) =>
        [COMPANY, OTHER_COMPANY].includes(id) ? { id } : null,
    },
    projects: { list: async () => [], get: async () => null },
    agents: {
      list: async () => [
        { id: AGENT, name: "Designer" },
        { id: OTHER_AGENT, name: "Other" },
      ],
      get: async (id: string) =>
        [AGENT, OTHER_AGENT].includes(id) ? { id } : null,
    },
    artifacts: {
      list: async (input: {
        companyId: string;
        limit?: number;
        cursor?: string;
        kind?: string;
        q?: string;
        projectId?: string;
        groupBy?: string;
        groupIssueId?: string;
      }) => {
        listCalls.push(input);
        const offset = Number(input.cursor ?? 0);
        const filtered = (source.get(input.companyId) ?? []).filter(
          (a) =>
            (!input.kind ||
              input.kind === "all" ||
              a.mediaKind === input.kind) &&
            (!input.q ||
              a.title.toLowerCase().includes(input.q.toLowerCase())) &&
            (!input.projectId || a.project?.id === input.projectId) &&
            (!(input.groupBy === "task" && input.groupIssueId) ||
              a.issue.id === input.groupIssueId),
        );
        const limit = input.limit ?? 30;
        return {
          artifacts: filtered.slice(offset, offset + limit),
          nextCursor:
            offset + limit < filtered.length ? String(offset + limit) : null,
        };
      },
    },
    data: {
      register: (key: string, handler: Handler) => data.set(key, handler),
    },
    actions: {
      register: (key: string, handler: Handler) => actions.set(key, handler),
    },
    activity: { log: async () => {} },
  } as unknown as PluginContext;
  await plugin.definition.setup!(ctx);
});

describe("Artifact Library real PostgreSQL migration and worker", () => {
  it("declares additive page, navigation and least required artifact capability", () => {
    expect(manifest.id).toBe("journeystudios.artifact-library");
    expect(manifest.capabilities).toContain("artifacts.read");
    expect(manifest.ui!.slots!.map((slot) => slot.type)).toEqual([
      "sidebar",
      "page",
      "routeSidebar",
    ]);
    expect(
      manifest.ui!.slots!.find((slot) => slot.type === "page")!.routePath,
    ).toBe("library");
  });

  it("applies migration idempotently and database rejects cross-company folder references", async () => {
    await db.exec(migration);
    const folder = await action("folder-save", { name: "Example" });
    await expect(
      db.query(
        `INSERT INTO ${schema}.folders(id, company_id, name, parent_id) VALUES ($1, $2, 'Leak', $3)`,
        [TASK, OTHER_COMPANY, folder.id],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO ${schema}.artifact_metadata(company_id, artifact_id, folder_id) VALUES ($1, 'attachment:999', $2)`,
        [OTHER_COMPANY, folder.id],
      ),
    ).rejects.toThrow();
  });

  it("persists folders, tag deltas, favorites and saved layout with existing artifact provenance", async () => {
    const folder = await action("folder-save", { name: "Visuals" });
    const child = await action("folder-save", {
      name: "Campaign",
      parentId: folder.id,
    });
    const tag = await action("tag-save", { name: "Approved", color: "green" });
    await action("artifact-update", {
      artifactId: artifact().id,
      folderId: child.id,
      starred: true,
      addTagId: tag.id,
    });
    const view = await action("view-save", {
      name: "Approved visuals",
      filters: { folderId: child.id, tagId: tag.id, starred: true },
      layout: "list",
    });
    const result = await read("library", {
      filters: { tagId: tag.id, starred: true },
    });
    expect(result.artifacts[0]).toMatchObject({
      id: artifact().id,
      href: artifact().href,
      metadata: { folderId: child.id, tagIds: [tag.id], starred: true },
    });
    expect(result.views).toContainEqual({
      id: view.id,
      name: "Approved visuals",
      filters: { folderId: child.id, tagId: tag.id, starred: true },
      layout: "list",
    });
    await action("artifact-update", {
      artifactId: artifact().id,
      removeTagId: tag.id,
    });
    expect((await read("library")).artifacts[0]!.metadata).toEqual({
      folderId: child.id,
      tagIds: [],
      starred: true,
    });
  });

  it("rejects unknown artifacts and foreign folder/tag IDs without persisting metadata", async () => {
    const foreignFolder = await action("folder-save", {
      companyId: OTHER_COMPANY,
      name: "Foreign",
    });
    const foreignTag = await action("tag-save", {
      companyId: OTHER_COMPANY,
      name: "Foreign",
    });
    await expect(
      action("artifact-update", {
        artifactId: "attachment:999",
        starred: true,
      }),
    ).rejects.toThrow("Artifact not found in this company");
    await expect(
      action("artifact-update", {
        artifactId: artifact().id,
        folderId: foreignFolder.id,
      }),
    ).rejects.toThrow("Folder not found in this company");
    await expect(
      action("artifact-update", {
        artifactId: artifact().id,
        addTagId: foreignTag.id,
      }),
    ).rejects.toThrow("Tag not found in this company");
    expect(
      (await db.query(`SELECT * FROM ${schema}.artifact_metadata`)).rows,
    ).toHaveLength(0);
    expect((await read<LibraryNavigation>("navigation")).folders).toHaveLength(
      0,
    );
  });

  it("prevents hierarchy cycles including concurrent opposite moves", async () => {
    const folder = await action("folder-save", { name: "Parent" });
    const child = await action("folder-save", {
      name: "Child",
      parentId: folder.id,
    });
    await expect(
      action("folder-save", {
        id: folder.id,
        name: "Parent",
        parentId: child.id,
      }),
    ).rejects.toThrow("descendants");
    await expect(
      action("folder-save", {
        id: folder.id,
        name: "Parent",
        parentId: folder.id,
      }),
    ).rejects.toThrow("descendants");
    const second = await action("folder-save", { name: "Second" });
    const attempts = await Promise.allSettled([
      action("folder-save", {
        id: folder.id,
        name: "Parent",
        parentId: second.id,
      }),
      action("folder-save", {
        id: second.id,
        name: "Second",
        parentId: folder.id,
      }),
    ]);
    expect(attempts.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("deletes folder atomically without deleting artifacts or children and cleans saved views", async () => {
    const folder = await action("folder-save", { name: "Parent" });
    const child = await action("folder-save", {
      name: "Child",
      parentId: folder.id,
    });
    await action("artifact-update", {
      artifactId: artifact().id,
      folderId: folder.id,
      starred: true,
    });
    await action("view-save", {
      name: "Folder view",
      filters: { folderId: folder.id, starred: true },
      layout: "grid",
    });
    await action("folder-delete", { id: folder.id });
    const result = await read("library");
    expect(result.folders).toEqual([
      { id: child.id, name: "Child", parentId: null },
    ]);
    expect(result.artifacts[0]?.metadata).toEqual({
      folderId: null,
      tagIds: [],
      starred: true,
    });
    expect(result.views[0]?.filters).toEqual({ starred: true });
    expect(source.get(COMPANY)).toHaveLength(1);
  });

  it("preserves children when deleting their parent would collide with a root folder name", async () => {
    const parent = await action("folder-save", { name: "Parent" });
    await action("folder-save", { name: "Campaign" });
    await action("folder-save", { name: "Campaign (2)" });
    const child = await action("folder-save", {
      name: "Campaign",
      parentId: parent.id,
    });
    await action("artifact-update", {
      artifactId: artifact().id,
      folderId: child.id,
    });
    await action("folder-delete", { id: parent.id });
    const result = await read("library");
    expect(result.folders.find((folder) => folder.id === child.id)).toEqual({
      id: child.id,
      name: "Campaign (3)",
      parentId: null,
    });
    expect(result.artifacts[0]?.metadata.folderId).toBe(child.id);
  });

  it("hides deleted tags everywhere and permits reusing their names", async () => {
    const tag = await action("tag-save", { name: "Approved" });
    await action("artifact-update", {
      artifactId: artifact().id,
      addTagId: tag.id,
    });
    await action("view-save", {
      name: "Approved",
      filters: { tagId: tag.id },
      layout: "grid",
    });
    await action("tag-delete", { id: tag.id });
    const result = await read("library");
    expect(result.tags).toEqual([]);
    expect(result.artifacts[0]?.metadata.tagIds).toEqual([]);
    expect(result.views[0]?.filters).toEqual({});
    await expect(
      action("artifact-update", {
        artifactId: artifact().id,
        addTagId: tag.id,
      }),
    ).rejects.toThrow("Tag not found");
    await expect(
      action("tag-save", { name: "Approved" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("atomic independent upserts preserve concurrent favorites and tag additions", async () => {
    const tag = await action("tag-save", { name: "Reviewed" });
    const secondTag = await action("tag-save", { name: "Reusable" });
    // Bypass the worker's queue to verify the SQL itself has no lost writes.
    await Promise.all([
      updateArtifact(ctx, {
        companyId: COMPANY,
        artifactId: artifact().id,
        starred: true,
      }),
      updateArtifact(ctx, {
        companyId: COMPANY,
        artifactId: artifact().id,
        addTagId: tag.id,
      }),
      updateArtifact(ctx, {
        companyId: COMPANY,
        artifactId: artifact().id,
        addTagId: secondTag.id,
      }),
    ]);
    const metadata = (await read("library")).artifacts[0]!.metadata;
    expect(metadata.starred).toBe(true);
    expect(new Set(metadata.tagIds)).toEqual(new Set([tag.id, secondTag.id]));
    await Promise.all([
      updateArtifact(ctx, {
        companyId: COMPANY,
        artifactId: artifact().id,
        addTagId: tag.id,
      }),
      updateArtifact(ctx, {
        companyId: COMPANY,
        artifactId: artifact().id,
        addTagId: tag.id,
      }),
    ]);
    expect((await read("library")).artifacts[0]!.metadata.tagIds).toHaveLength(
      2,
    );
  });

  it("paginates sparse agent/task filters without skipping core artifacts", async () => {
    source.set(
      COMPANY,
      Array.from({ length: 17 }, (_, i) =>
        artifact(i, i % 3 === 0 ? AGENT : OTHER_AGENT),
      ),
    );
    const first = await read("library", {
      filters: { agentId: AGENT, taskId: TASK },
      limit: 2,
    });
    expect(first.artifacts.map((a) => a.id)).toEqual([
      "attachment:0",
      "attachment:3",
    ]);
    const second = await read("library", {
      filters: { agentId: AGENT, taskId: TASK },
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.artifacts.map((a) => a.id)).toEqual([
      "attachment:6",
      "attachment:9",
    ]);
    const third = await read("library", {
      filters: { agentId: AGENT, taskId: TASK },
      limit: 2,
      cursor: second.nextCursor,
    });
    expect(third.artifacts.map((a) => a.id)).toEqual([
      "attachment:12",
      "attachment:15",
    ]);
    const last = await read("library", {
      filters: { agentId: AGENT, taskId: TASK },
      limit: 2,
      cursor: third.nextCursor,
    });
    expect(last.artifacts).toEqual([]);
    expect(last.nextCursor).toBeNull();
    await expect(
      read("library", { filters: { starred: true }, cursor: first.nextCursor }),
    ).rejects.toThrow("Invalid library cursor");
    await expect(
      read("library", {
        companyId: OTHER_COMPANY,
        filters: { agentId: AGENT, taskId: TASK },
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow("Invalid library cursor");
  });

  it("returns explicit continuation for bounded empty scans and finds matches later", async () => {
    source.set(
      COMPANY,
      Array.from({ length: 50 }, (_, i) =>
        artifact(i, i === 49 ? AGENT : OTHER_AGENT),
      ),
    );
    const first = await read("library", {
      filters: { agentId: AGENT },
      limit: 1,
    });
    expect(first.artifacts).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    expect(listCalls).toHaveLength(20);
    const second = await read("library", {
      filters: { agentId: AGENT },
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.artifacts).toEqual([]);
    expect(second.nextCursor).not.toBeNull();
    const third = await read("library", {
      filters: { agentId: AGENT },
      limit: 1,
      cursor: second.nextCursor,
    });
    expect(third.artifacts.map((a) => a.id)).toEqual(["attachment:49"]);
    expect(third.nextCursor).toBeNull();
  });

  it("echoes company and query scope for UI stale-response guards", async () => {
    const queryKey = JSON.stringify({
      companyId: COMPANY,
      filters: { starred: true },
    });
    const response = await read("library", {
      filters: { starred: true },
      queryKey,
    });
    expect(response.companyId).toBe(COMPANY);
    expect(response.queryKey).toBe(queryKey);
    expect(
      (
        await read<LibraryNavigation>("navigation", {
          companyId: OTHER_COMPANY,
        })
      ).companyId,
    ).toBe(OTHER_COMPANY);
    expect(
      (await read("library", { companyId: OTHER_COMPANY })).queryKey,
    ).toBeNull();
    await expect(
      read("library", { queryKey: "x".repeat(2001) }),
    ).rejects.toThrow("queryKey");
  });

  it("reads metadata only for scanned core page IDs and keeps same-ID companies isolated", async () => {
    source.set(COMPANY, [artifact(0), artifact(1), artifact(2)]);
    await db.query(
      `INSERT INTO ${schema}.artifact_metadata(company_id, artifact_id, starred)
       SELECT $1::uuid, 'attachment:' || index::text, index <> 0 FROM generate_series(0, 199) AS index`,
      [COMPANY],
    );
    await db.query(
      `INSERT INTO ${schema}.artifact_metadata(company_id, artifact_id, starred) VALUES ($1, 'attachment:0', true)`,
      [OTHER_COMPANY],
    );
    const first = await read("library", { filters: { starred: true }, limit: 1 });
    expect(first.artifacts.map((item) => item.id)).toEqual(["attachment:1"]);
    expect(metadataQueries).toEqual([
      { companyId: COMPANY, artifactIds: ["attachment:0"], returnedIds: ["attachment:0"] },
      { companyId: COMPANY, artifactIds: ["attachment:1"], returnedIds: ["attachment:1"] },
    ]);
    metadataQueries = [];
    const second = await read("library", { filters: { starred: true }, limit: 1, cursor: first.nextCursor });
    expect(second.artifacts.map((item) => item.id)).toEqual(["attachment:2"]);
    expect(second.nextCursor).toBeNull();
    expect(metadataQueries).toEqual([
      { companyId: COMPANY, artifactIds: ["attachment:2"], returnedIds: ["attachment:2"] },
    ]);
  });

  it("does not query metadata for an empty core page", async () => {
    source.set(COMPANY, []);
    expect((await read("library")).artifacts).toEqual([]);
    expect(metadataQueries).toEqual([]);
  });

  it("narrows a hinted artifact lookup to its company task and skips unrelated artifacts", async () => {
    const target = artifact(130);
    target.issue = { ...target.issue, id: OTHER_TASK };
    source.set(COMPANY, [...Array.from({ length: 130 }, (_, i) => artifact(i)), target]);
    await action("artifact-update", { artifactId: target.id, issueId: OTHER_TASK, starred: true });
    expect(listCalls).toEqual([
      { companyId: COMPANY, groupBy: "task", groupIssueId: OTHER_TASK, limit: 100, cursor: undefined },
    ]);
    expect((await db.query<{ starred: boolean }>(
      `SELECT starred FROM ${schema}.artifact_metadata WHERE company_id = $1 AND artifact_id = $2`,
      [COMPANY, target.id],
    )).rows).toEqual([{ starred: true }]);
  });

  it("validates hint UUIDs before listing or writing metadata", async () => {
    for (const issueId of ["not-a-uuid", null, 123]) {
      await expect(action("artifact-update", { artifactId: artifact().id, issueId, starred: true })).rejects.toThrow("issueId must be a UUID");
    }
    expect(listCalls).toEqual([]);
    expect((await db.query(`SELECT * FROM ${schema}.artifact_metadata`)).rows).toEqual([]);
  });

  it("rejects wrong-task and foreign-company hints without falling back to the company feed", async () => {
    const foreign = artifact(999);
    foreign.issue = { ...foreign.issue, id: OTHER_TASK };
    source.set(OTHER_COMPANY, [foreign]);
    await expect(action("artifact-update", { artifactId: artifact().id, issueId: OTHER_TASK, starred: true })).rejects.toThrow("Artifact not found in this company");
    await expect(action("artifact-update", { artifactId: foreign.id, issueId: OTHER_TASK, starred: true })).rejects.toThrow("Artifact not found in this company");
    expect(listCalls).toHaveLength(2);
    expect(listCalls.every((call) => call.companyId === COMPANY && call.groupBy === "task" && call.groupIssueId === OTHER_TASK)).toBe(true);
    expect((await db.query(`SELECT * FROM ${schema}.artifact_metadata`)).rows).toEqual([]);
  });

  it("does not accept an artifact from the wrong task even if the host returns it for a hint", async () => {
    ctx.artifacts.list = async (input) => {
      listCalls.push(input);
      return { artifacts: [artifact()], nextCursor: null };
    };
    await expect(action("artifact-update", { artifactId: artifact().id, issueId: OTHER_TASK, starred: true })).rejects.toThrow("Artifact not found in this company");
    expect((await db.query(`SELECT * FROM ${schema}.artifact_metadata`)).rows).toEqual([]);
  });

  it("paginates a hinted task lookup and rejects nonadvancing cursors", async () => {
    source.set(COMPANY, Array.from({ length: 105 }, (_, i) => artifact(i)));
    await action("artifact-update", { artifactId: "attachment:104", issueId: TASK, starred: true });
    expect(listCalls.map((call) => ({ task: call.groupIssueId, cursor: call.cursor }))).toEqual([
      { task: TASK, cursor: undefined }, { task: TASK, cursor: "100" },
    ]);
    ctx.artifacts.list = async () => ({ artifacts: [], nextCursor: "stuck" });
    await expect(action("artifact-update", { artifactId: "attachment:missing", issueId: TASK, starred: true })).rejects.toThrow("Artifact pagination did not advance");
  });

  it("loads artifacts beyond the first core page before accepting metadata mutations", async () => {
    source.set(
      COMPANY,
      Array.from({ length: 130 }, (_, i) => artifact(i)),
    );
    await action("artifact-update", {
      artifactId: "attachment:129",
      starred: true,
    });
    expect(listCalls.slice(0, 2).map((call) => call.cursor)).toEqual([
      undefined,
      "100",
    ]);
    expect(listCalls.slice(0, 2).every((call) => call.groupBy === "none" && call.groupIssueId === undefined)).toBe(true);
    expect(
      (await read("library", { filters: { starred: true } })).artifacts.map(
        (a) => a.id,
      ),
    ).toEqual(["attachment:129"]);
  });

  it("saved metadata survives a real database close and reopen", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "artifact-library-persistence-"),
    );
    let persistent: PGlite | undefined;
    try {
      persistent = new PGlite(directory);
      await initialize(persistent);
      await persistent.query("INSERT INTO public.companies VALUES ($1)", [
        COMPANY,
      ]);
      await persistent.query(
        `INSERT INTO ${schema}.artifact_metadata(company_id, artifact_id, starred) VALUES ($1, $2, true)`,
        [COMPANY, artifact().id],
      );
      await persistent.close();
      persistent = new PGlite(directory);
      const result = await persistent.query<{ starred: boolean }>(
        `SELECT starred FROM ${schema}.artifact_metadata WHERE company_id = $1 AND artifact_id = $2`,
        [COMPANY, artifact().id],
      );
      expect(result.rows).toEqual([{ starred: true }]);
    } finally {
      await persistent?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
