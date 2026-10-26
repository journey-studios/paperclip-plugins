import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { transform } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

test("the native image page uses the authenticated Board API, renders and refreshes an image without sending its URL through the plugin bridge", async (t) => {
  const source = await readFile(new URL("../src/ui/index.tsx", import.meta.url), "utf8");
  const transformed = await transform(source, { loader: "tsx", format: "esm", jsx: "transform" });
  const require = createRequire(import.meta.url);
  const code = transformed.code
    .replace('from "react"', `from ${JSON.stringify(pathToFileURL(require.resolve("react")).href)}`)
    .replace('from "@paperclipai/plugin-sdk/ui"', `from ${JSON.stringify(import.meta.resolve("@paperclipai/plugin-sdk/ui"))}`);
  const { SocialMediaPreviewPage } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const dom = new JSDOM('<div id="app"></div>', { url: "https://paper.example/JOU/social-media-preview" });
  const companyId = randomUUID();
  const mediaId = randomUUID();
  const original = new Map();
  const setGlobal = (key, value) => {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  setGlobal("window", dom.window);
  setGlobal("document", dom.window.document);
  setGlobal("navigator", dom.window.navigator);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setGlobal("__paperclipPluginBridge__", { sdkUi: { useHostLocation: () => ({ search: `?mediaId=${mediaId}` }) } });
  t.after(() => {
    for (const [key, descriptor] of original)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    dom.window.close();
  });
  let calls = 0;
  let denied = false;
  let messages = 0;
  t.mock.method(dom.window, "postMessage", () => { messages++; });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls++;
    assert.equal(url, `/api/plugins/journey-studios.social-publisher/api/media/${mediaId}/preview?companyId=${companyId}`);
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-store");
    assert.equal(options.referrerPolicy, "no-referrer");
    if (denied) return new Response("{}", { status: 403 });
    return new Response(JSON.stringify({ companyId, data: {
      downloadUrl: `https://private-images.example/editorial.jpg?X-Amz-Signature=test-${calls}`,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      media: { sha256: "a".repeat(64), width: 1254, height: 1254 },
    } }));
  });
  const root = createRoot(dom.window.document.getElementById("app"));
  try {
    await act(async () => { root.render(React.createElement(SocialMediaPreviewPage, { context: { companyId } })); });
    const first = dom.window.document.querySelector("img");
    assert.ok(first);
    assert.equal(first.getAttribute("referrerpolicy"), "no-referrer");
    assert.match(first.getAttribute("src"), /test-1$/);
    assert.ok(!dom.window.document.body.textContent.includes("X-Amz-"));
    await act(async () => { dom.window.document.querySelector("button").click(); });
    assert.match(dom.window.document.querySelector("img").getAttribute("src"), /test-2$/);
    denied = true;
    await act(async () => { dom.window.document.querySelector("button").click(); });
    assert.equal(dom.window.document.querySelector("img"), null);
    assert.match(dom.window.document.querySelector('[role="alert"]').textContent, /Acesso reservado ao fundador/);
    assert.equal(messages, 0);
  } finally {
    await act(async () => { root.unmount(); });
  }
});
