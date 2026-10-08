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

test("Storage page refreshes on visible return and every minute, without overlapping requests", async () => {
  const outputDir = await mkdtemp(join(pluginRoot, ".ui-refresh-test-"));
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let visible = true;
  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, get: () => visible ? "visible" : "hidden" });
  let timer;
  let intervalMs;
  let intervalCalls = 0;
  let timerCleared = false;
  dom.window.setInterval = (callback, milliseconds) => { timer = callback; intervalMs = milliseconds; intervalCalls += 1; return 41; };
  dom.window.clearInterval = (id) => { if (id === 41) timerCleared = true; };
  const sdkMock = `
    import { useState } from "react";
    let count = 0;
    let finish;
    let failNext = false;
    let completeFast = false;
    globalThis.__storageRefreshCount = () => count;
    globalThis.__storageFinishRequest = () => finish?.();
    globalThis.__storageFailNextRequest = () => { failNext = true; };
    globalThis.__storageCompleteFastRequest = () => { completeFast = true; };
    export function usePluginData() {
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [data, setData] = useState({ companyId: "company-1", status: "ready", generatedAt: "2026-10-08T21:00:00Z", filesystem: { totalBytes: 1000, usedBytes: 720, availableBytes: 280, usedPercent: 72 }, directories: [], docker: [], history: [], alerts: [], coverage: { partial: false, notes: [] } });
      finish = () => { const failed = failNext; setError(failed ? { message: "safe test failure" } : null); failNext = false; if (!failed) setData((value) => ({ ...value, generatedAt: "2026-10-08T21:01:00Z" })); setLoading(false); };
      return { data, loading, error, refresh() { count += 1; setLoading(true); if (completeFast) { completeFast = false; setData((value) => ({ ...value, generatedAt: "2026-10-08T21:02:00Z" })); setLoading(false); } } };
    }
    export function useHostNavigation() { return { linkProps(path) { return { href: path }; } }; }
  `;
  let root;
  try {
    const outputFile = join(outputDir, "storage-ui.mjs");
    await build({
      entryPoints: [join(pluginRoot, "src/ui/index.tsx")],
      outfile: outputFile,
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["react", "react-dom/client"],
      plugins: [{
        name: "storage-test-sdk",
        setup(builder) {
          builder.onResolve({ filter: /^@paperclipai\/plugin-sdk\/ui$/ }, () => ({ path: "sdk-ui", namespace: "sdk-mock" }));
          builder.onLoad({ filter: /.*/, namespace: "sdk-mock" }, () => ({ contents: sdkMock, loader: "js" }));
        },
      }],
    });
    const ui = await import(pathToFileURL(outputFile).href);
    root = createRoot(dom.window.document.getElementById("root"));
    await act(async () => { root.render(createElement(ui.StoragePage, { context: { companyId: "company-1" } })); });
    assert.equal(intervalMs, 60_000, "the visible refresh interval is one minute");
    assert.ok(dom.window.document.querySelector("button"), "the manual refresh control remains available");
    assert.equal(dom.window.document.querySelector("button").disabled, true, "initial loading suppresses manual refresh");
    await act(async () => { globalThis.__storageFinishRequest(); });
    assert.equal(intervalCalls, 1, "rerenders do not install duplicate interval timers");
    assert.equal(dom.window.document.querySelector("button").disabled, false, "the manual control enables after initial load");

    visible = false;
    await act(async () => { timer(); });
    assert.equal(globalThis.__storageRefreshCount(), 0, "hidden pages do not poll");

    visible = true;
    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
      dom.window.dispatchEvent(new dom.window.Event("focus"));
    });
    assert.equal(globalThis.__storageRefreshCount(), 1, "visibility and focus events share one in-flight refresh");
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); });
    assert.equal(globalThis.__storageRefreshCount(), 1, "a second focus event cannot overlap the pending read");

    await act(async () => { globalThis.__storageFinishRequest(); });
    await act(async () => { timer(); });
    assert.equal(globalThis.__storageRefreshCount(), 2, "the one-minute timer refreshes after the earlier request completes");
    assert.equal(dom.window.document.querySelector("button").disabled, true, "a pending read disables manual refresh");
    await act(async () => { globalThis.__storageFinishRequest(); });
    await act(async () => { dom.window.document.querySelector("button").click(); });
    assert.equal(globalThis.__storageRefreshCount(), 3, "the manual refresh remains functional");
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); });
    assert.equal(globalThis.__storageRefreshCount(), 3, "manual and focus refreshes do not overlap");
    await act(async () => { globalThis.__storageFinishRequest(); });
    globalThis.__storageFailNextRequest();
    await act(async () => { timer(); });
    assert.equal(globalThis.__storageRefreshCount(), 4, "a visible timer retries after a completed request");
    await act(async () => { globalThis.__storageFinishRequest(); });
    assert.ok(dom.window.document.querySelector('[role="alert"]'), "request failures remain visible to the user");
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); });
    assert.equal(globalThis.__storageRefreshCount(), 5, "a failed request releases the guard for a later retry");
    await act(async () => { globalThis.__storageFinishRequest(); });
    globalThis.__storageCompleteFastRequest();
    await act(async () => { timer(); });
    assert.equal(globalThis.__storageRefreshCount(), 6, "a fast request may settle without a committed loading render");
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); });
    assert.equal(globalThis.__storageRefreshCount(), 7, "a batched fast completion also releases the refresh guard");
    await act(async () => { globalThis.__storageFinishRequest(); });
    await act(async () => { root.unmount(); });
    root = null;
    assert.equal(timerCleared, true, "unmount clears the periodic timer");
    const beforeUnmountEvent = globalThis.__storageRefreshCount();
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); });
    assert.equal(globalThis.__storageRefreshCount(), beforeUnmountEvent, "unmounted pages stop refreshing");
  } finally {
    if (root) await act(async () => { root.unmount(); });
    dom.window.close();
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
    delete globalThis.__storageRefreshCount;
    delete globalThis.__storageFinishRequest;
    delete globalThis.__storageFailNextRequest;
    delete globalThis.__storageCompleteFastRequest;
    await rm(outputDir, { recursive: true, force: true });
  }
});
