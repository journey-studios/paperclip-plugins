import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginApiRequestInput, PluginApiResponse, PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { DATABASE_NAMESPACE } from "../src/manifest.js";
import plugin from "../src/worker.js";

export const COMPANY = "11111111-1111-4111-8111-111111111111";
export const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
export const AGENT = "44444444-4444-4444-8444-444444444444";

/** Projects the fake host knows; ids are readable so failures name the project. */
export const P = {
  platform: "a0000000-0000-4000-8000-000000000001",
  api: "a0000000-0000-4000-8000-000000000002",
  billing: "a0000000-0000-4000-8000-000000000003",
  growth: "a0000000-0000-4000-8000-000000000004",
  archived: "a0000000-0000-4000-8000-000000000005",
  foreign: "b0000000-0000-4000-8000-000000000001",
} as const;

interface FakeProject {
  id: string;
  companyId: string;
  name: string;
  archivedAt: string | null;
}

const migrationsDir = new URL("../migrations/", import.meta.url);
/** Every migration of the plugin, in the order the host applies them. */
export const migrations = await Promise.all(
  (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFile(new URL(name, migrationsDir), "utf8")),
);

/**
 * Mirrors the host's runtime SQL rules that matter here (one statement,
 * read-only query, namespace-only mutation, every parameter referenced) so a
 * statement the real host would refuse fails the tests too.
 */
function assertHostAccepts(mode: "query" | "execute", sql: string, params: unknown[]): void {
  const text = sql.replace(/'([^']|'')*'/g, "''").replace(/\s+/g, " ").trim().toLowerCase();
  if (text.replace(/;$/, "").includes(";")) {
    throw new Error("Plugin runtime SQL must contain exactly one statement");
  }
  const used = new Set([...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));
  for (let index = 1; index <= params.length; index += 1) {
    if (!used.has(index)) {
      throw new Error("Every ctx.db parameter must be referenced by a $n placeholder");
    }
  }
  if (mode === "query") {
    if (!/^(select|with) /.test(text) || /\b(insert|update|delete|alter|create|drop|truncate)\b/.test(text)) {
      throw new Error("ctx.db.query only allows SELECT statements");
    }
    return;
  }
  if (!/^(insert into|update|delete from|with) /.test(text) || /\b(alter|create|drop|truncate)\b/.test(text) || /\bpublic\./.test(text)) {
    throw new Error("ctx.db.execute only allows INSERT, UPDATE, DELETE or namespace-scoped mutation CTEs");
  }
  if (!text.includes(`${DATABASE_NAMESPACE}.`)) {
    throw new Error("ctx.db.execute must target the plugin namespace");
  }
}

type Handler = (params: Record<string, unknown>, context?: unknown) => Promise<unknown>;
type ToolHandler = (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>;
type ActionActor = { type: "user" | "agent" | "system"; userId: string | null; agentId: string | null };

export interface Harness {
  db: PGlite;
  projects: Map<string, FakeProject>;
  activity: { companyId: string; message: string; entityId?: string; metadata?: Record<string, unknown> }[];
  addProject(project: Omit<FakeProject, "archivedAt"> & { archivedAt?: string | null }): Promise<void>;
  /** Delete a project the way core does: the row goes, plugin FKs cascade. */
  deleteProject(id: string): Promise<void>;
  data(key: string, params: Record<string, unknown>): Promise<unknown>;
  action(key: string, params: Record<string, unknown>, actor?: ActionActor, companyId?: string): Promise<unknown>;
  tool(name: string, params: unknown, run?: Partial<ToolRunContext>): Promise<ToolResult>;
  api(routeKey: string, input?: { params?: Record<string, string>; body?: unknown; companyId?: string; actor?: PluginApiRequestInput["actor"] }): Promise<PluginApiResponse>;
}

export async function createHarness(): Promise<Harness> {
  const db = new PGlite();
  await db.exec(
    `CREATE TABLE public.companies (id uuid PRIMARY KEY);
     CREATE TABLE public.projects (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id), name text NOT NULL);
     CREATE SCHEMA ${DATABASE_NAMESPACE};
     INSERT INTO public.companies VALUES ('${COMPANY}'), ('${OTHER_COMPANY}');`,
  );
  for (const migration of migrations) {
    await db.exec(migration);
  }

  const projects = new Map<string, FakeProject>();
  const activity: Harness["activity"] = [];
  const dataHandlers = new Map<string, Handler>();
  const actionHandlers = new Map<string, Handler>();
  const toolHandlers = new Map<string, ToolHandler>();

  const addProject: Harness["addProject"] = async (project) => {
    projects.set(project.id, { archivedAt: null, ...project });
    await db.query("INSERT INTO public.projects VALUES ($1, $2, $3)", [project.id, project.companyId, project.name]);
  };

  const view = (project: FakeProject) => ({
    id: project.id,
    companyId: project.companyId,
    name: project.name,
    urlKey: project.name.toLowerCase().replaceAll(" ", "-"),
    status: "in_progress",
    color: null,
    archivedAt: project.archivedAt,
  });

  // The worker only touches this subset of the host context; the cast is confined to the test double.
  const ctx = {
    db: {
      namespace: DATABASE_NAMESPACE,
      query: async (sql: string, params: unknown[] = []) => {
        assertHostAccepts("query", sql, params);
        return (await db.query<Record<string, unknown>>(sql, params)).rows;
      },
      execute: async (sql: string, params: unknown[] = []) => {
        assertHostAccepts("execute", sql, params);
        return { rowCount: (await db.query(sql, params)).affectedRows ?? 0 };
      },
    },
    projects: {
      get: async (id: string, companyId: string) => {
        const project = projects.get(id);
        return project && project.companyId === companyId ? view(project) : null;
      },
      list: async (input: { companyId: string }) =>
        [...projects.values()].filter((project) => project.companyId === input.companyId).map(view),
    },
    activity: { log: async (entry: Harness["activity"][number]) => void activity.push(entry) },
    logger: { error: () => {}, info: () => {}, warn: () => {} },
    data: { register: (key: string, handler: Handler) => void dataHandlers.set(key, handler) },
    actions: { register: (key: string, handler: Handler) => void actionHandlers.set(key, handler) },
    tools: { register: (name: string, _decl: unknown, handler: ToolHandler) => void toolHandlers.set(name, handler) },
  } as unknown as PluginContext;
  await plugin.definition.setup(ctx);

  await addProject({ id: P.platform, companyId: COMPANY, name: "Platform" });
  await addProject({ id: P.api, companyId: COMPANY, name: "Platform API" });
  await addProject({ id: P.billing, companyId: COMPANY, name: "Billing" });
  await addProject({ id: P.growth, companyId: COMPANY, name: "Growth" });
  await addProject({ id: P.archived, companyId: COMPANY, name: "Old Site", archivedAt: "2026-01-01T00:00:00Z" });
  await addProject({ id: P.foreign, companyId: OTHER_COMPANY, name: "Other Co Project" });

  return {
    db,
    projects,
    activity,
    addProject,
    deleteProject: async (id) => {
      projects.delete(id);
      await db.query("DELETE FROM public.projects WHERE id = $1", [id]);
    },
    data: (key, params) => {
      const handler = dataHandlers.get(key);
      if (!handler) {
        throw new Error(`no data handler ${key}`);
      }
      return handler(params);
    },
    action: (key, params, actor = { type: "user", userId: "user-1", agentId: null }, companyId = COMPANY) => {
      const handler = actionHandlers.get(key);
      if (!handler) {
        throw new Error(`no action ${key}`);
      }
      return handler(params, { actor: { ...actor, runId: null, companyId }, companyId });
    },
    tool: (name, params, run = {}) => {
      const handler = toolHandlers.get(name);
      if (!handler) {
        throw new Error(`no tool ${name}`);
      }
      return handler(params, { agentId: AGENT, runId: "run-1", companyId: COMPANY, projectId: P.platform, ...run });
    },
    api: (routeKey, call = {}) =>
      plugin.definition.onApiRequest!({
        routeKey,
        method: "GET",
        path: "/",
        params: call.params ?? {},
        query: { companyId: call.companyId ?? COMPANY },
        body: call.body,
        actor: call.actor ?? { actorType: "user", actorId: "board-user-1", userId: "board-user-1" },
        companyId: call.companyId ?? COMPANY,
        headers: {},
      }),
  };
}
