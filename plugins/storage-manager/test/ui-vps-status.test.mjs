import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const base = {
  companyId: "company-1", status: "ready", reason: null, generatedAt: "2026-10-21T12:00:00.000Z",
  filesystem: { mount: "/", totalBytes: 1000, usedBytes: 400, availableBytes: 600, usedPercent: 40 },
  uptimeSeconds: 90_000, directories: [], docker: [], alerts: [], coverage: { partial: false, notes: [] },
  history: [
    { at: "2026-10-21T11:40:00.000Z", usedBytes: 390, availableBytes: 610, cpuPercent: 10, memoryUsedBytes: 5000 },
    { at: "2026-10-21T11:50:00.000Z", usedBytes: 395, availableBytes: 605, cpuPercent: 30, memoryUsedBytes: 6000 },
    { at: "2026-10-21T12:00:00.000Z", usedBytes: 400, availableBytes: 600, cpuPercent: 25.5, memoryUsedBytes: 6000 },
  ],
};
const withMetrics = {
  ...base,
  cpu: { cores: 4, usagePercent: 25.5, load1: 0.5, load5: 0.4, load15: 0.3 },
  memory: { totalBytes: 8 * 1024 ** 3, availableBytes: 2 * 1024 ** 3, usedBytes: 6 * 1024 ** 3, usedPercent: 75, swapTotalBytes: 1024 ** 3, swapUsedBytes: 256 * 1024 ** 2 },
};
const legacy = { ...base, cpu: null, memory: null, uptimeSeconds: null, history: [] };

async function render(data, component, selector = "main") {
  const outputDir = await mkdtemp(join(pluginRoot, ".ui-vps-test-"));
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const sdkMock = `
    export function usePluginData() { return { data: ${JSON.stringify(data)}, loading: false, error: null, refresh() {} }; }
    export function useHostNavigation() { return { linkProps(path) { return { href: path }; } }; }
  `;
  let root;
  try {
    const outputFile = join(outputDir, "ui.mjs");
    await build({
      entryPoints: [join(pluginRoot, "src/ui/index.tsx")], outfile: outputFile, bundle: true, platform: "node", format: "esm",
      external: ["react", "react-dom/client"],
      plugins: [{ name: "sdk", setup(builder) {
        builder.onResolve({ filter: /^@paperclipai\/plugin-sdk\/ui$/ }, () => ({ path: "sdk-ui", namespace: "sdk-mock" }));
        builder.onLoad({ filter: /.*/, namespace: "sdk-mock" }, () => ({ contents: sdkMock, loader: "js" }));
      } }],
    });
    const ui = await import(pathToFileURL(outputFile).href);
    root = createRoot(dom.window.document.getElementById("root"));
    await act(async () => { root.render(createElement(ui[component], { context: { companyId: "company-1" } })); });
    return dom.window.document.querySelector(selector).textContent.replace(/\s+/g, " ");
  } finally {
    if (root) await act(async () => { root.unmount(); });
    dom.window.close();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    await rm(outputDir, { recursive: true, force: true });
  }
}

test("the page is named VPS Status and shows CPU, RAM, swap and uptime", async () => {
  const text = await render(withMetrics, "StoragePage");
  assert.match(text, /VPS Status/);
  assert.doesNotMatch(text, /Storage Manager/);
  assert.match(text, /CPU25,5%4 núcleos · carga 0\.5 \/ 0\.4 \/ 0\.3/);
  assert.match(text, /Memória RAM75%6 GiB de 8 GiB/);
  assert.match(text, /Swap256 MiBde 1 GiB/);
  assert.match(text, /Tempo ligado1 d 1 h/);
  assert.match(text, /CPU ao longo do tempo/);
  assert.match(text, /Memória ao longo do tempo/);
});

test("a snapshot from an older collector shows CPU and memory as not collected", async () => {
  const text = await render(legacy, "StoragePage");
  assert.match(text, /CPUNão coletado/);
  assert.match(text, /Memória RAMNão coletado/);
  assert.match(text, /O histórico aparece após duas coletas/);
});

test("the sidebar entry is labelled VPS Status", async () => {
  const text = await render(withMetrics, "StorageSidebar", "a");
  assert.equal(text.trim(), "VPS Status");
});
