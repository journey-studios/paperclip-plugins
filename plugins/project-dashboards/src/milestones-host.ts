import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createMilestone, getMilestone, listMilestones, updateMilestone } from "./milestones.js";
import { parseMilestoneCreate, parseMilestonePatch } from "./milestones-input.js";
import { uuid } from "./store-util.js";
import { actionActor, type Serial } from "./tool-helpers.js";

export function registerMilestoneHost(ctx: PluginContext, serial: Serial): void {
  ctx.data.register("milestones.list", (params) =>
    listMilestones(ctx, uuid(params.companyId, "companyId"), params.projectId),
  );
  ctx.data.register("milestone.get", (params) =>
    getMilestone(ctx, uuid(params.companyId, "companyId"), params.milestoneId),
  );
  ctx.data.register("milestones.projectIssues", async (params) => {
    const companyId = uuid(params.companyId, "companyId");
    const projectId = uuid(params.projectId, "projectId");
    const records = await ctx.issues.list({ companyId, projectId, limit: 500 });
    return records.map((issue) => ({ id: issue.id, identifier: issue.identifier, title: issue.title, status: issue.status }))
      .sort((a, b) => a.identifier.localeCompare(b.identifier));
  });
  ctx.actions.register("milestone.create", (params, context) => {
    const companyId = uuid(context.companyId ?? params.companyId, "companyId");
    const fields = parseMilestoneCreate(params, ["companyId", "projectId"]);
    return serial(companyId, () => createMilestone(ctx, {
      companyId, projectId: uuid(params.projectId, "projectId"), fields, actor: actionActor(context),
    }));
  });
  ctx.actions.register("milestone.update", (params, context) => {
    const companyId = uuid(context.companyId ?? params.companyId, "companyId");
    const patch = parseMilestonePatch(params, ["companyId", "milestoneId"]);
    return serial(companyId, () => updateMilestone(ctx, {
      companyId, milestoneId: uuid(params.milestoneId, "milestoneId"), patch, actor: actionActor(context),
    }));
  });
}
