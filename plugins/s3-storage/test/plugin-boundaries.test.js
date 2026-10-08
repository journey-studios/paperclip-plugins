import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../dist/worker.js";
import manifest from "../src/manifest.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const ACCESS_REF = { type: "secret_ref", secretId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const SECRET_REF = { type: "secret_ref", secretId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const rawConfig = {
  provider: "s3",
  endpoint: "https://objects.example.test",
  region: "us-east-1",
  bucket: "journey-media",
  accessKeyIdRef: ACCESS_REF,
  secretAccessKeyRef: SECRET_REF,
};

function input(overrides = {}) {
  return {
    routeKey: "mcp",
    method: "POST",
    path: "/mcp",
    params: {},
    query: { companyId: COMPANY },
    body: { jsonrpc: "2.0", id: 7, method: "ping" },
    actor: { actorType: "user", actorId: "board-user" },
    companyId: COMPANY,
    headers: {},
    ...overrides,
  };
}

function makeContext(companyConfig = rawConfig) {
  const calls = { companyReads: [], configReads: [], tools: new Map(), data: new Map() };
  const ctx = {
    companies: { get: async (id) => {
      calls.companyReads.push(id);
      return [COMPANY, OTHER_COMPANY].includes(id) ? { id } : null;
    } },
    config: { get: async (id) => {
      calls.configReads.push(id);
      return companyConfig;
    } },
    tools: { register: (name, declaration, handler) => calls.tools.set(name, { declaration, handler }) },
    data: { register: (name, handler) => calls.data.set(name, handler) },
  };
  return { ctx, calls };
}

test("MCP tool discovery reports read-only and mutating annotations from actual handlers", async () => {
  const { ctx } = makeContext();
  await plugin.definition.setup(ctx);
  const response = await plugin.definition.onApiRequest(input({
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  }));
  assert.equal(response.status, 200);
  const tools = response.body.result.tools;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.get("s3_storage_status").annotations, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  });
  assert.deepEqual(byName.get("s3_storage_list_objects").annotations, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
  });
  for (const [name, idempotent] of [
    ["s3_storage_test_connection", false],
    ["s3_storage_prepare_upload", true],
    ["s3_storage_finalize_upload", true],
    ["s3_storage_read_link", false],
    ["s3_storage_create_bucket", false],
  ]) {
    assert.deepEqual(byName.get(name).annotations, {
      readOnlyHint: false, destructiveHint: false, idempotentHint: idempotent, openWorldHint: true,
    });
  }
});

test("MCP rejects caller-supplied tenant identity and unauthenticated board requests", async () => {
  const { ctx, calls } = makeContext();
  await plugin.definition.setup(ctx);
  const forged = await plugin.definition.onApiRequest(input({
    body: {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "s3_storage_status", arguments: { companyId: OTHER_COMPANY } },
    },
  }));
  assert.equal(forged.status, 200);
  assert.equal(forged.body.error.code, -32602);
  assert.match(forged.body.error.message, /invalid tool arguments/i);
  assert.deepEqual(calls.companyReads, []);

  const valid = await plugin.definition.onApiRequest(input({
    body: {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "s3_storage_status", arguments: {} },
    },
  }));
  assert.equal(valid.body.result.isError, false);
  assert.equal(valid.body.result.structuredContent.configured, true);
  assert.deepEqual(calls.companyReads, [COMPANY]);

  const unauthenticated = await plugin.definition.onApiRequest(input({ actor: undefined }));
  assert.equal(unauthenticated.status, 403);
});

test("API company scope comes from the host request context and rejects forged body scope", async () => {
  const { ctx, calls } = makeContext();
  await plugin.definition.setup(ctx);
  const status = await plugin.definition.onApiRequest(input({
    routeKey: "status",
    method: "GET",
    query: { companyId: OTHER_COMPANY },
    companyId: COMPANY,
  }));
  assert.equal(status.status, 200);
  assert.deepEqual(calls.companyReads, [COMPANY]);
  assert.deepEqual(calls.configReads, [COMPANY]);

  const forged = await plugin.definition.onApiRequest(input({
    routeKey: "upload-prepare",
    body: {
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
      filename: "clip.webm",
      contentType: "video/webm",
      size: 1,
      sha256: "a".repeat(64),
      companyId: OTHER_COMPANY,
    },
  }));
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error, "invalid_tool_arguments");
});

test("native registered tool requires run identity and rejects scope override arguments", async () => {
  const { ctx, calls } = makeContext();
  await plugin.definition.setup(ctx);
  const statusTool = calls.tools.get("s3_storage_status");
  const denied = await statusTool.handler({}, { companyId: COMPANY });
  assert.match(denied.error, /agent run context required/i);
  const valid = await statusTool.handler({}, {
    companyId: COMPANY,
    agentId: "agent-1",
    runId: "run-1",
  });
  assert.equal(valid.data.configured, true);

  const prepareTool = calls.tools.get("s3_storage_prepare_upload");
  const rejected = await prepareTool.handler({
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
    filename: "clip.webm",
    contentType: "video/webm",
    size: 1,
    sha256: "a".repeat(64),
    companyId: OTHER_COMPANY,
  }, { companyId: COMPANY, agentId: "agent-1", runId: "run-1" });
  assert.match(rejected.error, /invalid tool arguments/i);
  assert.deepEqual(calls.companyReads, [COMPANY, COMPANY]);
  assert.deepEqual(calls.configReads, [COMPANY, COMPANY]);
  assert.equal(manifest.tools.find((tool) => tool.name === "s3_storage_prepare_upload").parametersSchema.additionalProperties, false);
});

test("native routes require explicit company enablement and reject foreign object keys", async () => {
  const disabled = makeContext({ ...rawConfig, enableNativeAttachments: false });
  await plugin.definition.setup(disabled.ctx);
  const status = await plugin.definition.onApiRequest(input({ routeKey: "status", method: "GET", body: undefined }));
  assert.equal(status.status, 200);
  assert.equal(status.body.nativeAttachmentsEnabled, false);
  const off = await plugin.definition.onApiRequest(input({
    routeKey: "native-prepare",
    body: { objectKey: `${COMPANY}/attachments/id`, filename: "x.png", contentType: "image/png", size: 1, sha256: "a".repeat(64) },
  }));
  assert.equal(off.status, 403);
  assert.equal(off.body.error, "native_attachments_disabled");

  const enabled = makeContext({ ...rawConfig, enableNativeAttachments: true });
  await plugin.definition.setup(enabled.ctx);
  const foreign = await plugin.definition.onApiRequest(input({
    routeKey: "native-prepare",
    body: { objectKey: `${OTHER_COMPANY}/attachments/id`, filename: "x.png", contentType: "image/png", size: 1, sha256: "a".repeat(64) },
  }));
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error, "company_scope_violation");
  assert.deepEqual(enabled.calls.companyReads, [COMPANY]);
  assert.ok(manifest.apiRoutes.some((route) => route.routeKey === "native-delete" && route.auth === "board"));
});
