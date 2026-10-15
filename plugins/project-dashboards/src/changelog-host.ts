import type { PluginContext } from "@paperclipai/plugin-sdk";
import { deleteEntry, listChangelog } from "./changelog.js";
import { createIssueCapture, importDoneIssues } from "./changelog-issues.js";
import type { ProjectOption } from "./contracts.js";
import { getSettings, uuid } from "./store-util.js";
import { actionActor, type Serial } from "./tool-helpers.js";

const PROJECT_OPTIONS_LIMIT = 500;

/** Host-facing side of the changelog: issue events, the UI's data and the board actions. */
export function registerChangelogHost(ctx: PluginContext, serial: Serial): void {
  ctx.events.on("issue.updated", createIssueCapture(ctx));

  ctx.data.register("changelog.list", async (params) => listChangelog(ctx, uuid(params.companyId, "companyId"), params));
  ctx.data.register("projects.list", async (params): Promise<ProjectOption[]> => {
    const projects = await ctx.projects.list({ companyId: uuid(params.companyId, "companyId"), limit: PROJECT_OPTIONS_LIMIT });
    return projects.map((project) => ({ id: project.id, name: project.name })).sort((a, b) => a.name.localeCompare(b.name));
  });

  ctx.actions.register("changelog.delete", async (params, context) => {
    const companyId = uuid(context.companyId, "companyId");
    return serial(companyId, () => deleteEntry(ctx, { companyId, entryId: params.id, actor: actionActor(context) }));
  });
  ctx.actions.register("changelog.importIssues", async (params, context) => {
    const companyId = uuid(context.companyId, "companyId");
    return serial(companyId, async () =>
      importDoneIssues(ctx, {
        companyId,
        projectId: params.projectId,
        settings: await getSettings(ctx, companyId),
        actor: actionActor(context),
      }),
    );
  });
}
