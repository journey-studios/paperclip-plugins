import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DASHBOARD_TOOLS, OBSERVATORY_TOOLS, ROADMAP_TOOLS } from '../src/bridge.mjs';
import { companyId, agentId, runId, env, makeBridge, flush, messages } from './helpers.mjs';

test('bearer API URLs require HTTPS unless loopback or explicitly allowed', () => {
  const accepted = ['https://paperclip.test', 'http://localhost:3100', 'http://127.0.0.1:3100', 'http://[::1]:3100'];
  for (const url of accepted) {
    assert.doesNotThrow(() => makeBridge({ bridgeEnv: { ...env, PAPERCLIP_API_URL: url } }));
  }
  assert.doesNotThrow(() => makeBridge({ bridgeEnv: { ...env, PAPERCLIP_API_URL: 'http://paperclip:3100', PAPERCLIP_ALLOW_INSECURE_HTTP: '1' } }));
  for (const url of ['http://paperclip.test', 'http://localhost.evil.test', 'ftp://paperclip.test', 'https://user:password@paperclip.test', 'http://user:password@localhost']) {
    assert.throws(() => makeBridge({ bridgeEnv: { ...env, PAPERCLIP_API_URL: url } }), /configuration is invalid/);
  }
  for (const optIn of [undefined, '0', 'true']) {
    assert.throws(() => makeBridge({ bridgeEnv: { ...env, PAPERCLIP_API_URL: 'http://paperclip:3100', PAPERCLIP_ALLOW_INSECURE_HTTP: optIn } }), /configuration is invalid/);
  }
});

test('tools/list forwards stock tools and adds exactly the five Observatory, ten Dashboards and five roadmap tools after initialize', async () => {
  const ctx = makeBridge();
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  await flush();
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  await flush();
  const firstPage = messages(ctx.output).find((entry) => entry.id === 2).result;
  const result = firstPage.tools;
  assert.equal(result[0].name, 'existingTool');
  assert.equal(firstPage.nextCursor, 'stock-next-1');
  assert.deepEqual(result.slice(1).map((entry) => entry.name), [...OBSERVATORY_TOOLS, ...DASHBOARD_TOOLS, ...ROADMAP_TOOLS].map((entry) => entry.name));
  assert.deepEqual(ctx.child().received.map((entry) => entry.method), ['initialize', 'tools/list']);
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { cursor: 'stock-next' } })}\n`);
  await flush();
  const secondPage = messages(ctx.output).find((entry) => entry.id === 3).result;
  assert.deepEqual(secondPage.tools.map((entry) => entry.name), ['existingTool']);
  assert.equal(secondPage.nextCursor, 'stock-next-2');
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: { cursor: 'collision' } })}\n`);
  await flush();
  assert.match(messages(ctx.output).find((entry) => entry.id === 4).error.message, /tool name conflict/);
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: { cursor: 'collision-dashboards' } })}\n`);
  await flush();
  assert.match(messages(ctx.output).find((entry) => entry.id === 5).error.message, /tool name conflict/);
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list', params: { cursor: 'collision-roadmap' } })}\n`);
  await flush();
  assert.match(messages(ctx.output).find((entry) => entry.id === 6).error.message, /tool name conflict/);
});

const listChangedCount = (ctx) => messages(ctx.output).filter((entry) => entry.method === 'notifications/tools/list_changed').length;
const writeLine = (ctx, message) => ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

test('initialize advertises tools.listChanged and keeps every other part of the stock answer', async () => {
  const stock = {
    protocolVersion: '2025-03-26',
    serverInfo: { name: 'stock', version: '9.9.9' },
    capabilities: { tools: { subscribe: false }, resources: { listChanged: false }, logging: {} },
    instructions: 'Use the tools.',
  };
  const ctx = makeBridge({ initializeResult: stock });
  writeLine(ctx, { id: 'init', method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  await flush();
  const answer = messages(ctx.output).find((entry) => entry.id === 'init');
  assert.deepEqual(answer.result, { ...stock, capabilities: { ...stock.capabilities, tools: { subscribe: false, listChanged: true } } });
  assert.deepEqual(ctx.child().received[0], { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-03-26' } });

  const plain = makeBridge();
  writeLine(plain, { id: 1, method: 'initialize', params: {} });
  await flush();
  assert.deepEqual(messages(plain.output)[0].result, { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true } } });

  // Without a tools capability (or with listChanged switched off) the bridge still promises the notification.
  for (const capabilities of [{}, { logging: {} }, { tools: { listChanged: false } }]) {
    const other = makeBridge({ initializeResult: { protocolVersion: '2025-03-26', capabilities } });
    writeLine(other, { id: 1, method: 'initialize', params: {} });
    await flush();
    const result = messages(other.output)[0].result;
    assert.equal(result.capabilities.tools.listChanged, true);
    assert.deepEqual({ ...result.capabilities, tools: undefined }, { ...capabilities, tools: undefined });
  }
});

test('initialize errors and answers without a result object are relayed unchanged', async () => {
  const failing = makeBridge({ initializeError: { code: -32603, message: 'stock failed' } });
  writeLine(failing, { id: 1, method: 'initialize', params: {} });
  await flush();
  assert.deepEqual(messages(failing.output), [{ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'stock failed' } }]);
  assert.equal(failing.bridge.initialized, false);
  writeLine(failing, { method: 'notifications/initialized' });
  await flush();
  assert.equal(listChangedCount(failing), 0, 'no notification without a successful handshake');

  const odd = makeBridge({ initializeResult: 'not an object' });
  writeLine(odd, { id: 1, method: 'initialize', params: {} });
  await flush();
  assert.equal(messages(odd.output)[0].result, 'not an object');
});

test('tools/list_changed is sent once, only after the initialize answer and the initialized notification', async () => {
  const ctx = makeBridge();
  writeLine(ctx, { id: 1, method: 'initialize', params: {} });
  await flush();
  assert.deepEqual(messages(ctx.output).map((entry) => entry.id ?? entry.method), [1], 'nothing but the initialize answer yet');
  writeLine(ctx, { method: 'notifications/initialized' });
  await flush();
  const sent = messages(ctx.output);
  assert.deepEqual(sent.map((entry) => entry.id ?? entry.method), [1, 'notifications/tools/list_changed']);
  assert.deepEqual(sent[1], { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  assert.deepEqual(ctx.child().received.map((entry) => entry.method), ['initialize', 'notifications/initialized'], 'the notification still reaches the stock server');
  assert.equal(ctx.child().received[1].id, undefined);

  // Never again, however often the client repeats itself or uses the session.
  writeLine(ctx, { method: 'notifications/initialized' });
  writeLine(ctx, { id: 2, method: 'tools/list' });
  writeLine(ctx, { id: 3, method: 'ping' });
  writeLine(ctx, { method: 'notifications/initialized' });
  await flush();
  assert.equal(listChangedCount(ctx), 1);
  assert.deepEqual(ctx.child().received.map((entry) => entry.method), ['initialize', 'notifications/initialized', 'notifications/initialized', 'tools/list', 'ping', 'notifications/initialized']);
  assert.deepEqual(messages(ctx.output).find((entry) => entry.id === 3).result, { pong: true });
  assert.ok(messages(ctx.output).find((entry) => entry.id === 2).result.tools.length > 1);
});

test('tools/list_changed can never precede the initialize answer, even if the client confirms too early', async () => {
  const ctx = makeBridge();
  writeLine(ctx, { method: 'notifications/initialized' });
  await flush();
  assert.equal(listChangedCount(ctx), 0, 'no initialize answer has been sent yet');
  assert.deepEqual(ctx.child().received.map((entry) => entry.method), ['notifications/initialized'], 'still forwarded as before');
  writeLine(ctx, { id: 1, method: 'initialize', params: {} });
  await flush();
  assert.equal(listChangedCount(ctx), 0, 'the handshake is not complete until the client confirms');
  writeLine(ctx, { method: 'notifications/initialized' });
  await flush();
  const order = messages(ctx.output).map((entry) => entry.id ?? entry.method);
  assert.deepEqual(order, [1, 'notifications/tools/list_changed']);
});

test('tools/list_changed is not sent when the stock server is gone', async () => {
  const ctx = makeBridge();
  writeLine(ctx, { id: 1, method: 'initialize', params: {} });
  await flush();
  ctx.child().emit('exit');
  writeLine(ctx, { method: 'notifications/initialized' });
  await flush();
  assert.equal(listChangedCount(ctx), 0);
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
    // Two real node processes start here; under parallel CI load that can take well over 300 ms.
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(predicate(), 'expected protocol response was not received');
  };
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'init-id', method: 'initialize', params: {} })}\n`);
  await waitFor(() => received.some((item) => item.id === 'init-id'));
  const initAnswer = received.find((item) => item.id === 'init-id');
  assert.deepEqual(initAnswer.result.capabilities, { tools: { listChanged: true } });
  assert.equal(received.some((item) => item.method === 'notifications/tools/list_changed'), false, 'not before the client confirms');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  await waitFor(() => received.some((item) => item.method === 'notifications/tools/list_changed'));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 72, method: 'tools/list' })}\n`);
  await waitFor(() => received.some((item) => item.id === 72));
  assert.equal(received.filter((item) => item.method === 'notifications/tools/list_changed').length, 1);
  assert.ok(received.indexOf(initAnswer) < received.findIndex((item) => item.method === 'notifications/tools/list_changed'));
  const listed = received.find((item) => item.id === 72);
  assert.equal(listed.result.tools[0].name, 'stock');
  assert.equal(listed.result.tools.length, 1 + OBSERVATORY_TOOLS.length + DASHBOARD_TOOLS.length + ROADMAP_TOOLS.length);
  assert.equal(received.find((item) => item.method === 'notifications/initialized')?.id, undefined);
});
