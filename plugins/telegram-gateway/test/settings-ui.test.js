import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/PAP/company/settings/telegram-commands" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let result;
const dataCalls = [];
globalThis.__paperclipPluginBridge__ = {
  sdkUi: {
    usePluginData: (key, params) => {
      dataCalls.push({ key, params });
      return result;
    },
    useHostNavigation: () => ({
      linkProps: (href) => ({ href: `/PAP${href}` }),
    }),
  },
};

let TelegramCommandsSettingsPage;
before(async () => {
  ({ TelegramCommandsSettingsPage } = await import("../dist/ui/index.js"));
});

let container;
let root;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

function renderPage() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

async function renderFor(companyId) {
  await act(async () => root.render(React.createElement(TelegramCommandsSettingsPage, {
    context: { companyId, companyPrefix: "/PAP" },
  })));
}

const catalog = {
  commands: [
    { name: "agents", description: "Listar agentes", source: "gateway", providerId: null },
    { name: "report", description: "Ver resumo", source: "provider", providerId: "example.provider" },
  ],
  botFatherLines: ["agents - Listar agentes", "report - Ver resumo"],
  omittedFromBotFather: 0,
  commandsEnabled: true,
  guidance: {
    commandMenuUrl: "https://core.telegram.org/bots/features#commands",
    botFatherUrl: "https://t.me/BotFather",
    botFatherDocsUrl: "https://core.telegram.org/bots/features#botfather",
  },
};

test("settings page renders loading, error, scoped catalog, route and command guidance", async () => {
  dataCalls.length = 0;
  renderPage();
  result = { loading: true, data: undefined, error: null };
  await renderFor("company-alpha");
  assert.match(container.textContent, /Carregando o catálogo desta empresa/);
  assert.deepEqual(dataCalls.at(-1), { key: "telegram-command-catalog", params: { companyId: "company-alpha" } });

  result = { loading: false, data: undefined, error: { message: "Falha de leitura" } };
  await renderFor("company-alpha");
  assert.equal(container.querySelector('[role="alert"]')?.textContent.includes("Falha de leitura"), true);

  result = { loading: false, data: catalog, error: null };
  await renderFor("company-beta");
  assert.deepEqual(dataCalls.at(-1), { key: "telegram-command-catalog", params: { companyId: "company-beta" } });
  assert.match(container.textContent, /Comandos do Telegram/);
  assert.match(container.textContent, /report - Ver resumo/);
  assert.match(container.textContent, /Esta página não verifica o recebimento de comandos pelo bot/);
  assert.equal(container.querySelector('a[href="/PAP/company/settings/instance/plugins/journey-studios.founder-comms-router"]')?.textContent.includes("configurações deste plugin"), true);
  assert.equal(container.querySelector('a[href="https://t.me/BotFather"]')?.textContent.includes("@BotFather"), true);
  assert.equal(container.querySelector('a[href="https://core.telegram.org/bots/features#commands"]') !== null, true);
  assert.equal(container.querySelector('a[href="https://core.telegram.org/bots/features#botfather"]') !== null, true);
});

test("copy button reports successful copy and clipboard denial accessibly", async () => {
  result = { loading: false, data: catalog, error: null };
  renderPage();
  const copied = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => copied.push(text) } });
  await renderFor("company-alpha");
  await act(async () => {
    container.querySelector("button").click();
    await Promise.resolve();
  });
  assert.deepEqual(copied, [catalog.botFatherLines.join("\n")]);
  assert.match(container.querySelector('[aria-live="polite"]').textContent, /Linhas copiadas/);

  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("permission denied"); } } });
  await act(async () => container.querySelector("button").click());
  assert.match(container.querySelector('[aria-live="polite"]').textContent, /Não foi possível copiar/);
});
