import type { PluginContext, Project } from "@paperclipai/plugin-sdk";
import type { Actor, DashboardSettings } from "./contracts.js";
import { DashboardError } from "./errors.js";
import { normalizeSettings } from "./settings.js";

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !GUID.test(value)) {
    throw new DashboardError(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

export async function getSettings(ctx: PluginContext, companyId: string): Promise<DashboardSettings> {
  return normalizeSettings(await ctx.config.get(companyId));
}

/** The project in this company, or a user-correctable error. */
export async function requireProject(ctx: PluginContext, companyId: string, projectId: string): Promise<Project> {
  const project = await ctx.projects.get(projectId, companyId);
  if (!project) {
    throw new DashboardError("Project not found in this company");
  }
  return project;
}

/** Qualified, validated name of one of the plugin's own tables. */
export function table(ctx: PluginContext, key: "dashboards" | "dashboard_revisions" | "changelog_entries"): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) {
    throw new Error("Invalid plugin database namespace");
  }
  return `${ctx.db.namespace}.${key}`;
}

export function iso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

/** Like iso, but null for missing or unparseable values (host dates arrive as strings despite their Date type). */
export function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Display names for the agents among the given actors; a missing name never breaks listing. */
export async function agentNames(
  ctx: PluginContext,
  companyId: string,
  actors: readonly Pick<Actor, "kind" | "id">[],
): Promise<Map<string, string>> {
  const ids = [...new Set(actors.filter((actor) => actor.kind === "agent" && actor.id).map((actor) => String(actor.id)))];
  const names = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const agent = GUID.test(id) ? await ctx.agents.get(id, companyId) : null;
        if (agent) {
          names.set(id, agent.name);
        }
      } catch {
        // A missing name must never break listing.
      }
    }),
  );
  return names;
}

/**
 * Paperclip owns one worker process per installed plugin. Serializing company
 * mutations keeps the read-modify-write revision bump race-free.
 */
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
