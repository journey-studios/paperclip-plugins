import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import plugin, { withEvolutionDatabaseNamespace } from "../src/worker.js";

export const COMPANY = "11111111-1111-4111-8111-111111111111";
export const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
export const AGENT = "44444444-4444-4444-8444-444444444444";
export const SKILL = "55555555-5555-4555-8555-555555555555";
export const NS = "plugin_evolution_4399b11512";
export type Handler = (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>;
export type EventHandler = (event: Record<string, unknown>) => Promise<void>;
type NativeHostValidators = {
  validatePluginMigrationStatement(statement: string, namespace: string, coreReadTables: readonly string[]): void;
  validatePluginRuntimeQuery(statement: string, namespace: string, coreReadTables: readonly string[]): void;
  validatePluginRuntimeExecute(statement: string, namespace: string): void;
};
const CORE_READ_TABLES = [
  "companies", "agents", "issues", "projects", "goals", "heartbeat_runs", "cost_events",
  "activity_log", "agent_config_revisions", "company_skills", "company_skill_versions",
];
let hostValidatorsPromise: Promise<NativeHostValidators | null> | undefined;

async function nativeHostValidators(): Promise<NativeHostValidators | null> {
  if (!process.env.PAPERCLIP_NATIVE_SQL_VALIDATION) return null;
  hostValidatorsPromise ??= import("../../../.paperclip/server/src/services/plugin-database.js") as Promise<NativeHostValidators>;
  return hostValidatorsPromise;
}

const migration001 = await readFile(new URL("../migrations/001_evolution.sql", import.meta.url), "utf8");
const migration002 = await readFile(new URL("../migrations/002_evolution_integrity.sql", import.meta.url), "utf8");
const migration003 = await readFile(new URL("../migrations/003_change_item_capture_metadata.sql", import.meta.url), "utf8");
const migration004 = await readFile(new URL("../migrations/004_auto_evidence_assessments.sql", import.meta.url), "utf8");

export async function createWorkerFixture() {
  const validators = await nativeHostValidators();
  const db = new PGlite();
  await db.exec(
    `CREATE TABLE public.companies (id uuid PRIMARY KEY);` +
    `CREATE TABLE public.agents (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id), name text NOT NULL, role text, title text, status text NOT NULL DEFAULT 'active', adapter_type text NOT NULL DEFAULT 'test', adapter_config jsonb NOT NULL DEFAULT '{}'::jsonb, runtime_config jsonb NOT NULL DEFAULT '{}'::jsonb, permissions jsonb NOT NULL DEFAULT '{}'::jsonb, capabilities jsonb NOT NULL DEFAULT '{}'::jsonb, default_environment_id uuid, budget_monthly_cents integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());` +
    `CREATE TABLE public.goals (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id), title text NOT NULL);` +
    `CREATE TABLE public.projects (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id), name text NOT NULL, goal_id uuid);` +
    `CREATE TABLE public.issues (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id), identifier text, title text NOT NULL, project_id uuid, goal_id uuid);` +
    `CREATE TABLE public.heartbeat_runs (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id), agent_id uuid NOT NULL, status text NOT NULL, started_at timestamptz NOT NULL, finished_at timestamptz, invocation_source text, native_issue_id uuid, context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb);` +
    `CREATE TABLE public.cost_events (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id), agent_id uuid NOT NULL, occurred_at timestamptz NOT NULL, cost_cents numeric NOT NULL DEFAULT 0, cost_status text NOT NULL DEFAULT 'reported', input_tokens numeric NOT NULL DEFAULT 0, cached_input_tokens numeric NOT NULL DEFAULT 0, output_tokens numeric NOT NULL DEFAULT 0);` +
    `CREATE TABLE public.agent_config_revisions (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id), agent_id uuid NOT NULL REFERENCES public.agents(id), changed_keys jsonb NOT NULL DEFAULT '[]'::jsonb, before_config jsonb NOT NULL DEFAULT '{}'::jsonb, after_config jsonb NOT NULL DEFAULT '{}'::jsonb, created_by_agent_id uuid, created_by_user_id text, created_at timestamptz NOT NULL DEFAULT now());` +
    `CREATE TABLE public.company_skills (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id), key text NOT NULL, slug text NOT NULL, name text NOT NULL, description text, markdown text NOT NULL DEFAULT '', source_type text NOT NULL DEFAULT 'managed', source_ref text, compatibility text NOT NULL DEFAULT 'all', categories text[] NOT NULL DEFAULT '{}', current_version_id uuid, updated_at timestamptz NOT NULL DEFAULT now());` +
    `CREATE TABLE public.company_skill_versions (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id), company_skill_id uuid NOT NULL REFERENCES public.company_skills(id), revision_number integer NOT NULL, file_inventory jsonb NOT NULL DEFAULT '[]'::jsonb, author_agent_id uuid, author_user_id text, created_at timestamptz NOT NULL DEFAULT now());` +
    `CREATE TABLE public.activity_log (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id), actor_type text NOT NULL, actor_id text NOT NULL, action text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL, agent_id uuid, run_id uuid, details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());` +
    `INSERT INTO public.companies VALUES ('${COMPANY}'), ('${OTHER_COMPANY}');` +
    `CREATE SCHEMA ${NS};`,
  );
  for (const migration of [migration001, migration002, migration003, migration004]) {
    for (const statement of migration.split(";").map((part) => part.trim()).filter(Boolean)) {
      validators?.validatePluginMigrationStatement(statement, NS, CORE_READ_TABLES);
    }
  }
  await db.exec(migration001);
  await db.exec(migration002);
  await db.exec(migration003);
  await db.exec(migration004);

  const actions = new Map<string, Handler>();
  const data = new Map<string, Handler>();
  const events = new Map<string, EventHandler>();
  const jobs = new Map<string, (job: Record<string, unknown>) => Promise<void>>();
  const tools = new Map<string, (params: unknown, ctx: { agentId: string; runId: string; companyId: string; projectId: string }) => Promise<unknown>>();
  const logs: string[] = [];
  const ctx = {
    db: {
      namespace: NS,
      query: async (sql: string, params: unknown[] = []) => {
        logs.push(sql);
        if (params.some(Array.isArray)) throw new Error("Host SQL binder expands JavaScript array parameters");
        validators?.validatePluginRuntimeQuery(sql, NS, CORE_READ_TABLES);
        return (await db.query<Record<string, unknown>>(sql, params)).rows;
      },
      execute: async (sql: string, params: unknown[] = []) => {
        logs.push(sql);
        if (params.some(Array.isArray)) throw new Error("Host SQL binder expands JavaScript array parameters");
        validators?.validatePluginRuntimeExecute(sql, NS);
        return { rowCount: (await db.query(sql, params)).affectedRows ?? 0 };
      },
    },
    data: { register: (key: string, handler: Handler) => data.set(key, handler) },
    actions: { register: (key: string, handler: Handler) => actions.set(key, handler) },
    events: { on: (key: string, handler: EventHandler) => events.set(key, handler) },
    jobs: { register: (key: string, handler: (job: Record<string, unknown>) => Promise<void>) => jobs.set(key, handler) },
    tools: { register: (key: string, _declaration: unknown, handler: (params: unknown, ctx: { agentId: string; runId: string; companyId: string; projectId: string }) => Promise<unknown>) => tools.set(key, handler) },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as PluginContext;
  await plugin.definition.setup!(ctx);
  const workerCtx = withEvolutionDatabaseNamespace(ctx);

  const actorContext: PluginPerformActionContext = {
    actor: { type: "user", userId: "test-user", agentId: null, runId: null, companyId: COMPANY },
    companyId: COMPANY,
  };
  return {
    db,
    actions,
    data,
    events,
    jobs,
    tools,
    logs,
    workerCtx,
    actorContext,
    action<T = Record<string, unknown>>(key: string, params: Record<string, unknown> = {}, context = actorContext): Promise<T> {
      return actions.get(key)!({ companyId: COMPANY, ...params }, context) as Promise<T>;
    },
    close: () => db.close(),
  };
}
