import { companyConfig } from "./core.js";
import { listBuiltinTelegramCommands } from "./commands.js";
import { NATIVE_TELEGRAM_COMMANDS, TELEGRAM_COMMAND_GUIDANCE } from "./command-catalog.js";

const TELEGRAM_COMMAND_LIMIT = 100;

export function buildTelegramCommandCatalog({ config, providerCommands }) {
  const byName = new Map();
  for (const command of [
    ...listBuiltinTelegramCommands(),
    ...NATIVE_TELEGRAM_COMMANDS,
    ...providerCommands.map((command) => ({ ...command, source: "provider" })),
  ]) {
    if (!command?.name || !command.description || byName.has(command.name)) continue;
    byName.set(command.name, {
      name: command.name,
      description: command.description,
      source: command.source,
      providerId: command.providerId ?? null,
    });
  }

  const commands = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const botFatherCommands = commands.slice(0, TELEGRAM_COMMAND_LIMIT);
  return {
    commands,
    botFatherLines: botFatherCommands.map((command) => `${command.name} - ${command.description}`),
    omittedFromBotFather: Math.max(0, commands.length - botFatherCommands.length),
    commandsEnabled: config.commandsEnabled,
    guidance: TELEGRAM_COMMAND_GUIDANCE,
  };
}

/** Register a read-only, company-scoped data source for the plugin's settings guide. */
export function registerTelegramCommandCatalogData(ctx, registry) {
  ctx.data.register("telegram-command-catalog", async (params) => {
    const companyId = typeof params?.companyId === "string" ? params.companyId.trim() : "";
    if (!companyId) throw new Error("A company context is required");
    const config = await companyConfig(ctx, companyId);
    const providerCommands = await registry.discover(companyId, config.commandProviderIds);
    return buildTelegramCommandCatalog({ config, providerCommands });
  });
}
