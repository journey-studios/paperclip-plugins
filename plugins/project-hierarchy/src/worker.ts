import { definePlugin, runWorker, type PluginContext, type ToolResult, type ToolRunContext } from "@paperclipai/plugin-sdk";
import { createApi } from "./api.js";
import type { Actor } from "./contracts.js";
import { HierarchyError } from "./errors.js";
import { companySerialQueue, describeTree, getHierarchy, getTree, setParent, uuid, type Serial } from "./hierarchy.js";
import { TOOL_DECLARATIONS } from "./tools.js";

function declaration(name: string) {
  const found = TOOL_DECLARATIONS.find((tool) => tool.name === name);
  if (!found) {
    throw new Error(`Unknown tool declaration ${name}`);
  }
  return { displayName: found.displayName, description: found.description, parametersSchema: found.parametersSchema };
}

function params(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** Turn user-correctable failures into tool errors the agent can act on. */
async function guarded(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof HierarchyError) {
      return { error: `${error.code}: ${error.message}` };
    }
    throw error;
  }
}

/** The actor of a board action, from the immutable host context. */
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

function registerTools(ctx: PluginContext, serial: Serial): void {
  ctx.tools.register("list_project_tree", declaration("list_project_tree"), (_raw, runCtx: ToolRunContext) =>
    guarded(async () => {
      const tree = await getTree(ctx, runCtx.companyId);
      return {
        content: tree.projects.length > 0 ? describeTree(tree) : "This company has no projects.",
        data: tree,
      };
    }),
  );

  ctx.tools.register("get_project_hierarchy", declaration("get_project_hierarchy"), (raw, runCtx) =>
    guarded(async () => {
      const input = params(raw);
      const projectId = uuid(input.projectId ?? runCtx.projectId, "projectId");
      const hierarchy = await getHierarchy(ctx, runCtx.companyId, projectId);
      const path = [...hierarchy.ancestors, hierarchy.project].map((node) => node.name).join(" / ");
      const children = hierarchy.children.map((child) => `- ${child.name} (${child.id})`).join("\n");
      return {
        content: `${path}\nSub-projects: ${hierarchy.children.length}${children ? `\n${children}` : ""}`,
        data: hierarchy,
      };
    }),
  );

  ctx.tools.register("set_project_parent", declaration("set_project_parent"), (raw, runCtx) =>
    guarded(() =>
      serial(runCtx.companyId, async () => {
        const input = params(raw);
        if (!("parentProjectId" in input)) {
          throw new HierarchyError("invalid_input", "parentProjectId is required (a project UUID, or null for top-level)");
        }
        const hierarchy = await setParent(ctx, {
          companyId: runCtx.companyId,
          projectId: input.projectId,
          parentProjectId: input.parentProjectId,
          actor: { kind: "agent", id: runCtx.agentId },
        });
        const where = hierarchy.parent ? `under "${hierarchy.parent.name}"` : "at top level";
        return { content: `Project "${hierarchy.project.name}" is now ${where}.`, data: hierarchy };
      }),
    ),
  );
}

let handleApi: ReturnType<typeof createApi> | null = null;

const plugin = definePlugin({
  async onApiRequest(input) {
    if (!handleApi) {
      return { status: 503, headers: { "cache-control": "no-store" }, body: { companyId: input.companyId, error: "not_ready" } };
    }
    return handleApi(input);
  },
  async setup(ctx) {
    const serial = companySerialQueue();
    handleApi = createApi(ctx, serial);

    ctx.data.register("tree", (input) => getTree(ctx, uuid(input.companyId, "companyId")));
    ctx.data.register("project", (input) =>
      getHierarchy(ctx, uuid(input.companyId, "companyId"), uuid(input.projectId, "projectId")),
    );

    ctx.actions.register("setParent", (input, context) => {
      // The host authorizes the company in the action context; never trust one from the payload.
      const companyId = uuid(context.companyId ?? input.companyId, "companyId");
      return serial(companyId, () =>
        setParent(ctx, {
          companyId,
          projectId: input.projectId,
          parentProjectId: input.parentProjectId,
          actor: actionActor(context),
        }),
      );
    });

    registerTools(ctx, serial);
  },
  async onHealth() {
    return { status: "ok", message: "Project Hierarchy worker is ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
