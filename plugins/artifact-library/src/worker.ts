import { createPluginMcpEndpoint, PluginMcpToolError } from "../../../shared/mcp/index.js";
import {
  definePlugin,
  runWorker,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import {
  deleteFolder,
  deleteTag,
  deleteView,
  listLibrary,
  navigation,
  saveFolder,
  saveTag,
  saveView,
  updateArtifact,
  uuid,
} from "./library.js";

type Params = Record<string, unknown>;
type Action = (ctx: PluginContext, params: Params) => Promise<unknown>;

// Paperclip owns one worker process for this installed plugin. Serializing
// company mutations keeps validation and hierarchy updates coherent, including
// concurrent opposite reparent requests that would otherwise create cycles.
function companySerialQueue() {
  const pending = new Map<string, Promise<unknown>>();
  return async (companyId: string, operation: () => Promise<unknown>) => {
    const previous = pending.get(companyId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    pending.set(companyId, result);
    try {
      return await result;
    } finally {
      if (pending.get(companyId) === result) pending.delete(companyId);
    }
  };
}

let mcpCtx: PluginContext;
const mcpHandler = createPluginMcpEndpoint({
  name: "journeystudios.artifact-library",
  version: "0.1.3",
  tools: [
    {
      name: "artifactLibraryNavigation",
      title: "Artifact Library Navigation",
      description: "List company folders, tags, saved views, project and agent filters without writing data.",
      readOnly: true,
      inputSchema: { type: "object", additionalProperties: false },
      execute: (_args, { companyId }) => navigation(mcpCtx, { companyId }),
    },
    {
      name: "artifactLibrarySearch",
      title: "Search Artifact Library",
      description: "Search bounded company artifacts; returns identifiers and safe metadata, not artifact contents or file bytes.",
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", maxLength: 160 },
          limit: { type: "integer", minimum: 1, maximum: 50 },
          cursor: { type: "string", maxLength: 5000 },
          kind: { type: "string", enum: ["all", "image", "video", "text", "document", "file"] },
          starred: { type: "boolean" },
        },
        additionalProperties: false,
      },
      execute: async (args, { companyId }) => {
        const filters = Object.fromEntries(["q", "kind", "starred"].filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
        let result: Awaited<ReturnType<typeof listLibrary>>;
        try {
          result = await listLibrary(mcpCtx, { companyId, filters, limit: args.limit ?? 30, cursor: args.cursor });
        } catch (error) {
          // Surface only recognized cursor failures, never arbitrary backend messages.
          const cursorErrors = new Set([
            "Invalid library cursor; restart this search",
            "Artifact pagination did not advance",
          ]);
          if (args.cursor !== undefined && error instanceof Error && cursorErrors.has(error.message)) {
            throw new PluginMcpToolError("invalid_cursor");
          }
          throw error;
        }
        return {
          companyId,
          artifacts: result.artifacts.map((artifact) => ({
            id: artifact.id, source: artifact.source, mediaKind: artifact.mediaKind,
            title: artifact.title, issue: artifact.issue, project: artifact.project,
            createdByAgent: artifact.createdByAgent, updatedAt: artifact.updatedAt,
            metadata: artifact.metadata,
          })),
          nextCursor: result.nextCursor,
          coverage: { limit: args.limit ?? 30, moreAvailable: result.nextCursor !== null },
        };
      },
    },
  ],
});

const plugin = definePlugin({
  async onApiRequest(input) {
    if (input.routeKey !== "mcp") return { status: 404, body: { error: "Unknown Artifact Library API route" } };
    return mcpHandler(input);
  },
  async setup(ctx) {
    mcpCtx = ctx;
    const serial = companySerialQueue();
    ctx.data.register("library", (params) => listLibrary(ctx, params));
    ctx.data.register("navigation", (params) => navigation(ctx, params));
    const actions: Record<string, Action> = {
      "artifact-update": updateArtifact,
      "folder-save": saveFolder,
      "folder-delete": deleteFolder,
      "tag-save": saveTag,
      "tag-delete": deleteTag,
      "view-save": saveView,
      "view-delete": deleteView,
    };
    for (const [key, action] of Object.entries(actions)) {
      ctx.actions.register(key, (params) =>
        serial(uuid(params.companyId, "companyId"), () => action(ctx, params)),
      );
    }
  },
  async onHealth() {
    return { status: "ok", message: "Artifact Library worker is ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
