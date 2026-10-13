import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { addEntry, listChangelog, updateEntry } from "./changelog.js";
import { parseEntryPatch, parseNewEntry } from "./changelog-input.js";
import type { ChangelogEntry } from "./contracts.js";
import { DashboardError } from "./errors.js";
import { uuid } from "./store-util.js";
import { agentActor, asParams, declaration, guarded, type Serial } from "./tool-helpers.js";

/** Omitted projectId follows the run's project, like a new dashboard does. */
function projectOf(value: unknown, runCtx: ToolRunContext): string {
  if (value === undefined || value === null) {
    if (!runCtx.projectId) {
      throw new DashboardError("projectId: is required because this run has no current project");
    }
    return runCtx.projectId;
  }
  return uuid(value, "projectId");
}

function line(entry: ChangelogEntry): string {
  const version = entry.version ? ` (${entry.version})` : "";
  const project = entry.projectName ? ` - ${entry.projectName}` : "";
  return `- ${entry.occurredAt.slice(0, 10)} [${entry.kind}] ${entry.title}${version}${project} (id ${entry.id})`;
}

export function registerChangelogTools(ctx: PluginContext, serial: Serial): void {
  ctx.tools.register("add_changelog_entry", declaration("add_changelog_entry"), (raw, runCtx) =>
    guarded(() =>
      serial(runCtx.companyId, async () => {
        const params = asParams(raw);
        const fields = parseNewEntry(params, ["projectId"], new Date());
        const entry = await addEntry(ctx, {
          companyId: runCtx.companyId,
          projectId: projectOf(params.projectId, runCtx),
          fields,
          actor: agentActor(runCtx),
        });
        return {
          content: `Added ${entry.kind} entry "${entry.title}" to the changelog${entry.projectName ? ` of project ${entry.projectName}` : ""}.`,
          data: entry,
        };
      }),
    ),
  );

  ctx.tools.register("list_changelog", declaration("list_changelog"), (raw, runCtx) =>
    guarded(async () => {
      const page = await listChangelog(ctx, runCtx.companyId, asParams(raw));
      const more = page.nextCursor ? "; more available, pass nextCursor as before" : "";
      return {
        content:
          page.entries.length > 0
            ? `${page.entries.length} changelog entries, newest first${more}:\n${page.entries.map(line).join("\n")}`
            : "No changelog entries.",
        data: page,
      };
    }),
  );

  ctx.tools.register("update_changelog_entry", declaration("update_changelog_entry"), (raw, runCtx) =>
    guarded(() =>
      serial(runCtx.companyId, async () => {
        const params = asParams(raw);
        const patch = parseEntryPatch(params, ["entryId"]);
        const entry = await updateEntry(ctx, {
          companyId: runCtx.companyId,
          entryId: params.entryId,
          patch,
          actor: agentActor(runCtx),
        });
        return { content: `Updated changelog entry "${entry.title}" (${entry.kind}).`, data: entry };
      }),
    ),
  );
}
