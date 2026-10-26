import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";
export default plugin;
runWorker(definePlugin(plugin), import.meta.url);
