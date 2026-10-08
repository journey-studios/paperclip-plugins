/** Versioned plugin-to-plugin Telegram command contract (no Paperclip core changes). */
export const API_VERSION = 1;
export const GATEWAY_ID = "journey-studios.founder-comms-router";
export const DISCOVER_EVENT = `plugin.${GATEWAY_ID}.telegram-command-discover-v1`;
export const EXECUTE_EVENT = `plugin.${GATEWAY_ID}.telegram-command-execute-v1`;
export const DECLARE_SUFFIX = ".telegram-command-declare-v1";
export const RESULT_SUFFIX = ".telegram-command-result-v1";
export const COMMAND_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/;
export const isRequestId = (value) => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function providerFromEvent(type, suffix) {
  if (typeof type !== "string" || !type.startsWith("plugin.") || !type.endsWith(suffix)) return null;
  const id = type.slice("plugin.".length, -suffix.length);
  return PLUGIN_ID_PATTERN.test(id) ? id : null;
}

export function cleanCommandDeclaration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    typeof value.name !== "string" || !COMMAND_PATTERN.test(value.name) ||
    typeof value.description !== "string" || !value.description.trim() ||
    value.readOnly !== true || value.audience !== "founder") return null;
  return {
    name: value.name,
    description: value.description.replace(/\s+/g, " ").trim().slice(0, 180),
    usage: typeof value.usage === "string" &&
      /^\/[a-z][a-z0-9_]{1,31}(?: \[[a-zA-Z0-9-]+\])?$/.test(value.usage)
      ? value.usage : `/${value.name}`,
    readOnly: true,
    audience: "founder",
  };
}

/** A provider listens only for requests emitted by the host-namespaced Gateway. */
export function contributeTelegramCommands(ctx, { pluginId, commands, execute }) {
  if (!PLUGIN_ID_PATTERN.test(pluginId) || typeof execute !== "function") throw new Error("Invalid command provider");
  const declared = commands.map(cleanCommandDeclaration);
  if (declared.some((item) => !item) ||
    new Set(declared.map((item) => item.name)).size !== declared.length) throw new Error("Invalid/duplicate command");

  ctx.events.on(DISCOVER_EVENT, async (event) => {
    const request = event?.payload;
    if (event.actorType !== "plugin" || event.actorId !== GATEWAY_ID || !event.companyId ||
      request?.apiVersion !== API_VERSION || !isRequestId(request.requestId) ||
      request.targetProviderId !== pluginId) return;
    await ctx.events.emit("telegram-command-declare-v1", event.companyId, {
      apiVersion: API_VERSION, requestId: request.requestId, commands: declared,
    });
  });
  ctx.events.on(EXECUTE_EVENT, async (event) => {
    const request = event?.payload;
    if (event.actorType !== "plugin" || event.actorId !== GATEWAY_ID || !event.companyId ||
      request?.apiVersion !== API_VERSION || !isRequestId(request.requestId) ||
      request.targetProviderId !== pluginId || !declared.some((item) => item.name === request.command) ||
      typeof request.args !== "string" || request.args.length > 60) return;
    let result;
    try {
      const text = await execute({ companyId: event.companyId, command: request.command, args: request.args });
      result = typeof text === "string" && text.length > 0 && text.length <= 3500
        ? { ok: true, text } : { ok: false, error: "Invalid response" };
    } catch {
      result = { ok: false, error: "Provider unavailable" };
    }
    await ctx.events.emit("telegram-command-result-v1", event.companyId, {
      apiVersion: API_VERSION, requestId: request.requestId, command: request.command, ...result,
    });
  });
}
