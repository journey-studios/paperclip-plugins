import { definePlugin } from "@paperclipai/plugin-sdk";
import { validateToolArguments } from "../../../shared/mcp/index.js";
import manifest from "./manifest.js";
import { validateConfig } from "./config.js";
import { StorageError, parseUuid } from "./catalog.js";
import {
  deleteNativeAttachment,
  finalizeNativeAttachment,
  prepareNativeAttachment,
  readNativeAttachment,
} from "./native-service.js";
import {
  createReadLink,
  finalizeUpload,
  getStatus,
  listMedia,
  loadConfig,
  prepareUpload,
  provisionBucket,
  testConnection,
} from "./service.js";

const handlers = {
  s3_storage_status: (_ctx, _companyId, config) => getStatus(config),
  s3_storage_test_connection: (ctx, companyId, config) => testConnection(ctx, companyId, config),
  s3_storage_list_objects: (ctx, companyId, config, args) => listMedia(ctx, companyId, config, args),
  s3_storage_prepare_upload: (ctx, companyId, config, args, actor) => prepareUpload(ctx, companyId, config, args, actor),
  s3_storage_finalize_upload: (ctx, companyId, config, args) => finalizeUpload(ctx, companyId, config, args.objectId),
  s3_storage_read_link: (ctx, companyId, config, args) => createReadLink(ctx, companyId, config, args.objectId),
  s3_storage_create_bucket: (ctx, companyId, config, args, actor) => provisionBucket(ctx, companyId, config, args, actor),
};

const toolBehavior = {
  s3_storage_status: { readOnly: true, idempotent: true },
  s3_storage_test_connection: { readOnly: false, idempotent: false },
  s3_storage_list_objects: { readOnly: true, idempotent: true },
  s3_storage_prepare_upload: { readOnly: false, idempotent: true },
  s3_storage_finalize_upload: { readOnly: false, idempotent: true },
  s3_storage_read_link: { readOnly: false, idempotent: false },
  s3_storage_create_bucket: { readOnly: false, idempotent: false },
};
const tools = manifest.tools.map((declaration) => {
  const execute = handlers[declaration.name];
  if (!execute) throw new Error(`Missing S3 storage handler for ${declaration.name}`);
  return {
    name: declaration.name,
    displayName: declaration.displayName,
    description: declaration.description,
    inputSchema: declaration.parametersSchema,
    execute,
    ...toolBehavior[declaration.name],
  };
});
const byTool = new Map(tools.map((tool) => [tool.name, tool]));

/** Builds a JSON-RPC error while leaving HTTP status handling to the route. */
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Redacts provider and secret details from tool-facing failures. */
function safeFailure(error) {
  if (error instanceof StorageError) return error.code.replaceAll("_", " ");
  return "S3 storage operation failed";
}

/** Requires board-authenticated user identity for direct API/MCP requests. */
function actorFromRequest(input) {
  const actor = input.actor;
  if (!actor || actor.actorType !== "user" || typeof actor.actorId !== "string") {
    throw new StorageError("board_authorization_required", 403);
  }
  return { actorType: actor.actorType, actorId: actor.actorId, runId: null };
}

/** Binds tool operations to the authenticated company, agent, and run context. */
function actorFromRun(runCtx) {
  if (!runCtx || typeof runCtx.companyId !== "string" || typeof runCtx.agentId !== "string" || typeof runCtx.runId !== "string") {
    throw new StorageError("agent_run_context_required", 403);
  }
  return { actorType: "agent", actorId: runCtx.agentId, runId: runCtx.runId };
}

/** Validates declared input before dispatching a company-scoped storage tool. */
async function invoke(ctx, companyId, config, tool, args, actor) {
  if (!validateToolArguments(tool.inputSchema, args)) throw new StorageError("invalid_tool_arguments");
  return tool.execute(ctx, companyId, config, args, actor);
}

/** Creates the board-authenticated JSON-RPC surface for plugin tools. */
function createMcpEndpoint(ctx) {
  return async (input) => {
    const headers = { "cache-control": "no-store" };
    if (input.method !== "POST") return { status: 405, headers, body: { error: "Method not allowed" } };
    let actor;
    let companyId;
    try {
      actor = actorFromRequest(input);
      companyId = parseUuid(input.companyId, "company_id");
    } catch {
      return { status: 403, headers, body: { error: "Board authorization required" } };
    }
    const body = input.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return { status: 200, headers, body: rpcError(null, -32600, "Invalid JSON-RPC request") };
    }
    if (body.method === "notifications/initialized") return { status: 202, headers, body: null };
    if (!Object.hasOwn(body, "id") || !["string", "number"].includes(typeof body.id) ||
        (typeof body.id === "string" && body.id.length > 120)) {
      return { status: 200, headers, body: rpcError(null, -32600, "Request id is required") };
    }
    const id = body.id;
    if (body.method === "initialize") return { status: 200, headers, body: { jsonrpc: "2.0", id, result: {
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: manifest.id, version: manifest.version },
    } } };
    if (body.method === "ping") return { status: 200, headers, body: { jsonrpc: "2.0", id, result: {} } };
    if (body.method === "tools/list") return { status: 200, headers, body: { jsonrpc: "2.0", id, result: { tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.displayName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: tool.idempotent, openWorldHint: true },
    })) } } };
    if (body.method !== "tools/call") return { status: 200, headers, body: rpcError(id, -32601, "Method not found") };
    const params = body.params;
    if (!params || typeof params !== "object" || Array.isArray(params) ||
        Object.keys(params).some((key) => !["name", "arguments"].includes(key)) || typeof params.name !== "string") {
      return { status: 200, headers, body: rpcError(id, -32602, "Invalid tool call") };
    }
    const tool = byTool.get(params.name);
    if (!tool) return { status: 200, headers, body: rpcError(id, -32602, "Unknown tool") };
    const args = params.arguments ?? {};
    if (!validateToolArguments(tool.inputSchema, args)) return { status: 200, headers, body: rpcError(id, -32602, "Invalid tool arguments") };
    try {
      const config = await loadConfig(ctx, companyId);
      const result = await invoke(ctx, companyId, config, tool, args, actor);
      const serialized = JSON.stringify(result);
      if (Buffer.byteLength(serialized) > 300_000) throw new StorageError("result_too_large", 422);
      return { status: 200, headers, body: { jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: serialized }],
        structuredContent: result && typeof result === "object" && !Array.isArray(result) ? result : { value: result },
        isError: false,
      } } };
    } catch (error) {
      return { status: 200, headers, body: { jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: safeFailure(error) }], isError: true,
      } } };
    }
  };
}

/** Maps storage failures to stable, non-sensitive API error bodies. */
function apiError(error) {
  if (error instanceof StorageError) return { status: error.status, body: { error: error.code } };
  return { status: 503, body: { error: "storage_operation_failed" } };
}

/** Accepts only string query values before route-specific numeric parsing. */
function queryValue(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new StorageError(`invalid_${label}`);
  return value;
}

/** Enforces the empty request contract used by status and connection routes. */
function emptyBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) throw new StorageError("invalid_request");
  return value;
}

let workerContext;
let mcpEndpoint;

const plugin = definePlugin({
  multiCompanyConfig: true,
  /** Validates company settings without resolving credentials into config output. */
  async onValidateConfig(config) { return validateConfig(config); },

  /** Registers plugin tools and context-bound status/MCP handlers once per worker. */
  async setup(ctx) {
    workerContext = ctx;
    mcpEndpoint = createMcpEndpoint(ctx);
    for (const tool of tools) {
      ctx.tools.register(tool.name, {
        displayName: tool.displayName,
        description: tool.description,
        parametersSchema: tool.inputSchema,
      }, async (params, runCtx) => {
        try {
          const actor = actorFromRun(runCtx);
          const companyId = parseUuid(runCtx.companyId, "company_id");
          const config = await loadConfig(ctx, companyId);
          const args = params && typeof params === "object" && !Array.isArray(params) ? { ...params } : {};
          if (["s3_storage_prepare_upload", "s3_storage_list_objects"].includes(tool.name) &&
              args.projectId === undefined && runCtx.projectId) args.projectId = runCtx.projectId;
          const result = await invoke(ctx, companyId, config, tool, args, actor);
          return { content: JSON.stringify(result), data: result };
        } catch (error) {
          return { error: safeFailure(error) };
        }
      });
    }
    ctx.data.register("status", async (params) => {
      const companyId = parseUuid(params?.companyId, "company_id");
      return getStatus(await loadConfig(ctx, companyId));
    });
  },

  /** Dispatches company-scoped API routes after board identity validation. */
  async onApiRequest(input) {
    const ctx = workerContext;
    if (!ctx) return { status: 503, body: { error: "worker_not_ready" } };
    if (input.routeKey === "mcp" || input.routeKey === "mcp-get") return mcpEndpoint(input);
    try {
      const actor = actorFromRequest(input);
      const companyId = parseUuid(input.companyId, "company_id");
      const config = await loadConfig(ctx, companyId);
      if (input.routeKey === "status") return { status: 200, headers: { "cache-control": "no-store" }, body: getStatus(config) };
      if (input.routeKey === "connection-test") return { status: 200, headers: { "cache-control": "no-store" }, body: await invoke(ctx, companyId, config, byTool.get("s3_storage_test_connection"), emptyBody(input.body), actor) };
      if (input.routeKey === "objects-list") {
        const projectId = queryValue(input.query.projectId, "project_id");
        const rawLimit = queryValue(input.query.limit, "limit");
        const limit = rawLimit === undefined ? undefined : /^\d+$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
        const args = { ...(projectId === undefined ? {} : { projectId }), ...(limit === undefined ? {} : { limit }) };
        return { status: 200, headers: { "cache-control": "no-store" }, body: await invoke(ctx, companyId, config, byTool.get("s3_storage_list_objects"), args, actor) };
      }
      if (input.routeKey === "upload-prepare") return { status: 200, headers: { "cache-control": "no-store" }, body: await invoke(ctx, companyId, config, byTool.get("s3_storage_prepare_upload"), input.body, actor) };
      if (input.routeKey === "upload-finalize") return { status: 200, headers: { "cache-control": "no-store" }, body: await invoke(ctx, companyId, config, byTool.get("s3_storage_finalize_upload"), { objectId: input.params.objectId }, actor) };
      if (input.routeKey === "object-download") return { status: 200, headers: { "cache-control": "no-store" }, body: await invoke(ctx, companyId, config, byTool.get("s3_storage_read_link"), { objectId: input.params.objectId }, actor) };
      if (input.routeKey === "bucket-create") return { status: 201, headers: { "cache-control": "no-store" }, body: await invoke(ctx, companyId, config, byTool.get("s3_storage_create_bucket"), input.body, actor) };
      if (input.routeKey === "native-prepare") return { status: 200, headers: { "cache-control": "no-store" }, body: await prepareNativeAttachment(ctx, companyId, config, input.body) };
      if (input.routeKey === "native-finalize") return { status: 200, headers: { "cache-control": "no-store" }, body: await finalizeNativeAttachment(ctx, companyId, config, input.body) };
      if (input.routeKey === "native-read") return { status: 200, headers: { "cache-control": "no-store" }, body: await readNativeAttachment(ctx, companyId, config, input.body) };
      if (input.routeKey === "native-delete") return { status: 200, headers: { "cache-control": "no-store" }, body: await deleteNativeAttachment(ctx, companyId, config, input.body) };
      return { status: 404, body: { error: "unknown_route" } };
    } catch (error) {
      return apiError(error);
    }
  },

  /** Reports worker readiness without returning company settings or secrets. */
  async onHealth() {
    return { status: "ok", message: "S3 Storage routes and tools are ready" };
  },
});

export default plugin;
