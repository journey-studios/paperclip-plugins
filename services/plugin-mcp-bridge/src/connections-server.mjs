import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRecord } from './dashboards.mjs';
import { GatewayClient } from './gateway-client.mjs';
import { createJsonlReader } from './jsonl-reader.mjs';

/**
 * MCP stdio server that hands an agent run the external-connection tools (PostHog, ...) which
 * Paperclip allows that agent to use, through the Paperclip tool gateway.
 *
 * It is registered once in the agent CLI. The CLI starts it as a child process for every run, and
 * that child inherits the run's environment, which is the only place its credential comes from:
 * nothing secret belongs in the CLI's MCP config. Governance (which tools exist for the agent,
 * read-only enforcement, approvals, audit) stays in Paperclip; this process only relays.
 *
 * Deliberately separate from `bridge.mjs`: it does not start the official Paperclip MCP server,
 * because agents already reach the Paperclip API through the `paperclip` skill.
 */

const SERVER_NAME = 'paperclip-connections';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';
const MAX_CONCURRENT_CALLS = 8;
// Model-facing clients (Gemini among them) accept function names of [A-Za-z0-9_-], 64 chars at most.
const SAFE_NAME_MAX = 64;
const HASH_LENGTH = 8;
// Text that Paperclip authored (errors, instructions, summaries) is cut so a verbose upstream
// message cannot flood the model's context.
const MAX_PAPERCLIP_TEXT = 2000;

const UNAVAILABLE_TEXT = 'Paperclip connections are only available inside an active agent run.';
const FAILED_TEXT = 'Paperclip could not complete this tool call. This may be temporary.';
const APPROVAL_FALLBACK_TEXT = 'Paperclip requires approval before this tool can run. Do not repeat this call; end the run and wait for the approval.';
const INJECTION_TEXT = 'Paperclip blocked this tool call because it was flagged as a possible prompt injection.';
const REPLAY_NOTE = '(This is the result of an identical call made earlier in this run; Paperclip did not run the tool again.)';

function readVersion() {
  try {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof version === 'string' ? version : 'unknown';
  } catch { return 'unknown'; }
}
const SERVER_VERSION = readVersion();

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

function limitText(text) {
  return text.length > MAX_PAPERCLIP_TEXT ? `${text.slice(0, MAX_PAPERCLIP_TEXT - 3)}...` : text;
}

const errorResult = (text) => ({ isError: true, content: [{ type: 'text', text: limitText(text) }] });

/**
 * Map gateway tool names to names a model client accepts. The gateway names tools like
 * `mcp.posthog-1a2b3c4d:query-run`; this drops the `mcp.` prefix and replaces every character
 * outside [A-Za-z0-9_-] with `_`. A name that would exceed 64 characters, or that would collide with
 * another name of the same list, instead keeps a truncated readable part and gets `_` plus 8 hex
 * characters of the sha256 of its original name. Both sides of a collision are suffixed, so the
 * outcome never depends on listing order. Pure and deterministic: the same list always yields the
 * same names. Returns `Map<gatewayName, safeName>` in list order.
 */
export function toSafeToolNames(gatewayNames) {
  const readable = (name) => (name.startsWith('mcp.') ? name.slice(4) : name).replace(/[^A-Za-z0-9_-]/g, '_') || 'tool';
  const unique = [...new Set(gatewayNames)];
  const uses = new Map();
  for (const name of unique) uses.set(readable(name), (uses.get(readable(name)) ?? 0) + 1);

  const assigned = new Map();
  const taken = new Set();
  const needsHash = [];
  for (const name of unique) {
    const base = readable(name);
    if (base.length <= SAFE_NAME_MAX && uses.get(base) === 1) {
      assigned.set(name, base);
      taken.add(base);
    } else {
      needsHash.push(name);
    }
  }
  // Hashed names are assigned after every readable one so they can never steal a readable name.
  for (const name of needsHash) {
    const base = readable(name).slice(0, SAFE_NAME_MAX - HASH_LENGTH - 1);
    let candidate;
    // The salt only matters if two different names collide on 8 hex characters: astronomically
    // unlikely, but silently routing a call to the wrong tool is not an acceptable failure mode.
    for (let salt = 0; ; salt++) {
      const digest = createHash('sha256').update(salt === 0 ? name : `${name}#${salt}`).digest('hex').slice(0, HASH_LENGTH);
      candidate = `${base}_${digest}`;
      if (!taken.has(candidate)) break;
    }
    assigned.set(name, candidate);
    taken.add(candidate);
  }
  return new Map(unique.map((name) => [name, assigned.get(name)]));
}

function toolDescriptor(entry, safeName) {
  const annotations = entry.providerMetadata?.annotations;
  return {
    name: safeName,
    description: typeof entry.description === 'string' ? entry.description : '',
    inputSchema: isRecord(entry.parametersSchema) ? entry.parametersSchema : { type: 'object' },
    ...(isRecord(annotations) ? { annotations } : {}),
  };
}

function isContentBlockList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((block) => isRecord(block) && typeof block.type === 'string');
}

function completedResult(result) {
  const data = isRecord(result) && isRecord(result.data) ? result.data : {};
  let content;
  if (isContentBlockList(data.content)) {
    content = data.content;
  } else if (isRecord(result) && typeof result.content === 'string') {
    content = [{ type: 'text', text: result.content }];
  } else {
    content = [{ type: 'text', text: JSON.stringify(result ?? null) }];
  }
  // HTTP stays 200 when the upstream tool itself reported an error; the envelope's `error` marks it.
  const upstreamError = isRecord(result) && result.error !== undefined && result.error !== null && result.error !== false;
  return {
    content,
    ...(isRecord(data.structuredContent) ? { structuredContent: data.structuredContent } : {}),
    ...(data.isError === true || upstreamError ? { isError: true } : {}),
  };
}

function replayedResult(result) {
  const summary = isRecord(result) && typeof result.summary === 'string' ? limitText(result.summary) : '';
  return { content: [{ type: 'text', text: summary ? `${summary}\n\n${REPLAY_NOTE}` : REPLAY_NOTE }] };
}

function refusedResult(outcome) {
  if (outcome.httpStatus === 409 && outcome.codes.includes('approval_required')) {
    // Paperclip's own instructions tell the agent not to retry and to end the run until approval.
    return errorResult(outcome.instructions || APPROVAL_FALLBACK_TEXT);
  }
  if (outcome.httpStatus === 422 && outcome.codes.includes('prompt_injection_blocked')) {
    return errorResult(INJECTION_TEXT);
  }
  const reason = outcome.error ? `: ${outcome.error}` : '.';
  return errorResult(`Paperclip did not run this tool${reason}`);
}

function failedResult(outcome) {
  // Only a short code is shown: gateway failure bodies can carry upstream execution details.
  return errorResult(outcome.reasonCode ? `${FAILED_TEXT} (${outcome.reasonCode})` : FAILED_TEXT);
}

/** Translate a gateway call outcome into an MCP `tools/call` result. Never forwards a raw body. */
function translateCallOutcome(outcome) {
  if (outcome.kind === 'unavailable') return errorResult(UNAVAILABLE_TEXT);
  if (outcome.kind === 'refused') return refusedResult(outcome);
  if (outcome.kind !== 'ok') return failedResult(outcome);
  const { status, result } = outcome.envelope;
  if (status === 'completed') return completedResult(result);
  if (status === 'replayed') return replayedResult(result);
  return failedResult({});
}

export class ConnectionsServer {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, now = Date.now } = {}) {
    // Throws on an unusable API URL before anything is attached to the streams.
    this.client = new GatewayClient({ env, fetchImpl, now });
    this.stdout = stdout;
    this.stderr = stderr;
    this.initialized = false;
    this.activeCalls = 0;
    this.toolNames = new Map();
    this.unavailableReported = false;
    this.shutdownPromise = null;
    this.reportIfUnavailable();
    // When the CLI goes away its pipes close with it. Answers still in flight at that point have
    // nowhere to go, and the resulting EPIPE must not crash the shutdown (which revokes the session).
    stdout.on('error', () => {});
    const input = createJsonlReader({
      onMessage: (message) => { void this.handleMessage(message); },
      onDiagnostic: (message) => this.writeStderr(message),
    });
    stdin.on('data', (chunk) => input.push(chunk));
    // The CLI closing our stdin is how a run's MCP servers are normally stopped.
    stdin.on('end', () => { void this.shutdown(); });
  }

  writeJson(value) { this.stdout.write(`${JSON.stringify(value)}\n`); }

  writeStderr(message) { this.stderr.write(`${message}\n`); }

  /** Idempotent: revokes the gateway session (best effort) and stops in-flight requests. */
  shutdown() {
    this.shutdownPromise ??= this.client.close();
    return this.shutdownPromise;
  }

  reportIfUnavailable() {
    if (!this.client.unavailable || this.unavailableReported) return;
    this.unavailableReported = true;
    this.writeStderr('Paperclip connections are unavailable outside an active agent run');
  }

  async handleMessage(message) {
    if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
    const hasId = Object.hasOwn(message, 'id');
    const { id, method } = message;
    if (hasId && typeof id !== 'string' && typeof id !== 'number') {
      return this.writeJson(rpcError(null, -32600, 'Invalid request id'));
    }
    try {
      if (method === 'initialize' && hasId) return this.writeJson(rpcResult(id, this.initializeResult(message.params)));
      if (method === 'ping' && hasId) return this.writeJson(rpcResult(id, {}));
      if (method === 'tools/list' && hasId) return await this.handleToolsList(id);
      if (method === 'tools/call' && hasId) return await this.handleToolsCall(id, message.params);
      // Notifications (initialized, cancelled, ...) need no action and never get an answer.
      if (hasId) this.writeJson(rpcError(id, -32601, 'Method not found'));
    } catch {
      if (hasId) this.writeJson(rpcError(id, -32603, 'Internal error'));
    }
  }

  initializeResult(params) {
    const requested = isRecord(params) ? params.protocolVersion : undefined;
    this.initialized = true;
    return {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
  }

  /** Read the catalog from the gateway and remember which safe name maps to which gateway tool. */
  async refreshCatalog() {
    const outcome = await this.client.listTools();
    this.reportIfUnavailable();
    if (outcome.kind !== 'ok') return outcome;
    const safeNames = toSafeToolNames(outcome.tools.map((entry) => entry.name));
    const lookup = new Map();
    const tools = [];
    for (const entry of outcome.tools) {
      const safeName = safeNames.get(entry.name);
      // A name listed twice would otherwise appear twice under one safe name.
      if (lookup.has(safeName)) continue;
      lookup.set(safeName, entry.name);
      tools.push(toolDescriptor(entry, safeName));
    }
    this.toolNames = lookup;
    return { kind: 'ok', tools };
  }

  async handleToolsList(id) {
    // Always ask the gateway: the allowed set changes with approvals and admin decisions mid-run.
    const outcome = await this.refreshCatalog();
    if (outcome.kind === 'unavailable') return this.writeJson(rpcResult(id, { tools: [] }));
    if (outcome.kind !== 'ok') {
      this.writeStderr('Paperclip tool gateway request failed');
      return this.writeJson(rpcError(id, -32603, 'Paperclip connections are temporarily unavailable.'));
    }
    this.writeJson(rpcResult(id, { tools: outcome.tools }));
  }

  async handleToolsCall(id, params) {
    if (!this.initialized) return this.writeJson(rpcError(id, -32002, 'Initialize the MCP session first'));
    const args = isRecord(params) && params.arguments !== undefined ? params.arguments : {};
    if (!isRecord(params) || typeof params.name !== 'string' || !params.name || !isRecord(args)) {
      return this.writeJson(rpcError(id, -32602, 'Invalid params'));
    }
    if (this.client.unavailable) return this.writeJson(rpcResult(id, errorResult(UNAVAILABLE_TEXT)));
    if (this.activeCalls >= MAX_CONCURRENT_CALLS) {
      return this.writeJson(rpcResult(id, errorResult('Paperclip connections are busy; retry shortly.')));
    }
    this.activeCalls++;
    try {
      await this.runTool(id, params.name, args);
    } finally {
      this.activeCalls--;
    }
  }

  async runTool(id, safeName, args) {
    let gatewayName = this.toolNames.get(safeName);
    if (!gatewayName) {
      // The allowed set can grow mid-run (an approval was granted), so reread once before refusing.
      const refreshed = await this.refreshCatalog();
      if (refreshed.kind !== 'ok') return this.writeJson(rpcResult(id, translateCallOutcome(refreshed)));
      gatewayName = this.toolNames.get(safeName);
      if (!gatewayName) return this.writeJson(rpcError(id, -32602, 'Unknown tool'));
    }
    const outcome = await this.client.callTool(gatewayName, args);
    this.reportIfUnavailable();
    if (outcome.kind === 'failed') this.writeStderr('Paperclip tool gateway request failed');
    this.writeJson(rpcResult(id, translateCallOutcome(outcome)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const server = new ConnectionsServer();
    const stop = () => { void server.shutdown().finally(() => process.exit(0)); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch {
    process.stderr.write('Paperclip connections server configuration is invalid\n');
    process.exitCode = 1;
  }
}
