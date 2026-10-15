import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { createMilestone, getMilestone, listMilestones, updateMilestone } from "./milestones.js";
import { parseMilestoneCreate, parseMilestonePatch } from "./milestones-input.js";
import { DashboardError } from "./errors.js";
import { uuid } from "./store-util.js";
import { agentActor, asParams, declaration, guarded, type Serial } from "./tool-helpers.js";

function projectOf(raw: unknown, runCtx: ToolRunContext): string {
  if (raw === undefined || raw === null) {
    if (!runCtx.projectId) throw new DashboardError("projectId: a project UUID is required outside project runs");
    return runCtx.projectId;
  }
  return uuid(raw, "projectId");
}

export function registerMilestoneTools(ctx: PluginContext, serial: Serial): void {
  ctx.tools.register("create_milestone", declaration("create_milestone"), (raw, runCtx) =>
    guarded(() => serial(runCtx.companyId, async () => {
      const params = asParams(raw);
      const record = await createMilestone(ctx, {
        companyId: runCtx.companyId, projectId: projectOf(params.projectId, runCtx),
        fields: parseMilestoneCreate(params, ["projectId"]), actor: agentActor(runCtx),
      });
      return { content: `Created milestone "${record.title}" (revision ${record.revision}) in ${record.projectName}.`, data: record };
    })),
  );

  ctx.tools.register("list_milestones", declaration("list_milestones"), (raw, runCtx) =>
    guarded(async () => {
      const params = asParams(raw);
      const records = await listMilestones(ctx, runCtx.companyId,
        params.projectId === undefined ? runCtx.projectId ?? undefined : uuid(params.projectId, "projectId"));
      return {
        content: records.length
          ? records.map((record) => `- ${record.title}: ${record.status} ${record.progress}% (revision ${record.revision}, id ${record.id})`).join("\n")
          : "No milestones in this scope.",
        data: records,
      };
    }),
  );

  ctx.tools.register("get_milestone", declaration("get_milestone"), (raw, runCtx) =>
    guarded(async () => {
      const id = uuid(asParams(raw).milestoneId, "milestoneId");
      const record = await getMilestone(ctx, runCtx.companyId, id);
      if (!record) throw new DashboardError("Milestone not found in this company");
      return { content: `${record.title}: ${record.progress}% progress; ${record.blockers.length ? record.blockers.join("; ") : "ready to complete"}. Revision ${record.revision}.`, data: record };
    }),
  );

  ctx.tools.register("update_milestone", declaration("update_milestone"), (raw, runCtx) =>
    guarded(() => serial(runCtx.companyId, async () => {
      const params = asParams(raw);
      const record = await updateMilestone(ctx, {
        companyId: runCtx.companyId, milestoneId: uuid(params.milestoneId, "milestoneId"),
        patch: parseMilestonePatch(params, ["milestoneId"]), actor: agentActor(runCtx),
      });
      return { content: `Updated "${record.title}" to ${record.status} (revision ${record.revision}).`, data: record };
    })),
  );
}
