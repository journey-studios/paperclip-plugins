import test from "node:test";
import { readFileSync } from "node:fs";
import manifest from "../src/manifest.js";
import assert from "node:assert/strict";
import { createTelegramCommandRegistry } from "../src/command-registry.js";
import { executeFounderCommand } from "../src/commands.js";
import {
  GATEWAY_ID, DISCOVER_EVENT, EXECUTE_EVENT, contributeTelegramCommands,
} from "../../../shared/telegram-command-api.js";

const gatewayId = GATEWAY_ID;
const observatoryId = "journey-studios.agent-observatory";
const founder = "founder";
const companyId = "company-a";
const definition = {
  name: "custos", description: "Total mensal por provedor", usage: "/custos [AAAA-MM]",
  readOnly: true, audience: "founder",
};

function harness() {
  const subscribers = [];
  const messages = [];
  const matching = (pattern, type) => pattern === type ||
    (pattern.endsWith("*") && type.startsWith(pattern.slice(0, -1)));
  function actor(pluginId) {
    return {
      events: {
        on(pattern, cb) { subscribers.push({ pattern, cb }); },
        async emit(name, company, payload) {
          const event = {
            companyId: company, payload, actorType: "plugin", actorId: pluginId,
            eventType: `plugin.${pluginId}.${name}`,
          };
          messages.push(event);
          await Promise.all(subscribers.filter((sub) => matching(sub.pattern, event.eventType))
            .map((sub) => Promise.resolve().then(() => sub.cb(event))));
        },
      },
      config: { get: async () => ({
        liaisonAgentId: "liaison", founderUserId: founder,
        commandProviderIds: [observatoryId], commandsEnabled: true,
      }) },
    };
  }
  return { actor, messages };
}

test("Telegram Gateway rename preserves runtime ID and event namespace", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "@journey-studios/telegram-gateway");
  assert.equal(pkg.version, "0.3.1");
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.displayName, "Telegram Gateway");
  assert.equal(manifest.id, "journey-studios.founder-comms-router");
  assert.equal(manifest.id, GATEWAY_ID);
  assert.equal(DISCOVER_EVENT, `plugin.${GATEWAY_ID}.telegram-command-discover-v1`);
  assert.equal(EXECUTE_EVENT, `plugin.${GATEWAY_ID}.telegram-command-execute-v1`);
  assert.ok(manifest.instanceConfigSchema.properties.commandProviderIds);
});

test("plugin registers itself and Gateway dispatches a cost command without an LLM", async () => {
  const h = harness();
  const gateway = h.actor(gatewayId);
  const observatory = h.actor(observatoryId);
  let hits = 0;
  contributeTelegramCommands(observatory, {
    pluginId: observatoryId, commands: [definition],
    execute: async ({ companyId, command, args }) => {
      hits++;
      assert.equal(companyId, "company-a");
      assert.equal(command, "custos");
      return `**Total** ${args || "mês atual"}`;
    },
  });
  const registry = createTelegramCommandRegistry(gateway);
  const commands = await registry.discover(companyId, [observatoryId]);
  assert.deepEqual(commands.map((item) => item.name), ["custos"]);
  const action = {
    provider: "telegram", command: "custos", args: "2026-10",
    assigneeAgentId: "liaison",
  };
  const invoke = (userId, company = companyId) => executeFounderCommand(gateway, action, {
    companyId: company, actor: { type: "user", companyId: company, userId },
  }, registry);
  assert.equal((await invoke(founder)).text, "**Total** 2026-10");
  assert.equal(hits, 1);
  assert.equal((await invoke("other-user")).text, "Este comando é restrito ao Founder vinculado no Paperclip.");
  assert.equal(hits, 1);
  const mismatched = await executeFounderCommand(gateway, action, { companyId: "other-company", actor: { type: "user", companyId, userId: founder } }, registry);
  assert.equal(mismatched.handled, false);
  assert.equal(hits, 1);
  assert.ok(h.messages.some((event) => event.eventType === DISCOVER_EVENT));
  assert.ok(h.messages.some((event) => event.eventType === EXECUTE_EVENT));
});

test("cross-plugin impersonation is ignored based on host event namespace", async () => {
  const h = harness();
  const gateway = h.actor(gatewayId);
  const provider = h.actor(observatoryId);
  const attacker = h.actor("journey-studios.untrusted-test");
  attacker.events.on(DISCOVER_EVENT, async (event) => {
    await attacker.events.emit("telegram-command-declare-v1", event.companyId, {
      apiVersion: 1, requestId: event.payload.requestId, commands: [definition],
    });
  });
  attacker.events.on(EXECUTE_EVENT, async (event) => {
    await attacker.events.emit("telegram-command-result-v1", event.companyId, {
      apiVersion: 1, requestId: event.payload.requestId,
      command: "custos", ok: true, text: "FORGED",
    });
  });
  contributeTelegramCommands(provider, {
    pluginId: observatoryId, commands: [definition],
    execute: async () => "REAL",
  });
  const registry = createTelegramCommandRegistry(gateway);
  assert.deepEqual(await registry.execute(companyId, [observatoryId], "custos"), {
    handled: true, text: "REAL",
  });
});

test("duplicate commands from different providers fail closed instead of choosing by load order", async () => {
  const h = harness();
  const providerA = "journey-studios.agent-observatory";
  const providerB = "journey-studios.other-provider";
  const gateway = createTelegramCommandRegistry(h.actor(gatewayId));
  for (const id of [providerA, providerB])
    contributeTelegramCommands(h.actor(id), { pluginId: id, commands: [definition], execute: async () => "result" });
  assert.deepEqual(await gateway.discover(companyId, [providerA, providerB]), []);
  assert.equal((await gateway.execute(companyId, [providerA, providerB], "custos")).handled, false);
});

test("only read-only founder command declarations are accepted", () => {
  const h = harness();
  assert.throws(() => contributeTelegramCommands(h.actor(observatoryId), {
    pluginId: observatoryId, commands: [{ ...definition, readOnly: false }],
    execute: async () => "unsafe",
  }), /Invalid\/duplicate command/);
});

test("a provider error is a bounded generic message, not a leaked stack or credential", async () => {
  const h = harness();
  const gateway = createTelegramCommandRegistry(h.actor(gatewayId));
  contributeTelegramCommands(h.actor(observatoryId), {
    pluginId: observatoryId, commands: [definition],
    execute: async () => { throw new Error("private-secret-example"); },
  });
  const result = await gateway.execute(companyId, [observatoryId], "custos");
  assert.equal(result.handled, true);
  assert.match(result.text, /temporariamente indisponível/);
  assert.doesNotMatch(result.text, /private-secret/);
});

test("a prefix plugin cannot impersonate the Gateway despite identical eventType", async () => {
  const h = harness();
  const malicious = h.actor("journey-studios");
  let executes = 0;
  contributeTelegramCommands(h.actor(observatoryId), {
    pluginId: observatoryId, commands: [definition],
    execute: async () => { executes++; return "should not execute"; },
  });
  const request = {
    apiVersion: 1, requestId: "11111111-1111-4111-8111-111111111111",
    targetProviderId: observatoryId, command: "custos", args: "2026-10",
  };
  await malicious.events.emit("founder-comms-router.telegram-command-execute-v1", companyId, request);
  assert.equal(executes, 0);
  const before = h.messages.length;
  await malicious.events.emit("founder-comms-router.telegram-command-discover-v1", companyId, request);
  assert.equal(h.messages.length, before + 1, "receiver must not declare commands to forged Gateway");
});

test("a prefix plugin cannot impersonate Observatory command declarations or results", async () => {
  const h = harness();
  const malicious = h.actor("journey-studios");
  malicious.events.on(DISCOVER_EVENT, async (event) => {
    await malicious.events.emit("agent-observatory.telegram-command-declare-v1", event.companyId, {
      apiVersion: 1, requestId: event.payload.requestId, commands: [definition],
    });
  });
  const gateway = createTelegramCommandRegistry(h.actor(gatewayId));
  assert.deepEqual(await gateway.discover(companyId, [observatoryId]), []);

  const provider = h.actor(observatoryId);
  contributeTelegramCommands(provider, {
    pluginId: observatoryId, commands: [definition],
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return "AUTHENTIC";
    },
  });
  malicious.events.on(EXECUTE_EVENT, async (event) => {
    await malicious.events.emit("agent-observatory.telegram-command-result-v1", event.companyId, {
      apiVersion: 1, requestId: event.payload.requestId, command: "custos", ok: true, text: "FORGED",
    });
  });
  assert.deepEqual(await gateway.execute(companyId, [observatoryId], "custos", "2026-10"), {
    handled: true, text: "AUTHENTIC",
  });
});
