import { spawn as nodeSpawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_STOCK_LINE_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PENDING = 128;
const MAX_OWN_CONCURRENCY = 8;
const STOCK_TIMEOUT_MS = 5 * 60_000;
const API_TIMEOUT_MS = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_FIELDS = new Set(['seq', 'eventType', 'type', 'stream', 'timestamp']);
const SAFE_TOOL_META = new Set(['toolName', 'name', 'status', 'durationMs']);

const tool = (name, description, properties, required = []) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  },
});

const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const uuid = { type: 'string', format: 'uuid' };

export const OBSERVATORY_TOOLS = [
  tool('paperclipAgentHealthOverview', 'Summarize agent health for the configured Paperclip company.', {
    windowHours: integer(1, 168),
  }, ['windowHours']),
  tool('paperclipDiagnoseAgent', 'Diagnose one agent in the configured Paperclip company.', {
    agentId: uuid,
    windowHours: integer(1, 168),
  }, ['agentId', 'windowHours']),
  tool('paperclipListRunFailures', 'List recent failed runs for the configured Paperclip company.', {
    windowHours: integer(1, 168),
    limit: integer(1, 100),
  }, ['windowHours', 'limit']),
  tool('paperclipFindAgentAnomalies', 'Find agent anomalies for the configured Paperclip company.', {
    windowHours: integer(1, 168),
    limit: integer(1, 100),
  }, ['windowHours', 'limit']),
  tool('paperclipTraceRun', 'Trace a run summary and safe event metadata in the configured Paperclip company.', {
    runId: uuid,
  }, ['runId']),
];

const TOOL_ROUTES = new Map([
  ['paperclipAgentHealthOverview', { path: 'overview', params: ['windowHours'] }],
  ['paperclipDiagnoseAgent', { path: 'agent', params: ['agentId', 'windowHours'] }],
  ['paperclipListRunFailures', { path: 'failures', params: ['windowHours', 'limit'] }],
  ['paperclipFindAgentAnomalies', { path: 'anomalies', params: ['windowHours', 'limit'] }],
  ['paperclipTraceRun', { path: 'trace', params: ['runId'] }],
]);

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function asIdKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function validateConfig(env) {
  const apiUrl = env.PAPERCLIP_API_URL;
  const apiKey = env.PAPERCLIP_API_KEY;
  const companyId = env.PAPERCLIP_COMPANY_ID;
  if (!apiUrl || !apiKey || !companyId || !UUID_RE.test(companyId)) {
    throw new Error('bridge configuration is incomplete');
  }
  let parsed;
  try { parsed = new URL(apiUrl); } catch { throw new Error('bridge configuration is invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('bridge configuration is invalid');
  }
  return { apiBase: parsed.toString().replace(/\/$/, ''), apiKey, companyId };
}

function parseToolInput(name, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid input');
  const allowed = new Set(name === 'paperclipAgentHealthOverview' ? ['windowHours']
    : name === 'paperclipDiagnoseAgent' ? ['agentId', 'windowHours']
      : name === 'paperclipListRunFailures' || name === 'paperclipFindAgentAnomalies' ? ['windowHours', 'limit']
        : ['runId']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error('invalid input');
  const required = TOOL_ROUTES.get(name).params;
  for (const key of required) if (!Object.hasOwn(input, key)) throw new Error('invalid input');
  for (const key of ['agentId', 'runId']) if (key in input && (typeof input[key] !== 'string' || !UUID_RE.test(input[key]))) throw new Error('invalid input');
  for (const key of ['windowHours', 'limit']) if (key in input && (!Number.isInteger(input[key]) || input[key] < (key === 'limit' ? 1 : 1) || input[key] > (key === 'limit' ? 100 : 168))) throw new Error('invalid input');
  return input;
}

async function readBounded(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function safeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const result = {};
  for (const key of EVENT_FIELDS) {
    const value = key === 'timestamp' ? (event.timestamp ?? event.createdAt) : event[key];
    if (['string', 'number'].includes(typeof value) && (typeof value !== 'string' || value.length <= 200)) result[key] = value;
  }
  const metadataSources = [event, event.metadata, event.tool].filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
  if (metadataSources.length) {
    const safe = {};
    for (const key of SAFE_TOOL_META) {
      const value = metadataSources.map((source) => source[key]).find((candidate) => candidate !== undefined);
      if (['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'string' || value.length <= 300)) safe[key] = value;
    }
    if (Object.keys(safe).length) result.tool = safe;
  }
  return Object.keys(result).length ? result : null;
}

export class McpBridge {
  constructor({ env = process.env, spawn = nodeSpawn, fetchImpl = globalThis.fetch, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
    this.config = validateConfig(env);
    this.fetchImpl = fetchImpl;
    this.stdout = stdout;
    this.stderr = stderr;
    this.ownActive = 0;
    this.initialized = false;
    this.childUnavailable = false;
    this.pending = new Map();
    const command = env.PAPERCLIP_MCP_COMMAND || '/app/node_modules/.bin/paperclip-mcp-server';
    let args = [];
    if (env.PAPERCLIP_MCP_ARGS) {
      try {
        args = JSON.parse(env.PAPERCLIP_MCP_ARGS);
        if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new Error();
      } catch { throw new Error('bridge command configuration is invalid'); }
    }
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], env });
    this.child.stdout.on('data', (chunk) => this.onChildData(chunk));
    this.child.stdin.on('error', () => this.markUnavailable());
    this.child.on('error', () => this.markUnavailable());
    this.child.on('exit', () => {
      this.markUnavailable();
    });
    this.inputBuffer = Buffer.alloc(0);
    stdin.on('data', (chunk) => this.onInputData(chunk));
    stdin.on('end', () => { try { this.child.stdin.end(); } catch {} });
  }

  writeJson(value) {
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > MAX_STOCK_LINE_BYTES) return this.writeStderr('MCP response exceeded size limit');
    this.stdout.write(line);
  }

  writeStderr(message) { this.stderr.write(`${message}\n`); }

  markUnavailable() {
    if (this.childUnavailable) return;
    this.childUnavailable = true;
    this.writeStderr('MCP subprocess unavailable');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      this.writeJson(rpcError(pending.id, -32603, 'MCP subprocess unavailable'));
    }
    this.pending.clear();
  }

  onInputData(chunk) {
    this.inputBuffer = Buffer.concat([this.inputBuffer, Buffer.from(chunk)]);
    if (this.inputBuffer.length > MAX_LINE_BYTES && !this.inputBuffer.includes(0x0a)) {
      this.inputBuffer = Buffer.alloc(0);
      this.writeStderr('MCP input exceeded size limit');
      return;
    }
    while (true) {
      const newline = this.inputBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.inputBuffer.subarray(0, newline);
      this.inputBuffer = this.inputBuffer.subarray(newline + 1);
      if (!line.length) continue;
      if (line.length > MAX_LINE_BYTES) { this.writeStderr('MCP input exceeded size limit'); continue; }
      let message;
      try { message = JSON.parse(line.toString('utf8')); } catch { this.writeStderr('Invalid MCP input'); continue; }
      void this.handleMessage(message);
    }
  }

  onChildData(chunk) {
    this.childBuffer = Buffer.concat([this.childBuffer ?? Buffer.alloc(0), Buffer.from(chunk)]);
    if (this.childBuffer.length > MAX_STOCK_LINE_BYTES && !this.childBuffer.includes(0x0a)) {
      this.childBuffer = Buffer.alloc(0);
      this.writeStderr('MCP subprocess output exceeded size limit');
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        this.writeJson(rpcError(pending.id, -32001, 'MCP subprocess response exceeded size limit'));
      }
      this.pending.clear();
      return;
    }
    while (true) {
      const newline = this.childBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.childBuffer.subarray(0, newline);
      this.childBuffer = this.childBuffer.subarray(newline + 1);
      if (!line.length) continue;
      if (line.length > MAX_STOCK_LINE_BYTES) {
        this.writeStderr('MCP subprocess output exceeded size limit');
        let oversized;
        try { oversized = JSON.parse(line.toString('utf8')); } catch {}
        const pending = oversized?.id === undefined ? undefined : this.pending.get(asIdKey(oversized.id));
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(asIdKey(oversized.id));
          this.writeJson(rpcError(pending.id, -32001, 'MCP subprocess response exceeded size limit'));
        }
        continue;
      }
      let message;
      try { message = JSON.parse(line.toString('utf8')); } catch { this.writeStderr('Invalid MCP subprocess output'); continue; }
      if (message?.id !== undefined && !message.method) {
        const pending = this.pending.get(asIdKey(message.id));
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(asIdKey(message.id));
          if (pending.method === 'initialize' && !message.error) this.initialized = true;
          try { message = pending.transform(message); } catch { message = rpcError(pending.id, -32603, 'MCP response could not be processed'); }
        }
      }
      this.writeJson(message);
    }
  }

  async handleMessage(message) {
    if (!message || message.jsonrpc !== '2.0') return;
    if (typeof message.method !== 'string') {
      // A response to a server-initiated JSON-RPC request belongs to the stock
      // subprocess. Forward it unchanged and do not expect a reply.
      if (Object.hasOwn(message, 'id') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
        if (this.childUnavailable) this.writeStderr('MCP subprocess unavailable');
        else try { this.child.stdin.write(`${JSON.stringify(message)}\n`); } catch { this.markUnavailable(); }
      }
      return;
    }
    const id = message.id;
    const hasId = Object.hasOwn(message, 'id');
    if (message.method === 'tools/call' && TOOL_ROUTES.has(message.params?.name)) {
      if (!hasId) return;
      if (!this.initialized) return this.writeJson(rpcError(id, -32002, 'Initialize the MCP session first'));
      if (this.ownActive >= MAX_OWN_CONCURRENCY) return this.writeJson({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'Observatory is busy; retry shortly.' }] } });
      this.ownActive++;
      try {
        const result = await this.callOwnTool(message.params.name, message.params.arguments ?? {});
        this.writeJson({ jsonrpc: '2.0', id, result });
      } catch {
        this.writeJson({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'Observatory request failed. Check bridge configuration and plugin availability.' }] } });
      } finally { this.ownActive--; }
      return;
    }
    if (message.method === 'tools/list' && hasId) {
      if (this.pending.size >= MAX_PENDING) return this.writeJson(rpcError(id, -32000, 'Too many pending MCP requests'));
      const isInitialPage = message.params?.cursor === undefined;
      this.forward(message, 'tools/list', (response) => {
        if (response.error) return response;
        const tools = response.result?.tools;
        if (!Array.isArray(tools)) return response;
        const existing = new Set(tools.map((item) => item?.name).filter((name) => typeof name === 'string'));
        const conflicts = OBSERVATORY_TOOLS.filter((entry) => existing.has(entry.name));
        if (conflicts.length) return rpcError(id, -32603, 'MCP tool name conflict with Observatory bridge');
        if (!isInitialPage) return response;
        return { ...response, result: { ...response.result, tools: [...tools, ...OBSERVATORY_TOOLS] } };
      });
      return;
    }
    if (hasId && this.pending.size >= MAX_PENDING) return this.writeJson(rpcError(id, -32000, 'Too many pending MCP requests'));
    this.forward(message, message.method);
  }

  forward(message, method, transform = (response) => response) {
    if (this.childUnavailable) {
      if (Object.hasOwn(message, 'id')) this.writeJson(rpcError(message.id, -32603, 'MCP subprocess unavailable'));
      return;
    }
    if (!Object.hasOwn(message, 'id')) {
      try { this.child.stdin.write(`${JSON.stringify(message)}\n`); } catch { this.writeStderr('MCP subprocess unavailable'); }
      return;
    }
    const key = asIdKey(message.id);
    if (this.pending.has(key)) return this.writeJson(rpcError(message.id, -32600, 'Duplicate pending MCP request id'));
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.writeJson(rpcError(message.id, -32001, 'MCP subprocess request timed out'));
    }, STOCK_TIMEOUT_MS);
    this.pending.set(key, { id: message.id, method, timer, transform });
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); } catch {
      clearTimeout(timer);
      this.pending.delete(key);
      this.writeJson(rpcError(message.id, -32603, 'MCP subprocess unavailable'));
    }
  }

  async apiGet(path, params = {}) {
    const url = path.startsWith('/api/')
      ? new URL(`${this.config.apiBase}${path}`)
      : new URL(`${this.config.apiBase}/api/plugins/journey-studios.agent-observatory/api/${path}`);
    url.searchParams.set('companyId', this.config.companyId);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.config.apiKey}`, accept: 'application/json' },
        signal: controller.signal,
      });
      const text = await readBounded(response);
      if (!response.ok) throw new Error('upstream error');
      try { return JSON.parse(text); } catch { throw new Error('invalid upstream response'); }
    } finally { clearTimeout(timer); }
  }

  async callOwnTool(name, rawInput) {
    const input = parseToolInput(name, rawInput);
    const route = TOOL_ROUTES.get(name);
    const params = Object.fromEntries(route.params.map((key) => [key, input[key]]));
    const data = await this.apiGet(route.path, params);
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.companyId !== this.config.companyId) {
      throw new Error('company scope mismatch');
    }
    let result = data;
    if (name === 'paperclipTraceRun') {
      if (data && typeof data === 'object' && data.companyId === this.config.companyId) {
        try {
          const events = await this.apiGet(`/api/heartbeat-runs/${encodeURIComponent(input.runId)}/events`, { companyId: this.config.companyId, limit: 100 });
          if (events && !Array.isArray(events) && typeof events === 'object'
            && events.companyId !== undefined && events.companyId !== this.config.companyId) {
            throw new Error('event company scope mismatch');
          }
          const source = Array.isArray(events) ? events : Array.isArray(events?.events) ? events.events : [];
          const sanitized = source.slice(0, 100).map(safeEvent).filter(Boolean);
          const truncated = events?.eventsTruncated === true || events?.hasMore === true || source.length > 100 || source.length === 100;
          const lastSeq = sanitized.at(-1)?.seq;
          const upstreamNextSeq = events?.nextSeq;
          const nextSeq = (Number.isInteger(upstreamNextSeq) || typeof upstreamNextSeq === 'string')
            ? upstreamNextSeq
            : (truncated && Number.isInteger(lastSeq) ? lastSeq + 1 : null);
          result = { ...data, events: sanitized, coverage: {
            ...(data.coverage && typeof data.coverage === 'object' && !Array.isArray(data.coverage) ? data.coverage : {}),
            eventsAvailable: true,
            eventsTruncated: truncated,
            nextSeq,
          } };
        } catch {
          result = { ...data, events: [], coverage: {
            ...(data.coverage && typeof data.coverage === 'object' && !Array.isArray(data.coverage) ? data.coverage : {}),
            eventsAvailable: false,
            eventsUnavailable: true,
            eventsTruncated: null,
            nextSeq: null,
          } };
        }
      } else {
        result = { ...data, events: [], coverage: {
          ...(data.coverage && typeof data.coverage === 'object' && !Array.isArray(data.coverage) ? data.coverage : {}),
          eventsAvailable: false,
          eventsUnavailable: true,
          eventsTruncated: null,
          nextSeq: null,
        } };
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { new McpBridge(); } catch { process.stderr.write('MCP bridge configuration is invalid\n'); process.exitCode = 1; }
}
