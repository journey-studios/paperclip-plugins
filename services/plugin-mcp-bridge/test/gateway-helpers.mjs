import { PassThrough } from 'node:stream';
import { ConnectionsServer } from '../src/connections-server.mjs';

// Distinctive values so a leak into any output stream is easy to spot.
export const agentKey = 'agent-jwt-SECRET-key-value';
export const connectionsEnv = {
  PAPERCLIP_API_URL: 'http://127.0.0.1:3100',
  PAPERCLIP_API_KEY: agentKey,
  PAPERCLIP_COMPANY_ID: 'd9f67265-9c8f-4cbe-b91c-b3e0ea26da02',
  PAPERCLIP_AGENT_ID: '7067603c-5ee4-4db8-87f1-8c16a54f44a2',
  PAPERCLIP_RUN_ID: '150c11ef-4863-4a50-b4a3-95c1bf2b6224',
};
export const GATEWAY = '/api/tool-gateway';

export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const createClock = (start = Date.parse('2026-10-14T12:00:00Z')) => {
  const clock = { time: start, now: () => clock.time, advance: (ms) => { clock.time += ms; } };
  return clock;
};

/** A gateway tool descriptor shaped like the real list answer. */
export function descriptor(name, extra = {}) {
  return {
    name,
    displayName: name,
    description: `Run ${name}`,
    parametersSchema: { type: 'object', properties: { query: { type: 'string' } } },
    risk: 'read',
    applicationKey: 'posthog',
    applicationDisplayName: 'PostHog',
    connectionId: 'conn-1',
    upstreamToolName: name.split(':').at(-1),
    providerMetadata: { annotations: { readOnlyHint: true } },
    ...extra,
  };
}

export const completedEnvelope = (tool, result) => ({ invocationId: 'inv-1', status: 'completed', tool, result });

/**
 * In-memory stand-in for the Paperclip tool gateway. `handlers.<kind>(request)` can be replaced per
 * test; returning undefined is not special, so call `defaults.<kind>(request)` to fall through.
 * Every request is recorded with its headers, parsed body and abort signal.
 */
export function createGateway({ tools = [descriptor('mcp.posthog-1a2b3c4d:query-run')], clock = createClock(), ttlMs = 3_600_000 } = {}) {
  const requests = [];
  const state = { created: 0 };
  const gateway = { requests, tools, state };

  gateway.defaults = {
    create: () => {
      state.created++;
      return json(201, {
        sessionId: `session-${state.created}`,
        token: `gw-token-${state.created}`,
        expiresAt: new Date(clock.now() + ttlMs).toISOString(),
        toolsUrl: `${GATEWAY}/tools`,
        callUrl: `${GATEWAY}/tools/call`,
      });
    },
    list: () => json(200, gateway.tools),
    call: (request) => json(200, completedEnvelope(request.body.tool, {
      content: 'ok',
      data: { content: [{ type: 'text', text: 'ok' }], structuredContent: null, isError: false },
    })),
    revoke: () => json(200, {}),
  };
  gateway.handlers = { ...gateway.defaults };

  const kindOf = (path) => {
    if (path === `${GATEWAY}/sessions`) return 'create';
    if (path === `${GATEWAY}/tools`) return 'list';
    if (path === `${GATEWAY}/tools/call`) return 'call';
    if (/^\/api\/tool-gateway\/sessions\/[^/]+\/revoke$/.test(path)) return 'revoke';
    return undefined;
  };

  gateway.fetch = async (url, options = {}) => {
    const target = new URL(url);
    const request = {
      method: options.method,
      path: target.pathname,
      search: target.search,
      headers: { ...options.headers },
      body: options.body === undefined ? undefined : JSON.parse(options.body),
      signal: options.signal,
      redirect: options.redirect,
    };
    requests.push(request);
    const kind = kindOf(request.path);
    if (!kind) return json(404, { error: 'not found' });
    return gateway.handlers[kind](request);
  };

  gateway.ofKind = (kind) => requests.filter((request) => kindOf(request.path) === kind);
  gateway.tokenOf = (request) => request.headers['x-paperclip-tool-gateway-token'];
  return gateway;
}

const parseLines = (chunks) => chunks.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Run a ConnectionsServer on in-memory streams, with a tiny JSON-RPC client around it. */
export function makeConnections({ env = connectionsEnv, gateway, clock, fetchImpl } = {}) {
  const theClock = clock ?? createClock();
  const theGateway = gateway ?? createGateway({ clock: theClock });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = [];
  const err = [];
  stdout.on('data', (chunk) => out.push(chunk.toString()));
  stderr.on('data', (chunk) => err.push(chunk.toString()));
  const server = new ConnectionsServer({ env, fetchImpl: fetchImpl ?? theGateway.fetch, stdin, stdout, stderr, now: theClock.now });

  const received = () => parseLines(out);
  const waitFor = async (predicate, what = 'output') => {
    for (let i = 0; i < 5000; i++) {
      const value = predicate();
      if (value) return value;
      await tick();
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  let seq = 0;
  const send = (message) => stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const request = async (method, params) => {
    const id = ++seq;
    send({ id, method, params });
    return waitFor(() => received().find((entry) => entry.id === id), `answer to ${method}`);
  };
  // Start a request without waiting, to build concurrency scenarios.
  const start = (method, params) => {
    const id = ++seq;
    send({ id, method, params });
    return { id, answer: () => waitFor(() => received().find((entry) => entry.id === id), `answer to ${method}`) };
  };
  const initialize = () => request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
  const everything = () => `${out.join('')}${err.join('')}`;

  return {
    server, gateway: theGateway, clock: theClock, stdin, stdout, stderr,
    received, errors: () => err.join(''), everything, waitFor, send, request, start, initialize, settle,
  };
}

export const toolText = (result) => result.content.map((block) => block.text).join('\n');
