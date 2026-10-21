import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { loadConfig } from "./company-config.js";
import { validateConfig } from "./config.js";
import { createEngine } from "./engine.js";
import { handleWebhook } from "./webhook.js";

let current = null;

const plugin = definePlugin({
  async setup(ctx) {
    const engine = createEngine(ctx);
    current = { ctx, engine };

    ctx.jobs.register("reconcile", async () => {
      const summary = await engine.reconcile();
      ctx.logger.info("github-pr-intake: reconcile finished", summary);
    });
    ctx.logger.info("github-pr-intake: worker ready");
  },

  async onWebhook(input) {
    if (!current) throw new Error("github-pr-intake worker is not ready");
    await handleWebhook(current.ctx, current.engine, input);
  },

  async onValidateConfig(config) {
    return validateConfig(config);
  },

  async onHealth() {
    if (!current) return { status: "degraded", message: "worker not ready" };
    const { repositories } = await loadConfig(current.ctx);
    const paused = [...repositories.values()].filter((repo) => repo.killSwitch).length;
    return {
      status: "ok",
      message: `Listening for ${repositories.size} configured repositor${repositories.size === 1 ? "y" : "ies"}${paused ? ` (${paused} paused)` : ""}`,
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
