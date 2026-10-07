import { test } from "node:test";
import assert from "node:assert/strict";
import { createPluginMcpEndpoint } from "../shared/mcp/index.js";

const companyId = "36a19923-c66d-4341-bf06-bb7e83bc5890";
const request = (method, params = {}, id = 1, overrides = {}) => ({
  method: "POST", actor: { actorType: "user", actorId: "tester" }, companyId,
  body: { jsonrpc: "2.0", id, method, params }, ...overrides,
});
let captured = null;
const handler = createPluginMcpEndpoint({
  name: "isolated-plugin", version: "1.0.0",
  tools: [{
    name: "read_summary", title: "Read Summary", description: "Company-scoped data",
    readOnly: true,
    inputSchema: { type: "object", properties: { windowHours: { type: "integer", minimum: 1, maximum: 168 } }, required: ["windowHours"], additionalProperties: false },
    async execute(args, ctx) { captured = { args, ctx }; return { companyId: ctx.companyId, count: 3 }; },
  }],
});
test("initialize, tools/list and tools/call with host-derived company context", async () => {
  assert.equal((await handler(request("initialize", { protocolVersion: "2025-03-26" }))).body.result.protocolVersion, "2025-11-25");
  assert.deepEqual((await handler(request("ping"))).body.result, {});
  const catalog = await handler(request("tools/list"));
  assert.deepEqual(catalog.body.result.tools.map((t) => t.name), ["read_summary"]);
  assert.equal(catalog.body.result.tools[0].annotations.readOnlyHint, true);
  const call = await handler(request("tools/call", { name: "read_summary", arguments: { windowHours: 24 } }));
  assert.equal(call.body.result.structuredContent.companyId, companyId);
  assert.equal(captured.ctx.companyId, companyId);
  assert.equal(call.headers["cache-control"], "no-store");
});
test("rejects company override, bounds, unknown tool and malformed requests", async () => {
  for (const argumentsValue of [{ windowHours: 0 }, { windowHours: 24, companyId: "another" }, { windowHours: "24" }, { windowHours: 169 }]) {
    const res = await handler(request("tools/call", { name: "read_summary", arguments: argumentsValue }));
    assert.equal(res.body.error.code, -32602);
  }
  assert.equal((await handler(request("tools/call", { name: "missing" }))).body.error.code, -32602);
  assert.equal((await handler({ ...request("tools/list"), body: [1, 2] })).body.error.code, -32600);
  assert.equal((await handler(request("something-unknown"))).body.error.code, -32601);
});
test("denies unsafe actors; rejects non-POST; accepts initialization notifications", async () => {
  assert.equal((await handler(request("tools/list", {}, 1, { actor: { actorType: "agent", actorId: "agent" } }))).status, 403);
  assert.equal((await handler(request("tools/list", {}, 1, { companyId: "wrong" }))).status, 403);
  assert.equal((await handler(request("tools/list", {}, 1, { method: "GET" }))).status, 405);
  assert.equal((await handler({ ...request("notifications/initialized"), body: { jsonrpc: "2.0", method: "notifications/initialized" } })).status, 202);
});
test("errors and oversized tool results do not leak data", async () => {
  const unsafe = createPluginMcpEndpoint({
    name: "safe", version: "1",
    tools: [
      { name: "thrower", title: "Throw", description: "x", readOnly: true, inputSchema: { type: "object", additionalProperties: false }, execute: async () => { throw new Error("SECRET-DO-NOT-LEAK"); } },
      { name: "huge", title: "Huge", description: "x", readOnly: true, inputSchema: { type: "object", additionalProperties: false }, execute: async () => ({ content: "x".repeat(800_000) }) },
    ],
  });
  for (const name of ["thrower", "huge"]) {
    const response = await unsafe(request("tools/call", { name, arguments: {} }));
    assert.equal(response.body.result.isError, true);
    assert.doesNotMatch(JSON.stringify(response), /SECRET-DO-NOT-LEAK|xxxxxxxxxxxxxxxxxxx/);
  }
  assert.throws(() => createPluginMcpEndpoint({ name: "a", version: "1", tools: [{ name: "write", execute: async () => {}, inputSchema: { type: "object" } }] }));
});
