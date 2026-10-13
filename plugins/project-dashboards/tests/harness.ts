import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginApiRequestInput, PluginApiResponse, PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { DATABASE_NAMESPACE } from "../src/manifest.js";
import plugin from "../src/worker.js";

export const COMPANY = "11111111-1111-4111-8111-111111111111";
export const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
export const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OTHER_PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const SECOND_PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const EXPLODING_PROJECT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const AGENT = "44444444-4444-4444-8444-444444444444";

export const migration = await readFile(new URL("../migrations/001_project_dashboards.sql", import.meta.url), "utf8");

type Handler = (params: Record<string, unknown>, context?: unknown) => Promise<unknown>;
type ToolHandler = (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>;

export interface ApiCall {
  method?: string;
  params?: Record<string, string>;
  query?: Record<string, string | string[]>;
  body?: unknown;
  companyId?: string;
  actor?: PluginApiRequestInput["actor"];
}

export interface Harness {
  db: PGlite;
  activity: { message: string; entityType?: string }[];
  config: Record<string, Record<string, unknown>>;
  errors: string[];
  companyLookups: string[];
  api(routeKey: string, input?: ApiCall): Promise<PluginApiResponse>;
  data(key: string, params: Record<string, unknown>): Promise<unknown>;
  action(key: string, params: Record<string, unknown>, actor?: { type: "user" | "agent" | "system"; userId: string | null; agentId: string | null }, companyId?: string): Promise<unknown>;
  tool(name: string, params: unknown, run?: Partial<ToolRunContext>): Promise<ToolResult>;
}

export async function createHarness(): Promise<Harness> {
  const db = new PGlite();
  await db.exec(
    `CREATE TABLE public.companies (id uuid PRIMARY KEY);
     CREATE TABLE public.projects (id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL);
     CREATE SCHEMA ${DATABASE_NAMESPACE};`,
  );
  await db.exec(migration);
  await db.exec(
    `INSERT INTO public.companies VALUES ('${COMPANY}'), ('${OTHER_COMPANY}');
     INSERT INTO public.projects VALUES ('${PROJECT}', '${COMPANY}', 'Acme Web App'), ('${SECOND_PROJECT}', '${COMPANY}', 'Internal Tools'), ('${OTHER_PROJECT}', '${OTHER_COMPANY}', 'Other Co Project');`,
  );
  const dataHandlers = new Map<string, Handler>();
  const actionHandlers = new Map<string, Handler>();
  const toolHandlers = new Map<string, ToolHandler>();
  const activity: Harness["activity"] = [];
  const config: Harness["config"] = {};
  const errors: string[] = [];
  const companyLookups: string[] = [];
  const projects = new Map([
    [PROJECT, COMPANY],
    [SECOND_PROJECT, COMPANY],
    [OTHER_PROJECT, OTHER_COMPANY],
  ]);
  // The worker only touches this subset of the host context; the cast is confined to the test double.
  const ctx = {
    db: {
      namespace: DATABASE_NAMESPACE,
      query: async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows,
      execute: async (sql: string, params: unknown[] = []) => ({ rowCount: (await db.query(sql, params)).affectedRows ?? 0 }),
    },
    config: { get: async (companyId?: string) => config[companyId ?? ""] ?? {} },
    projects: {
      get: async (id: string, companyId: string) => {
        if (id === EXPLODING_PROJECT) {
          throw new Error("boom: select * from secrets");
        }
        return projects.get(id) === companyId ? { id } : null;
      },
    },
    companies: {
      get: async (id: string) => {
        companyLookups.push(id);
        return id === COMPANY ? { id, issuePrefix: "acme" } : id === OTHER_COMPANY ? { id, issuePrefix: "BETA" } : null;
      },
    },
    logger: { error: (message: string, meta?: { error?: string }) => void errors.push(`${message}: ${meta?.error ?? ""}`) },
    agents: { get: async (id: string) => (id === AGENT ? { id, name: "Tracker" } : null) },
    activity: { log: async (entry: { message: string; entityType?: string }) => void activity.push(entry) },
    data: { register: (key: string, handler: Handler) => void dataHandlers.set(key, handler) },
    actions: { register: (key: string, handler: Handler) => void actionHandlers.set(key, handler) },
    tools: { register: (name: string, _decl: unknown, handler: ToolHandler) => void toolHandlers.set(name, handler) },
  } as unknown as PluginContext;
  await plugin.definition.setup(ctx);
  return {
    db,
    activity,
    config,
    errors,
    companyLookups,
    api: (routeKey, call = {}) =>
      plugin.definition.onApiRequest!({
        routeKey,
        method: call.method ?? "GET",
        path: "/",
        params: call.params ?? {},
        query: call.query ?? { companyId: call.companyId ?? COMPANY },
        body: call.body,
        actor: call.actor ?? { actorType: "user", actorId: "board-user-1", userId: "board-user-1" },
        companyId: call.companyId ?? COMPANY,
        headers: {},
      }),
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
      return handler(params, { agentId: AGENT, runId: "run-1", companyId: COMPANY, projectId: PROJECT, ...run });
    },
  };
}
