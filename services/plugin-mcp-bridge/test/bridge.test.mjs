import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as nodeSpawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { McpBridge, OBSERVATORY_TOOLS } from '../src/bridge.mjs';

const companyId = 'd9f67265-9c8f-4cbe-b91c-b3e0ea26da02';
const agentId = '7067603c-5ee4-4db8-87f1-8c16a54f44a2';
const runId = '150c11ef-4863-4a50-b4a3-95c1bf2b6224';
const env = {
  PAPERCLIP_API_URL: 'http://paperclip.test',
  PAPERCLIP_API_KEY: 'secret-test-value',
  PAPERCLIP_COMPANY_ID: companyId,
};

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.received = [];
  child.stdin.on('data', (buf) => {
    const message = JSON.parse(buf.toString());
    child.received.push(message);
    if (message.method === 'initialize') child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } } })}\n`);
    if (message.method === 'tools/list') {
      const tools = message.params?.cursor === 'collision' ? [{ name: OBSERVATORY_TOOLS[0].name }] : [{ name: 'existingTool' }];
      const nextCursor = message.params?.cursor ? 'stock-next-2' : 'stock-next-1';
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools, nextCursor } })}\n`);
    }
    if (message.method === 'ping') child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { pong: true } })}\n`);
  });
  return child;
}

function makeBridge({ fetchImpl = async () => new Response('{}'), bridgeEnv = env } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let child;
  const bridge = new McpBridge({
    env: bridgeEnv,
    spawn: (...args) => { child = fakeChild(); child.spawnArgs = args; return child; },
    fetchImpl,
    stdin,
    stdout,
    stderr,
  });
  const output = [];
  const errors = [];
  stdout.on('data', (chunk) => output.push(chunk.toString()));
  stderr.on('data', (chunk) => errors.push(chunk.toString()));
  return { bridge, stdin, stdout, stderr, child: () => child, output, errors };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const messages = (items) => items.join('').trim().split('\n').filter(Boolean).map(JSON.parse);

test('tools/list forwards stock tools and adds exactly the five fixed tools after initialize', async () => {
  const ctx = makeBridge();
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  await flush();
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  await flush();
  const firstPage = messages(ctx.output).find((entry) => entry.id === 2).result;
  const result = firstPage.tools;
  assert.equal(result[0].name, 'existingTool');
  assert.equal(firstPage.nextCursor, 'stock-next-1');
  assert.deepEqual(result.slice(1).map((entry) => entry.name), OBSERVATORY_TOOLS.map((entry) => entry.name));
  assert.deepEqual(ctx.child().received.map((entry) => entry.method), ['initialize', 'tools/list']);
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { cursor: 'stock-next' } })}\n`);
  await flush();
  const secondPage = messages(ctx.output).find((entry) => entry.id === 3).result;
  assert.deepEqual(secondPage.tools.map((entry) => entry.name), ['existingTool']);
  assert.equal(secondPage.nextCursor, 'stock-next-2');
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: { cursor: 'collision' } })}\n`);
  await flush();
  assert.match(messages(ctx.output).find((entry) => entry.id === 4).error.message, /tool name conflict/);
});

test('client responses to stock server-initiated JSON-RPC requests are forwarded unchanged', async () => {
  const ctx = makeBridge();
  ctx.child().stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'server-request-1', method: 'roots/list', params: {} })}\n`);
  await flush();
  assert.deepEqual(messages(ctx.output)[0], { jsonrpc: '2.0', id: 'server-request-1', method: 'roots/list', params: {} });
  const clientResponse = { jsonrpc: '2.0', id: 'server-request-1', result: { roots: [] } };
  ctx.stdin.write(`${JSON.stringify(clientResponse)}\n`);
  await flush();
  assert.deepEqual(ctx.child().received[0], clientResponse);
  assert.equal(ctx.output.length, 1);
});

test('own tool calls are pinned to configured company and never accept company overrides', async () => {
  const requests = [];
  const ctx = makeBridge({ fetchImpl: async (url, options) => {
    requests.push({ url: new URL(url), options });
    return new Response(JSON.stringify({ ok: true, companyId }), { status: 200 });
  } });
  ctx.bridge.initialized = true;
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'paperclipDiagnoseAgent', arguments: { agentId, windowHours: 24 } } })}\n`);
  await flush();
  const response = messages(ctx.output)[0];
  assert.equal(response.result.isError, undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.searchParams.get('companyId'), companyId);
  assert.equal(requests[0].url.searchParams.get('agentId'), agentId);
  assert.equal(requests[0].options.headers.authorization, `Bearer ${env.PAPERCLIP_API_KEY}`);

  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'paperclipAgentHealthOverview', arguments: { windowHours: 24, companyId: '00000000-0000-4000-8000-000000000000' } } })}\n`);
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(messages(ctx.output).find((entry) => entry.id === 2).result.isError, true);
});

test('trace enriches only same-company summary and filters native events to safe fields', async () => {
  const calls = [];
  const ctx = makeBridge({ fetchImpl: async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    if (parsed.pathname.endsWith('/trace')) return new Response(JSON.stringify({ companyId, runId, status: 'succeeded', coverage: { rawLogsAvailable: true, eventsTruncated: false } }));
    return new Response(JSON.stringify({ events: [
      { seq: 4, eventType: 'tool_call', stream: 'stdout', timestamp: '2026-10-07T12:00:00Z', payload: 'do not return', metadata: { toolName: 'httpGet', status: 'ok', durationMs: 31, apiKey: 'never' } },
      { seq: 5, type: 'log', createdAt: '2026-10-07T12:01:00Z', raw: 'private log text' },
    ] }));
  } });
  ctx.bridge.initialized = true;
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'paperclipTraceRun', arguments: { runId } } })}\n`);
  await flush(); await flush();
  const value = JSON.parse(messages(ctx.output)[0].result.content[0].text);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].pathname, `/api/heartbeat-runs/${runId}/events`);
  assert.equal(calls[1].searchParams.get('limit'), '100');
  assert.deepEqual(value.events, [{ seq: 4, eventType: 'tool_call', stream: 'stdout', timestamp: '2026-10-07T12:00:00Z', tool: { toolName: 'httpGet', status: 'ok', durationMs: 31 } }, { seq: 5, type: 'log', timestamp: '2026-10-07T12:01:00Z' }]);
  assert.deepEqual(value.coverage, { rawLogsAvailable: true, eventsTruncated: false, eventsAvailable: true, nextSeq: null });
});

test('same-company proof is required before reading native run events', async () => {
  let calls = 0;
  const ctx = makeBridge({ fetchImpl: async () => { calls++; return new Response(JSON.stringify({ companyId: '00000000-0000-4000-8000-000000000000', runId })); } });
  ctx.bridge.initialized = true;
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'paperclipTraceRun', arguments: { runId } } })}\n`);
  await flush();
  assert.equal(calls, 1);
  assert.match(ctx.output.join(''), /Observatory request failed/);
});

test('HTTP errors and oversized API bodies return a generic error without upstream text', async () => {
  const errorCtx = makeBridge({ fetchImpl: async () => new Response('private token response body', { status: 500 }) });
  errorCtx.bridge.initialized = true;
  errorCtx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'paperclipAgentHealthOverview', arguments: { windowHours: 24 } } })}\n`);
  await flush();
  const errorOutput = errorCtx.output.join('');
  assert.match(errorOutput, /Observatory request failed/);
  assert.doesNotMatch(errorOutput, /private token response body/);
  assert.doesNotMatch(errorCtx.errors.join(''), /secret-test-value|private token/);

  const largeCtx = makeBridge({ fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) });
  largeCtx.bridge.initialized = true;
  largeCtx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'paperclipAgentHealthOverview', arguments: { windowHours: 24 } } })}\n`);
  await flush();
  assert.match(largeCtx.output.join(''), /Observatory request failed/);
});

test('a response that claims another company is rejected before any trace event read', async () => {
  let calls = 0;
  const ctx = makeBridge({ fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ companyId: '00000000-0000-4000-8000-000000000000', private: 'foreign data' }));
  } });
  ctx.bridge.initialized = true;
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'paperclipTraceRun', arguments: { runId } } })}\n`);
  await flush();
  const output = ctx.output.join('');
  assert.equal(calls, 1);
  assert.match(output, /Observatory request failed/);
  assert.doesNotMatch(output, /foreign data|00000000-0000/);
});

test('a response without exact company proof is rejected for an Observatory tool', async () => {
  const ctx = makeBridge({ fetchImpl: async () => new Response(JSON.stringify({ runId, status: 'succeeded' })) });
  ctx.bridge.initialized = true;
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'paperclipTraceRun', arguments: { runId } } })}\n`);
  await flush();
  assert.match(ctx.output.join(''), /Observatory request failed/);
  assert.doesNotMatch(ctx.output.join(''), /succeeded/);
});

test('process protocol preserves stock JSON-RPC IDs and notifications while intercepting list', async (t) => {
  const serverScript = String.raw`process.stdin.setEncoding('utf8'); let b=''; process.stdin.on('data',c=>{b+=c; for(;;){const i=b.indexOf('\n'); if(i<0)break; const l=b.slice(0,i); b=b.slice(i+1); if(!l)continue; const m=JSON.parse(l); if(m.id===undefined) { process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n'); continue; } const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}}}:m.method==='tools/list'?{tools:[{name:'stock'}]}:{pong:true}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n'); }});`;
  const bridgeFile = fileURLToPath(new URL('../src/bridge.mjs', import.meta.url));
  const child = nodeSpawn(process.execPath, [bridgeFile], {
    env: { ...process.env, ...env, PAPERCLIP_MCP_COMMAND: process.execPath, PAPERCLIP_MCP_ARGS: JSON.stringify(['-e', serverScript]) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let buffer = '';
  const received = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      received.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const waitFor = async (predicate) => {
    for (let i = 0; i < 30 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(predicate(), 'expected protocol response was not received');
  };
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'init-id', method: 'initialize', params: {} })}\n`);
  await waitFor(() => received.some((item) => item.id === 'init-id'));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 72, method: 'tools/list' })}\n`);
  await waitFor(() => received.some((item) => item.id === 72));
  const listed = received.find((item) => item.id === 72);
  assert.equal(listed.result.tools[0].name, 'stock');
  assert.equal(listed.result.tools.length, 6);
  assert.equal(received.find((item) => item.method === 'notifications/initialized')?.id, undefined);
});
