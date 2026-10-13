import { randomUUID } from "node:crypto";
import type { Issue, PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { insertEntries, type NewRow } from "./changelog.js";
import { LIMITS } from "./changelog-input.js";
import type { Actor, ChangelogCapture, ChangelogImportResult, DashboardSettings } from "./contracts.js";
import { getSettings, isoOrNull, requireProject, uuid } from "./store-util.js";

export type CaptureMode = Exclude<ChangelogCapture, "off">;

const SYSTEM: Actor = { kind: "system", id: null };
/** The most completed issues one import asks the host for (no offset: the host mishandles offset > 0). */
export const IMPORT_LIMIT = 1000;

/**
 * The one rule deciding which issues reach the changelog, shared by the live capture and the
 * import. Only manually created issues count: routine runs, watchdogs, recoveries and
 * plugin-generated issues are operational noise. Sub-issues are mostly tests and smoke checks,
 * so "top-level" skips them.
 */
export function isChangelogEligible(issue: Issue, mode: CaptureMode): boolean {
  if (issue.status !== "done" || !issue.projectId || issue.hiddenAt) {
    return false;
  }
  if (issue.originKind && issue.originKind !== "manual") {
    return false;
  }
  return mode === "all" || !issue.parentId;
}

/** Code-point safe: never splits a surrogate pair, and the result including the ellipsis fits `max`. */
function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let out = "";
  for (const char of text) {
    if (out.length + char.length > max - 1) {
      break;
    }
    out += char;
  }
  return `${out.trimEnd()}…`;
}

/** The changelog row mirroring a completed issue, or null when the issue has no project. */
export function issueRow(issue: Issue, companyId: string, fallbackAt: string): NewRow | null {
  if (!issue.projectId) {
    return null;
  }
  return {
    id: randomUUID(),
    companyId,
    projectId: issue.projectId,
    kind: "issue",
    title: clip(issue.title.trim(), LIMITS.title) || issue.identifier || "Untitled issue",
    body: null,
    version: null,
    refs: issue.identifier ? [issue.identifier] : [],
    links: [],
    occurredAt: isoOrNull(issue.completedAt) ?? fallbackAt,
    issueId: issue.id,
    actor: SYSTEM,
  };
}

function captureRow(issue: Issue, mode: CaptureMode, companyId: string, fallbackAt: string): NewRow | null {
  return isChangelogEligible(issue, mode) ? issueRow(issue, companyId, fallbackAt) : null;
}

/**
 * Handler for `issue.updated`. The event carries neither the project nor a stable status, so
 * the issue is read back. Delivery is best-effort and may repeat, which the unique issue index
 * absorbs; the handler never throws, because a changelog problem must not disturb the host.
 */
export function createIssueCapture(ctx: PluginContext) {
  return async (event: PluginEvent): Promise<void> => {
    try {
      const settings = await getSettings(ctx, event.companyId);
      if (settings.changelogFromIssues === "off" || !event.entityId) {
        return;
      }
      const issue = await ctx.issues.get(event.entityId, event.companyId);
      if (!issue) {
        return;
      }
      const fallbackAt = isoOrNull(event.occurredAt) ?? new Date().toISOString();
      const row = captureRow(issue, settings.changelogFromIssues, event.companyId, fallbackAt);
      if (row) {
        await insertEntries(ctx, [row]);
      }
    } catch (error) {
      ctx.logger.error("project-dashboards changelog capture failed", {
        eventId: event.eventId,
        issueId: event.entityId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export interface ImportInput {
  companyId: string;
  projectId: unknown;
  settings: DashboardSettings;
  actor: Actor;
}

/**
 * Backfill and reconciliation for one project. Idempotent: issues that already have an entry
 * (live or deleted) are skipped. It is an explicit request, so it runs even when automatic
 * capture is off, using "all" only when the company chose "all".
 */
export async function importDoneIssues(ctx: PluginContext, input: ImportInput): Promise<ChangelogImportResult> {
  const { companyId, actor } = input;
  const projectId = uuid(input.projectId, "projectId");
  const project = await requireProject(ctx, companyId, projectId);
  const issues = await ctx.issues.list({ companyId, projectId, status: "done", limit: IMPORT_LIMIT });
  const mode: CaptureMode = input.settings.changelogFromIssues === "all" ? "all" : "top-level";
  const fallbackAt = new Date().toISOString();
  const rows = issues.flatMap((issue) => {
    const row = captureRow(issue, mode, companyId, fallbackAt);
    return row ? [row] : [];
  });
  const imported = await insertEntries(ctx, rows);
  const result = {
    scanned: issues.length,
    imported,
    skipped: issues.length - imported,
    truncated: issues.length >= IMPORT_LIMIT,
  };
  await ctx.activity.log({
    companyId,
    message: `Imported ${imported} completed issue(s) into the changelog of project "${project.name}" (${result.scanned} scanned)`,
    entityType: "plugin_changelog",
    entityId: projectId,
    metadata: { ...result, actor: actor.kind },
  });
  return result;
}
