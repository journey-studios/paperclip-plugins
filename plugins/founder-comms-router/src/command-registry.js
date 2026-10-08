import { randomUUID } from "node:crypto";
import {
  API_VERSION, COMMAND_PATTERN, DECLARE_SUFFIX, DISCOVER_EVENT, EXECUTE_EVENT,
  PLUGIN_ID_PATTERN, RESULT_SUFFIX, cleanCommandDeclaration, providerFromEvent,
} from "../../../shared/telegram-command-api.js";

const BUILT_INS = new Set(["agents", "tasks", "help", "status", "task", "new", "close", "start"]);
const DISCOVERY_MS = 650;
const EXECUTION_MS = 1650; // Must fit existing 3000ms host action deadline.

function pendingResult(map, id, metadata, timeoutMs) {
  let finish;
  const promise = new Promise((resolve) => { finish = resolve; });
  const timer = setTimeout(() => {
    if (!map.has(id)) return;
    map.delete(id);
    finish(null);
  }, timeoutMs);
  map.set(id, {
    ...metadata,
    resolve: (result) => {
      if (!map.has(id)) return;
      clearTimeout(timer);
      map.delete(id);
      finish(result);
    },
  });
  return promise;
}

/**
 * The gateway knows no provider-specific business logic. Sender authenticity
 * uses Paperclip's host-attested event actorId AND namespace, then a company allowlist.
 */
export function createTelegramCommandRegistry(ctx) {
  const pending = new Map();

  ctx.events.on("plugin.*", async (event) => {
    const declaredBy = providerFromEvent(event?.eventType, DECLARE_SUFFIX);
    const resultBy = providerFromEvent(event?.eventType, RESULT_SUFFIX);
    const from = declaredBy ?? resultBy;
    const data = event?.payload;
    const request = pending.get(data?.requestId);
    if (!from || event.actorType !== "plugin" || event.actorId !== from ||
      !request || request.providerId !== from ||
      request.companyId !== event.companyId || data.apiVersion !== API_VERSION) return;

    if (declaredBy && request.kind === "discover") {
      if (!Array.isArray(data.commands) || data.commands.length > 40) return;
      const commands = data.commands.map(cleanCommandDeclaration);
      if (commands.some((cmd) => !cmd) || new Set(commands.map((cmd) => cmd.name)).size !== commands.length) return;
      request.resolve(commands);
    } else if (resultBy && request.kind === "execute" && data.command === request.command) {
      if (data.ok === true && typeof data.text === "string" && data.text.length > 0 && data.text.length <= 3500)
        request.resolve({ ok: true, text: data.text });
      else if (data.ok === false) request.resolve({ ok: false });
    }
  });

  function signal(name, companyId, payload) {
    // Never await a provider's event handler for longer than our own deadline.
    void ctx.events.emit(name, companyId, payload).catch(() => {});
  }

  async function discover(companyId, providerIds) {
    const ids = [...new Set(providerIds)].filter((id) => PLUGIN_ID_PATTERN.test(id)).slice(0, 12);
    const replies = await Promise.all(ids.map(async (providerId) => {
      const requestId = randomUUID();
      const promise = pendingResult(pending, requestId,
        { providerId, companyId, kind: "discover" }, DISCOVERY_MS);
      signal("telegram-command-discover-v1", companyId, { apiVersion: API_VERSION, requestId, targetProviderId: providerId });
      return { providerId, commands: (await promise) ?? [] };
    }));

    const registered = new Map();
    for (const { providerId, commands } of replies) {
      for (const command of commands) {
        if (BUILT_INS.has(command.name)) continue;
        if (registered.has(command.name)) registered.set(command.name, null); // fail closed on conflict
        else registered.set(command.name, { ...command, providerId });
      }
    }
    return [...registered.values()].filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  }

  async function execute(companyId, providerIds, name, args = "") {
    if (!COMMAND_PATTERN.test(name) || typeof args !== "string" || args.length > 60)
      return { handled: false };
    const provider = (await discover(companyId, providerIds)).find((command) => command.name === name);
    if (!provider) return { handled: false };
    const requestId = randomUUID();
    const promise = pendingResult(pending, requestId, {
      providerId: provider.providerId, companyId, command: name, kind: "execute",
    }, EXECUTION_MS);
    signal("telegram-command-execute-v1", companyId, {
      apiVersion: API_VERSION, requestId, targetProviderId: provider.providerId,
      command: name, args,
    });
    const result = await promise;
    return {
      handled: true,
      text: result?.ok ? result.text : "Consulta temporariamente indisponível. Tente novamente.",
    };
  }

  return { discover, execute };
}
