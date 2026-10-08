import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import manifest from "../src/manifest.js";
import { listBuiltinTelegramCommands } from "../src/commands.js";
import { NATIVE_TELEGRAM_COMMANDS, TELEGRAM_COMMAND_GUIDANCE } from "../src/command-catalog.js";
import { buildTelegramCommandCatalog, registerTelegramCommandCatalogData } from "../src/settings-data.js";

const config = {
  commandsEnabled: true,
  commandProviderIds: ["journey-studios.agent-observatory"],
};

test("settings catalog derives built-ins, native commands, and allowlisted provider discoveries", () => {
  const catalog = buildTelegramCommandCatalog({
    config,
    providerCommands: [{
      name: "custos", description: "Custos mensais por API", providerId: "journey-studios.agent-observatory",
    }],
  });
  const byName = new Map(catalog.commands.map((command) => [command.name, command]));

  for (const command of listBuiltinTelegramCommands()) assert.equal(byName.get(command.name).source, "gateway");
  for (const command of NATIVE_TELEGRAM_COMMANDS) assert.equal(byName.get(command.name).source, "paperclip");
  assert.deepEqual(byName.get("custos"), {
    name: "custos", description: "Custos mensais por API", source: "provider",
    providerId: "journey-studios.agent-observatory",
  });
  assert.ok(catalog.botFatherLines.includes("custos - Custos mensais por API"));
});

test("catalog preserves gateway collisions, sorts deterministically, and caps BotFather output", () => {
  const many = Array.from({ length: 110 }, (_, index) => ({
    name: `custom_${String(index).padStart(3, "0")}`,
    description: `Read-only item ${index}`,
    providerId: "journey-studios.provider",
  }));
  const catalog = buildTelegramCommandCatalog({
    config: { ...config, commandsEnabled: false },
    providerCommands: [
      { name: "agents", description: "provider collision", providerId: "journey-studios.provider" },
      ...many,
    ],
  });

  assert.equal(catalog.commands.find((command) => command.name === "agents").source, "gateway");
  assert.equal(catalog.commandsEnabled, false);
  assert.equal(catalog.botFatherLines.length, 100);
  assert.equal(catalog.omittedFromBotFather, catalog.commands.length - 100);
  assert.deepEqual(catalog.botFatherLines, [...catalog.botFatherLines].sort((a, b) => a.split(" - ")[0].localeCompare(b.split(" - ")[0])));
});

test("worker data registration requires company context and discovers only configured provider IDs", async () => {
  let handler;
  const calls = [];
  const ctx = {
    data: { register(key, fn) { assert.equal(key, "telegram-command-catalog"); handler = fn; } },
    config: { async get(companyId) { assert.equal(companyId, "company-a"); return {}; } },
  };
  const registry = { async discover(companyId, providerIds) {
    calls.push({ companyId, providerIds });
    return [{ name: "custos", description: "Custos", providerId: providerIds[0] }];
  } };
  registerTelegramCommandCatalogData(ctx, registry);

  await assert.rejects(handler({}), /company context is required/);
  const catalog = await handler({ companyId: "company-a" });
  assert.deepEqual(calls, [{ companyId: "company-a", providerIds: ["journey-studios.agent-observatory"] }]);
  assert.ok(catalog.commands.some((command) => command.name === "custos"));
  assert.equal(catalog.guidance.commandMenuUrl, "https://core.telegram.org/bots/features#commands");
  assert.equal(catalog.guidance.botFatherUrl, TELEGRAM_COMMAND_GUIDANCE.botFatherUrl);
  assert.equal(catalog.guidance.botFatherUrl, "https://t.me/BotFather");
});

test("company settings guide is packaged without replacing existing company configuration", () => {
  const slot = manifest.ui.slots.find((item) => item.id === "telegram-command-guide");
  const bundle = readFileSync(new URL("../dist/ui/index.js", import.meta.url), "utf8");

  assert.deepEqual(slot, {
    type: "companySettingsPage",
    id: "telegram-command-guide",
    displayName: "Comandos do Telegram",
    exportName: "TelegramCommandsSettingsPage",
    routePath: "telegram-commands",
  });
  assert.ok(manifest.capabilities.includes("instance.settings.register"));
  assert.equal(manifest.entrypoints.ui, "./dist/ui");
  assert.ok(manifest.instanceConfigSchema.properties.liaisonAgentId);
  assert.match(bundle, /telegram-command-catalog/);
  assert.match(bundle, /commandMenuUrl/);
  assert.match(bundle, /botFatherDocsUrl/);
  assert.match(bundle, /botFatherUrl/);
  assert.doesNotMatch(bundle, /token do bot|bot token/i);
});
