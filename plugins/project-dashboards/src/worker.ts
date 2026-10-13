import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { createApi } from "./api.js";
import { registerChangelogHost } from "./changelog-host.js";
import { registerChangelogTools } from "./changelog-tools.js";
import type { DashboardRecord } from "./contracts.js";
import { createLinkResolver } from "./links.js";
import { computeLiveStatus, computeStatus } from "./status.js";
import {
  ProjectError,
  deleteDashboard,
  getDashboard,
  listDashboards,
  listRevisions,
  restoreRevision,
  setDashboardProject,
  slugOf,
  updateDataset,
  upsertDashboard,
  validateDashboardSpec,
} from "./dashboards.js";
import { DashboardError } from "./errors.js";
import { companySerialQueue, getSettings, uuid } from "./store-util.js";
import { actionActor, agentActor, asParams, declaration, guarded } from "./tool-helpers.js";

function describe(record: DashboardRecord): string {
  const datasets = record.spec ? Object.keys(record.spec.datasets).length : 0;
  const sections = record.spec ? record.spec.sections.length : 0;
  return `"${record.slug}" revision ${record.revision}: ${datasets} dataset(s), ${sections} section(s)`;
}

function registerTools(
  ctx: PluginContext,
  serial: ReturnType<typeof companySerialQueue>,
  links: ReturnType<typeof createLinkResolver>,
): void {
  ctx.tools.register("upsert_dashboard", declaration("upsert_dashboard"), (raw, runCtx) =>
    guarded(() =>
      serial(runCtx.companyId, async () => {
        const params = asParams(raw);
        const settings = await getSettings(ctx, runCtx.companyId);
        if (params.projectId === null) {
          throw new ProjectError("project_required", "projectId cannot be null; every dashboard belongs to a project");
        }
        if (params.projectId !== undefined && typeof params.projectId !== "string") {
          throw new DashboardError("projectId must be a project UUID string");
        }
        const slug = slugOf(params.slug);
        let projectId = params.projectId;
        if (projectId === undefined) {
          // Omitted: an existing dashboard keeps its project (or lack of one); a new one follows the run's project.
          const existing = await getDashboard(ctx, { companyId: runCtx.companyId, slug });
          if (!existing) {
            if (!runCtx.projectId) {
              throw new ProjectError(
                "project_required",
                "projectId is required to create a dashboard because this run has no project; pass projectId (a project UUID of this company)",
              );
            }
            projectId = runCtx.projectId;
          }
        }
        if (params.title !== undefined && typeof params.title !== "string") {
          throw new DashboardError("title must be a string");
        }
        const { record, created } = await upsertDashboard(ctx, {
          companyId: runCtx.companyId,
          slug,
          title: params.title,
          projectId,
          spec: params.spec,
          actor: agentActor(runCtx),
          settings,
        });
        return {
          content: `${created ? "Created" : "Updated"} dashboard ${describe(record)}${record.projectName ? ` in project ${record.projectName}` : ""}.`,
          data: { id: record.id, slug: record.slug, revision: record.revision, projectId: record.projectId },
        };
      }),
    ),
  );

  ctx.tools.register("get_dashboard", declaration("get_dashboard"), (raw, runCtx) =>
    guarded(async () => {
      const params = asParams(raw);
      const record = await getDashboard(ctx, { companyId: runCtx.companyId, slug: params.slug });
      if (!record) {
        return { error: `Dashboard "${String(params.slug)}" not found` };
      }
      return { content: `Dashboard ${describe(record)}.`, data: record };
    }),
  );

  ctx.tools.register("list_dashboards", declaration("list_dashboards"), (raw, runCtx) =>
    guarded(async () => {
      const params = asParams(raw);
      const items = await listDashboards(ctx, { companyId: runCtx.companyId, projectId: params.projectId });
      const lines = items.map((item) => `- ${item.slug} (revision ${item.revision}${item.projectName ? `, ${item.projectName}` : ""}): ${item.title}`);
      return {
        content: items.length > 0 ? `${items.length} dashboard(s):\n${lines.join("\n")}` : "No dashboards yet.",
        data: items,
      };
    }),
  );

  ctx.tools.register("get_dashboard_status", declaration("get_dashboard_status"), (raw, runCtx) =>
    guarded(async () => {
      const params = asParams(raw);
      const record = await getDashboard(ctx, { companyId: runCtx.companyId, slug: params.slug });
      if (!record) {
        return { error: `Dashboard "${String(params.slug)}" not found` };
      }
      const settings = await getSettings(ctx, runCtx.companyId);
      const status = computeStatus(record, settings, new Date(), await links.viewPath(runCtx.companyId, record.slug));
      const stale = status.datasets.filter((dataset) => dataset.stale).map((dataset) => dataset.id);
      return {
        content: `Dashboard "${record.slug}" revision ${record.revision} is ${status.health}: ${status.staleCount} of ${status.datasets.length} dataset(s) stale${stale.length > 0 ? ` (${stale.join(", ")})` : ""}; ${status.sections} section(s), ${status.blocks} block(s).`,
        data: status,
      };
    }),
  );

  ctx.tools.register("update_dataset", declaration("update_dataset"), (raw, runCtx) =>
    guarded(() =>
      serial(runCtx.companyId, async () => {
        const params = asParams(raw);
        if (typeof params.datasetId !== "string") {
          throw new DashboardError("datasetId must be a string");
        }
        const { record } = await updateDataset(ctx, {
          companyId: runCtx.companyId,
          slug: slugOf(params.slug),
          datasetId: params.datasetId,
          rows: params.rows,
          columns: params.columns,
          description: params.description,
          source: params.source,
          updatedAt: params.updatedAt,
          actor: agentActor(runCtx),
          settings: await getSettings(ctx, runCtx.companyId),
        });
        return {
          content: `Refreshed dataset "${params.datasetId}" in dashboard ${describe(record)}.`,
          data: { id: record.id, slug: record.slug, revision: record.revision },
        };
      }),
    ),
  );

  ctx.tools.register("validate_dashboard_spec", declaration("validate_dashboard_spec"), (raw, runCtx) =>
    guarded(async () => {
      const params = asParams(raw);
      const spec = validateDashboardSpec(params.spec, await getSettings(ctx, runCtx.companyId));
      return {
        content: `Spec is valid: ${Object.keys(spec.datasets).length} dataset(s), ${spec.sections.length} section(s).`,
      };
    }),
  );
}

let handleApi: ReturnType<typeof createApi> | null = null;

const plugin = definePlugin({
  async onApiRequest(input) {
    if (!handleApi) {
      return { status: 503, headers: { "cache-control": "no-store" }, body: { companyId: input.companyId, error: "internal_error" } };
    }
    return handleApi(input);
  },
  async setup(ctx) {
    const serial = companySerialQueue();
    const links = createLinkResolver(ctx);
    handleApi = createApi(ctx, serial, links);

    ctx.data.register("settings.get", async (params) => getSettings(ctx, uuid(params.companyId, "companyId")));
    ctx.data.register("dashboards.list", (params) => listDashboards(ctx, params));
    ctx.data.register("dashboard.get", (params) => getDashboard(ctx, params));
    ctx.data.register("dashboard.status", async (params) => {
      const companyId = uuid(params.companyId, "companyId");
      const record = await getDashboard(ctx, { companyId, id: params.id, slug: params.slug });
      return record ? computeLiveStatus(record, await getSettings(ctx, companyId), new Date()) : null;
    });
    ctx.data.register("dashboard.revisions", (params) => listRevisions(ctx, params));

    ctx.actions.register("dashboard.delete", (params, context) => {
      const companyId = uuid(context.companyId ?? params.companyId, "companyId");
      return serial(companyId, () => deleteDashboard(ctx, { companyId, id: params.id }));
    });
    ctx.actions.register("dashboard.restoreRevision", (params, context) => {
      const companyId = uuid(context.companyId ?? params.companyId, "companyId");
      return serial(companyId, async () =>
        restoreRevision(ctx, {
          companyId,
          id: params.id,
          revision: params.revision,
          actor: actionActor(context),
          settings: await getSettings(ctx, companyId),
        }),
      );
    });

    ctx.actions.register("dashboard.setProject", (params, context) => {
      const companyId = uuid(context.companyId ?? params.companyId, "companyId");
      return serial(companyId, async () =>
        setDashboardProject(ctx, {
          companyId,
          id: params.id,
          projectId: params.projectId,
          actor: actionActor(context),
          settings: await getSettings(ctx, companyId),
        }),
      );
    });

    registerTools(ctx, serial, links);
    registerChangelogTools(ctx, serial);
    registerChangelogHost(ctx, serial);
  },
  async onHealth() {
    return { status: "ok", message: "Project Dashboards worker is ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
