import type { PluginApiRequestInput, PluginApiResponse, PluginContext } from "@paperclipai/plugin-sdk";
import type { Actor } from "./contracts.js";
import { HierarchyError, type HierarchyErrorCode } from "./errors.js";
import { getHierarchy, getTree, setParent, uuid, type Serial } from "./hierarchy.js";

const STATUS_BY_CODE: Record<HierarchyErrorCode, number> = {
  invalid_input: 400,
  project_not_found: 404,
  parent_not_found: 422,
  parent_archived: 422,
  self_parent: 422,
  cycle: 422,
};

// Every body echoes companyId so a scripted or MCP client can verify the scope it was served.
function reply(companyId: string, status: number, body: Record<string, unknown>): PluginApiResponse {
  return { status, headers: { "cache-control": "no-store" }, body: { companyId, ...body } };
}

function actorOf(input: PluginApiRequestInput): Actor {
  if (input.actor.actorType === "agent") {
    return { kind: "agent", id: input.actor.agentId ?? input.actor.actorId };
  }
  return { kind: "user", id: input.actor.userId ?? input.actor.actorId };
}

function bodyRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HierarchyError("invalid_input", "body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function createApi(ctx: PluginContext, serial: Serial) {
  return async function handle(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    const { companyId } = input;
    try {
      switch (input.routeKey) {
        case "tree":
          return reply(companyId, 200, { ...(await getTree(ctx, companyId)) });
        case "project-get":
          return reply(companyId, 200, { ...(await getHierarchy(ctx, companyId, uuid(input.params.projectId, "projectId"))) });
        case "project-set-parent": {
          const body = bodyRecord(input.body);
          if (!("parentProjectId" in body)) {
            throw new HierarchyError("invalid_input", "parentProjectId is required (a project UUID, or null for top-level)");
          }
          const hierarchy = await serial(companyId, () =>
            setParent(ctx, {
              companyId,
              projectId: input.params.projectId,
              parentProjectId: body.parentProjectId,
              actor: actorOf(input),
            }),
          );
          return reply(companyId, 200, { ...hierarchy });
        }
        default:
          return reply(companyId, 404, { error: "not_found" });
      }
    } catch (error) {
      if (error instanceof HierarchyError) {
        return reply(companyId, STATUS_BY_CODE[error.code], { error: error.code, message: error.message });
      }
      ctx.logger.error("project hierarchy api failed", { error: error instanceof Error ? error.message : String(error) });
      return reply(companyId, 500, { error: "internal_error" });
    }
  };
}
