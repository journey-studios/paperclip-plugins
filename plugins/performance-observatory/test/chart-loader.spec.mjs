import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCharts } from "../src/ui/chart-loader.js";

test("chart discovery can retry after a transient failure without reloading the page", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const originalLibrary = globalThis.JourneyPerformanceECharts;
  let requests = 0;
  const library = {};
  globalThis.fetch = async () => {
    requests++;
    if (requests === 1) return new Response("", { status: 503 });
    return new Response(JSON.stringify([{ pluginKey: "journey-studios.performance-observatory", pluginId: "11111111-1111-4111-8111-111111111111" }]));
  };
  globalThis.document = {
    createElement: () => ({ remove() {} }),
    head: { append: (script) => queueMicrotask(() => { globalThis.JourneyPerformanceECharts = library; script.onload(); }) },
  };
  try {
    await assert.rejects(loadCharts(), /CHART_ASSET_DISCOVERY_FAILED/);
    assert.equal(await loadCharts(), library);
    assert.equal(requests, 2);
    assert.equal(await loadCharts(), library);
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    globalThis.JourneyPerformanceECharts = originalLibrary;
  }
});
