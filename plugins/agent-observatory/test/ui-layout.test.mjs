import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("Observatory lays out actions, agent identities, and scrollable metrics without host SVG defaults", async () => {
  const outputDir = await mkdtemp(join(pluginRoot, ".ui-layout-test-"));
  try {
    const outputFile = join(outputDir, "ui.mjs");
    const sdkMock = [
      'const overview = {companyId:"company-1",windowHours:24,generatedAt:"2026-10-07T19:00:00Z",summary:{runsTotal:2,successes:1,failures:1,retries:0,knownCostCents:155,unknownCostRuns:1},agents:[{id:"123e4567-e89b-12d3-a456-426614174000",name:"Research & Evidence Analyst",health:"healthy",status:"idle",runs:2,failures:1,retries:0,knownCostCents:155,unknownCostRuns:1,avgDurationMs:60000,lastError:"ALLOWLISTED_ERROR_CODE",lastRunId:"223e4567-e89b-12d3-a456-426614174000"}],coverage:{rawLogsAvailable:false,eventsAvailable:false}};',
      'export function usePluginData(route) {return {data:route==="overview"?overview:null,loading:false,error:null,refresh(){}};}',
      'export function useHostNavigation() {return {linkProps(path){return {href:path};}};}',
    ].join("\n");

    await build({
      entryPoints: [join(pluginRoot, "src/ui/index.tsx")],
      outfile: outputFile,
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["react"],
      plugins: [{
        name: "test-plugin-sdk-ui",
        setup(builder) {
          builder.onResolve({ filter: /^@paperclipai\/plugin-sdk\/ui$/ }, () => ({ path: "sdk-ui", namespace: "sdk-mock" }));
          builder.onLoad({ filter: /.*/, namespace: "sdk-mock" }, () => ({ contents: sdkMock, loader: "js" }));
        },
      }],
    });
    const { ObservatoryPage } = await import(pathToFileURL(outputFile).href);
    const markup = renderToStaticMarkup(createElement(ObservatoryPage, { context: { companyId: "company-1" } }));
    const dom = new JSDOM(markup);
    const { document, getComputedStyle } = dom.window;

    const refresh = document.querySelector(".refresh-button");
    assert.ok(refresh, "Refresh action is rendered");
    assert.equal(getComputedStyle(refresh).display, "inline-flex");
    const refreshIcon = refresh.querySelector("svg");
    assert.equal(getComputedStyle(refreshIcon).width, "1rem", "Icons have an explicit width");
    assert.equal(getComputedStyle(refreshIcon).height, "1rem", "Icons have an explicit height");

    const table = document.querySelector("table.agent-table");
    assert.ok(table, "Agent metrics have their own table layout");
    assert.equal(getComputedStyle(table).tableLayout, "fixed");
    assert.equal(table.querySelectorAll("th").length, 9);
    const scrollingRegion = table.closest(".scroll");
    assert.equal(scrollingRegion.getAttribute("tabindex"), "0");
    assert.equal(scrollingRegion.getAttribute("role"), "region");

    const name = table.querySelector(".agent-name");
    const id = table.querySelector(".agent-id");
    assert.equal(name.textContent, "Research & Evidence Analyst");
    assert.equal(id.textContent, "123e4567-e89b-12d3-a456-426614174000");
    assert.equal(id.getAttribute("title"), id.textContent);
    assert.equal(getComputedStyle(name).display, "block");
    assert.equal(getComputedStyle(id).display, "block", "UUID is on a separate line");
    assert.equal(getComputedStyle(id).textOverflow, "ellipsis", "Long UUIDs cannot expand a column");
    assert.equal(getComputedStyle(table.querySelector(".last-error-text")).textOverflow, "ellipsis");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
