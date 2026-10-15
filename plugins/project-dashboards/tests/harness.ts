import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginApiRequestInput, PluginApiResponse, PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { DATABASE_NAMESPACE } from "../src/manifest.js";
import plugin from "../src/worker.js";

export const COMPANY = "11111111-1111-4111-8111-111111111111";
export const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
export const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OTHER_PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const SECOND_PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const ARCHIVED_PROJECT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const EXPLODING_PROJECT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const AGENT = "44444444-4444-4444-8444-444444444444";

const migrationsDir = new URL("../migrations/", import.meta.url);
/** Every migration of the plugin, in the order the host applies them. */
export const migrations = await Promise.all(
  (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFile(new URL(name, migrationsDir), "utf8")),
);

/** A loosely typed issue as the host delivers it (dates arrive as strings despite the Date type). */
export type IssueSeed = Record<string, unknown>;

export function issue(overrides: IssueSeed = {}): IssueSeed {
  return {
    id: randomUUID(),
    companyId: COMPANY,
    projectId: PROJECT,
    parentId: null,
    title: "Ship checkout",
    status: "done",
    identifier: "ACME-1",
    originKind: "manual",
    hiddenAt: null,
    completedAt: "2026-10-10T15:00:00.000Z",
    ...overrides,
  };
}

/**
 * The host validates plugin SQL before running it. This mirrors the rules that matter here
 * (one statement, a mutation-only execute, a read-only query, every parameter referenced) so a
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
  if ([...used].some((index) => index > params.length)) {
    throw new Error("SQL placeholder has no matching parameter");
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
}

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
  /** Issues the fake host knows; ctx.issues.get/list read from here. */
  issues: Map<string, IssueSeed>;
  issueCalls: { get: string[]; list: Record<string, unknown>[] };
  /** Every statement ctx.db.execute ran, in order. */
  executed: { sql: string; params: unknown[] }[];
  faults: { issueGet: boolean; advanceRevisionBeforeCompletion: boolean };
  /** Deliver a host domain event to the handlers the worker subscribed with ctx.events.on. */
  emit(eventType: string, entityId: string, companyId?: string): Promise<void>;
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
  for (const migration of migrations) {
    await db.exec(migration);
  }
  await db.exec(
    `INSERT INTO public.companies VALUES ('${COMPANY}'), ('${OTHER_COMPANY}');
     INSERT INTO public.projects VALUES ('${PROJECT}', '${COMPANY}', 'Acme Web App'), ('${SECOND_PROJECT}', '${COMPANY}', 'Internal Tools'), ('${OTHER_PROJECT}', '${OTHER_COMPANY}', 'Other Co Project'), ('${ARCHIVED_PROJECT}', '${COMPANY}', 'Old Project');`,
  );
  const dataHandlers = new Map<string, Handler>();
  const actionHandlers = new Map<string, Handler>();
  const toolHandlers = new Map<string, ToolHandler>();
  const activity: Harness["activity"] = [];
  const config: Harness["config"] = {};
  const errors: string[] = [];
  const companyLookups: string[] = [];
  const projects = new Map([
    [PROJECT, { companyId: COMPANY, name: "Acme Web App" }],
    [SECOND_PROJECT, { companyId: COMPANY, name: "Internal Tools" }],
    [OTHER_PROJECT, { companyId: OTHER_COMPANY, name: "Other Co Project" }],
    [ARCHIVED_PROJECT, { companyId: COMPANY, name: "Old Project" }],
  ]);
  const eventHandlers = new Map<string, ((event: unknown) => Promise<void>)[]>();
  const issues = new Map<string, IssueSeed>();
  const issueCalls: Harness["issueCalls"] = { get: [], list: [] };
  const faults = { issueGet: false, advanceRevisionBeforeCompletion: false };
  const executed: Harness["executed"] = [];
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
        executed.push({ sql, params });
        // Simulate an out-of-band writer racing between read and closing UPDATE.
        if (faults.advanceRevisionBeforeCompletion && sql.includes("WITH changed AS")) {
          faults.advanceRevisionBeforeCompletion = false;
          await db.query(
            `UPDATE ${DATABASE_NAMESPACE}.milestones SET revision=revision+1 WHERE company_id=$1 AND id=$2`,
            [params[0], params[1]],
          );
        }
        return { rowCount: (await db.query(sql, params)).affectedRows ?? 0 };
      },
    },
    config: { get: async (companyId?: string) => config[companyId ?? ""] ?? {} },
    projects: {
      get: async (id: string, companyId: string) => {
        if (id === EXPLODING_PROJECT) {
          throw new Error("boom: select * from secrets");
        }
        const project = projects.get(id);
        if (project?.companyId !== companyId) {
          return null;
        }
        return {
          id,
          name: project.name,
          urlKey: project.name.toLowerCase().replaceAll(" ", "-"),
          archivedAt: id === ARCHIVED_PROJECT ? "2026-01-01T00:00:00Z" : null,
        };
      },
      list: async (input: { companyId: string; limit?: number }) =>
        [...projects]
          .filter(([, project]) => project.companyId === input.companyId)
          .map(([id, project]) => ({ id, name: project.name }))
          .slice(0, input.limit),
    },
    issues: {
      get: async (id: string, companyId: string) => {
        issueCalls.get.push(id);
        if (faults.issueGet) {
          throw new Error("host unavailable: select * from issues");
        }
        const found = issues.get(id);
        return found && found.companyId === companyId ? found : null;
      },
      list: async (input: Record<string, unknown>) => {
        issueCalls.list.push(input);
        return [...issues.values()].filter(
          (found) =>
            found.companyId === input.companyId &&
            (input.projectId === undefined || found.projectId === input.projectId) &&
            (input.status === undefined || found.status === input.status),
        ).slice(0, typeof input.limit === "number" ? input.limit : undefined);
      },
    },
    events: {
      on: (name: string, fn: (event: unknown) => Promise<void>) => {
        eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), fn]);
        return () => {};
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
    issues,
    issueCalls,
    executed,
    faults,
    emit: async (eventType, entityId, companyId = COMPANY) => {
      const event = { eventId: randomUUID(), eventType, occurredAt: new Date().toISOString(), entityId, entityType: "issue", companyId, payload: {} };
      for (const handler of eventHandlers.get(eventType) ?? []) {
        await handler(event);
      }
    },
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
