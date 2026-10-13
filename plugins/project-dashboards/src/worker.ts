import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { createApi } from "./api.js";
import type { Actor, DashboardRecord } from "./contracts.js";
import { createLinkResolver } from "./links.js";
import { computeLiveStatus, computeStatus } from "./status.js";
import {
  DashboardError,
  companySerialQueue,
  deleteDashboard,
  getDashboard,
  getSettings,
  listDashboards,
  listRevisions,
  restoreRevision,
  slugOf,
  updateDataset,
  upsertDashboard,
  uuid,
  validateDashboardSpec,
} from "./dashboards.js";
import { TOOL_DECLARATIONS } from "./tools.js";

type Params = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asParams(value: unknown): Params {
  return isRecord(value) ? value : {};
}

function declaration(name: string) {
  const found = TOOL_DECLARATIONS.find((tool) => tool.name === name);
  if (!found) {
    throw new Error(`Unknown tool declaration ${name}`);
  }
  return { displayName: found.displayName, description: found.description, parametersSchema: found.parametersSchema };
}

function describe(record: DashboardRecord): string {
  const datasets = record.spec ? Object.keys(record.spec.datasets).length : 0;
  const sections = record.spec ? record.spec.sections.length : 0;
  return `"${record.slug}" revision ${record.revision}: ${datasets} dataset(s), ${sections} section(s)`;
}

export function agentActor(runCtx: ToolRunContext): Actor {
  return { kind: "agent", id: runCtx.agentId };
}

/** Run a tool body, turning user-correctable failures into tool errors the agent can act on. */
async function guarded(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof DashboardError) {
      return { error: error.message };
    }
    throw error;
  }
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
        let projectId: string | null | undefined;
        if (params.projectId === null) {
          projectId = null;
        } else if (typeof params.projectId === "string") {
          projectId = params.projectId;
        } else if (params.projectId !== undefined) {
          throw new DashboardError("projectId must be a UUID string or null");
        } else {
          // Omitted: new dashboards follow the current run's project; existing ones keep theirs.
          const slug = slugOf(params.slug);
          const existing = await getDashboard(ctx, { companyId: runCtx.companyId, slug });
          projectId = existing ? undefined : runCtx.projectId || null;
        }
        if (params.title !== undefined && typeof params.title !== "string") {
          throw new DashboardError("title must be a string");
        }
        const { record, created } = await upsertDashboard(ctx, {
          companyId: runCtx.companyId,
          slug: slugOf(params.slug),
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

function actionActor(context: { actor: { type: "user" | "agent" | "system"; userId: string | null; agentId: string | null } }): Actor {
  const { actor } = context;
  if (actor.type === "agent") {
    return { kind: "agent", id: actor.agentId };
  }
  if (actor.type === "user") {
    return { kind: "user", id: actor.userId };
  }
  return { kind: "system", id: null };
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

    registerTools(ctx, serial, links);
  },
  async onHealth() {
    return { status: "ok", message: "Project Dashboards worker is ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
