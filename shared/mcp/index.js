/**
 * Stateless MCP-over-HTTP JSON-RPC adapter for Paperclip plugin-scoped JSON routes.
 * Bundled INTO each plugin worker; not a standalone plugin, gateway or server.
 *
 * Identity, board authentication, and company authorization are enforced by
 * Paperclip's declared apiRoutes before onApiRequest runs. The handler ONLY
 * uses the companyId injected by that trusted host, never one from arguments.
 */
export const MCP_PROTOCOL_VERSION = "2025-11-25";
const MAX_RESULT_BYTES = 300_000;
const MAX_INPUT_STRING = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

export function validateToolArguments(schema, value) {
  if (!object(value)) return false;
  const props = schema.properties ?? {};
  if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(props, key))) return false;
  if ((schema.required ?? []).some((key) => !Object.hasOwn(value, key))) return false;
  for (const [key, item] of Object.entries(value)) {
    const property = props[key];
    if (!property) continue;
    if (property.type === "integer" && !Number.isSafeInteger(item)) return false;
    if (property.type === "number" && (typeof item !== "number" || !Number.isFinite(item))) return false;
    if (property.type === "boolean" && typeof item !== "boolean") return false;
    if (property.type === "string" && (typeof item !== "string" || item.length > MAX_INPUT_STRING)) return false;
    if (property.format === "uuid" && (typeof item !== "string" || !UUID.test(item))) return false;
    if (property.minimum !== undefined && item < property.minimum) return false;
    if (property.maximum !== undefined && item > property.maximum) return false;
    if (property.minLength !== undefined && (typeof item !== "string" || item.length < property.minLength)) return false;
    if (property.maxLength !== undefined && (typeof item !== "string" || item.length > property.maxLength)) return false;
    if (Array.isArray(property.enum) && !property.enum.includes(item)) return false;
  }
  return true;
}

/**
 * Each plugin supplies its own domain-backed read-only tool definitions.
 * This adapter never creates a run, impersonates an agent, or accesses the DB.
 */
export function createPluginMcpEndpoint({ name, version, tools }) {
  if (!name || !version || !Array.isArray(tools)) throw new Error("Invalid MCP server declaration");
  const byName = new Map();
  for (const tool of tools) {
    if (!tool.name || byName.has(tool.name) || typeof tool.execute !== "function" ||
        tool.inputSchema?.type !== "object" || tool.readOnly !== true) {
      throw new Error("Invalid or duplicate read-only MCP tool");
    }
    byName.set(tool.name, tool);
  }

  return async function handlePluginMcpApi(input) {
    const headers = { "cache-control": "no-store" };
    if (input.method !== "POST") return { status: 405, headers, body: { error: "Method not allowed" } };
    // Host apiRoutes auth=board plus companyResolution/authorization protects the
    // endpoint. This extra check prevents accidental reuse under agent/webhook auth.
    if (input.actor?.actorType !== "user" || !UUID.test(input.companyId ?? "")) {
      return { status: 403, headers, body: { error: "Board authorization required" } };
    }
    const body = input.body;
    if (!object(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return { status: 200, headers, body: rpcError(null, -32600, "Invalid JSON-RPC request") };
    }
    if (body.method.startsWith("notifications/")) {
      // Host JSON routes cannot send an empty 202; SDK clients ignore its
      // JSON-null body, so preserve the MCP-required 202 status.
      return { status: 202, headers, body: null };
    }
    if (!Object.hasOwn(body, "id") || (typeof body.id !== "string" && typeof body.id !== "number")) {
      return { status: 200, headers, body: rpcError(null, -32600, "Request id is required") };
    }
    const id = body.id;
    if (typeof id === "string" && id.length > 120) {
      return { status: 200, headers, body: rpcError(null, -32600, "Invalid request id") };
    }

    if (body.method === "initialize") {
      return { status: 200, headers, body: rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name, version },
      }) };
    }
    if (body.method === "ping") return { status: 200, headers, body: rpcResult(id, {}) };
    if (body.method === "tools/list") return { status: 200, headers, body: rpcResult(id, {
      tools: tools.map(({ name: toolName, title, description, inputSchema }) => ({
        name: toolName, title, description, inputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      })),
    }) };

    if (body.method !== "tools/call") {
      return { status: 200, headers, body: rpcError(id, -32601, "Method not found") };
    }
    const params = body.params;
    const nameValue = object(params) ? params.name : undefined;
    const declared = byName.get(nameValue);
    if (!declared) return { status: 200, headers, body: rpcError(id, -32602, "Unknown tool") };
    const args = params.arguments ?? {};
    if (!validateToolArguments(declared.inputSchema, args)) {
      return { status: 200, headers, body: rpcError(id, -32602, "Invalid tool arguments") };
    }
    try {
      const data = await declared.execute(args, { companyId: input.companyId, actor: input.actor });
      const serialized = JSON.stringify(data);
      if (typeof serialized !== "string" || Buffer.byteLength(serialized) > MAX_RESULT_BYTES) {
        throw new Error("Result exceeds safe response limit");
      }
      return { status: 200, headers, body: rpcResult(id, {
        content: [{ type: "text", text: serialized }],
        structuredContent: object(data) ? data : { value: data },
        isError: false,
      }) };
    } catch {
      return { status: 200, headers, body: rpcResult(id, {
        content: [{ type: "text", text: "Tool execution failed or result unavailable" }],
        isError: true,
      }) };
    }
  };
}
