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

const plugin = definePlugin({
  async setup(ctx) {
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
