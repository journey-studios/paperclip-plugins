import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBridge, flush, messages, env } from './helpers.mjs';

const profile = { id: 'human-test-id', name: 'Test User', email: 'test@example.invalid', image: null };
const stockAgentResult = { content: [{ type: 'text', text: JSON.stringify({ id: 'agent-test-id', companyId: env.PAPERCLIP_COMPANY_ID, role: 'engineer', keyScope: { kind: 'task_bridge' } }) }] };
const stockBoardError = { content: [{ type: 'text', text: JSON.stringify({ status: 401, path: '/agents/me', body: { error: 'Agent authentication required' } }) }] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const invoke = (ctx, id = 'identity-1', args = {}) => ctx.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'paperclipMe', arguments: args } }) + '\n');
const result = (ctx, id = 'identity-1') => messages(ctx.output).find((message) => message.id === id);
const value = (message) => JSON.parse(message.result.content[0].text);
const settle = async () => { await flush(); await flush(); };

test('paperclipMe resolves a human board profile instead of returning agent-only 401', async () => {
  const requests = [];
  const ctx = makeBridge({
    stockCallResult: stockBoardError,
    fetchImpl: async (url, options) => { requests.push({ url: String(url), options }); return json(profile); },
  });
  ctx.bridge.initialized = true;
  invoke(ctx);
  await settle();
  const response = result(ctx);
  assert.notEqual(response.result.isError, true);
  assert.deepEqual(value(response), { actorType: 'board', ...profile });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://paperclip.test/api/auth/profile');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.authorization, `Bearer ${env.PAPERCLIP_API_KEY}`);
  assert.equal(requests[0].options.headers.cookie, undefined);
  assert.equal(ctx.child().received.length, 0, 'a human is never sent to the agent endpoint');
  assert.doesNotMatch(ctx.output.join('') + ctx.errors.join(''), /secret-test-value/);
});

test('an agent uses the unchanged native self view including scoped fields', async () => {
  let probes = 0;
  const ctx = makeBridge({ stockCallResult: stockAgentResult, fetchImpl: async () => {
    probes++;
    return json({ error: 'Board authentication required' }, 401);
  } });
  ctx.bridge.initialized = true;
  invoke(ctx, 9);
  await settle();
  assert.equal(probes, 1);
  assert.deepEqual(result(ctx, 9).result, stockAgentResult);
  assert.deepEqual(ctx.child().received[0].params, { name: 'paperclipMe', arguments: {} });
  assert.equal(ctx.bridge.pending.size, 0);
  assert.equal(ctx.bridge.identityPending.size, 0);
});

test('a native agent denial stays a denial after the board-type probe', async () => {
  const denial = { isError: true, content: [{ type: 'text', text: '{"status":403,"error":"Access denied"}' }] };
  const ctx = makeBridge({ stockCallResult: denial, fetchImpl: async () => json({ error: 'Board authentication required' }, 401) });
  ctx.bridge.initialized = true;
  invoke(ctx);
  await settle();
  assert.deepEqual(result(ctx).result, denial);
});

for (const [status, detail, code] of [
  [401, 'Expired agent token; obtain fresh credentials and retry', 'identity_unauthorized'],
  [401, 'Agent token did not verify; obtain fresh credentials and retry', 'identity_unauthorized'],
  [401, 'Signed-in user not found', 'identity_unauthorized'],
  [403, 'Forbidden', 'identity_forbidden'],
  [404, 'API route not found', 'identity_upstream_error'],
  [429, 'Rate limit', 'identity_upstream_error'],
  [500, 'Internal error secret-test-value', 'identity_upstream_error'],
]) {
  test(`HTTP ${status} (${detail.split(';')[0]}) never fabricates or escalates identity`, async () => {
    const ctx = makeBridge({ stockCallResult: stockAgentResult, fetchImpl: async () => json({ error: detail, token: 'private-upstream-token' }, status) });
    ctx.bridge.initialized = true;
    invoke(ctx);
    await settle();
    assert.equal(result(ctx).result.isError, true);
    assert.equal(value(result(ctx)).status, status);
    assert.equal(value(result(ctx)).code, code);
    assert.equal(ctx.child().received.length, 0);
    assert.doesNotMatch(ctx.output.join('') + ctx.errors.join(''), /private-upstream-token|secret-test-value/);
  });
}

for (const malformed of [null, [], {}, { ...profile, id: '' }, { ...profile, id: ' '.repeat(3) }, { ...profile, id: 'a'.repeat(257) }, { ...profile, name: 123 }, { ...profile, email: 'a'.repeat(321) }, { ...profile, image: { token: 'hidden' } }]) {
  test(`a malformed profile fails closed (${JSON.stringify(malformed).slice(0,40)})`, async () => {
    const ctx = makeBridge({ stockCallResult: stockAgentResult, fetchImpl: async () => json(malformed) });
    ctx.bridge.initialized = true;
    invoke(ctx);
    await settle();
    assert.equal(value(result(ctx)).code, 'identity_invalid_response');
    assert.equal(ctx.child().received.length, 0);
  });
}

test('profile output is allowlisted and never contains session/key/role fields', async () => {
  const ctx = makeBridge({ fetchImpl: async () => json({ ...profile, token: 'private-upstream-token', session: { token: 'secret-test-value' }, role: 'admin', isInstanceAdmin: true, agentId: 'forged-agent', companyId: 'forged-company' }) });
  ctx.bridge.initialized = true;
  invoke(ctx);
  await settle();
  assert.deepEqual(value(result(ctx)), { actorType: 'board', ...profile });
  assert.doesNotMatch(ctx.output.join(''), /private-upstream-token|secret-test-value|isInstanceAdmin|agentId|companyId/);
});

test('nullable human fields are accepted and an api suffix is not doubled', async () => {
  let path;
  const ctx = makeBridge({ bridgeEnv: { ...env, PAPERCLIP_API_URL: 'https://paperclip.test/api/' }, fetchImpl: async (url) => {
    path = String(url);
    return json({ id: 'human', name: null, email: null, image: null });
  } });
  ctx.bridge.initialized = true;
  invoke(ctx);
  await settle();
  assert.equal(path, 'https://paperclip.test/api/auth/profile');
  assert.equal(value(result(ctx)).actorType, 'board');
});

test('identity is checked each time: a revoked board key does not reuse cached success', async () => {
  let calls = 0;
  const ctx = makeBridge({ fetchImpl: async () => ++calls === 1 ? json(profile) : json({ error: 'Invalid key' }, 401) });
  ctx.bridge.initialized = true;
  invoke(ctx, 1);
  await settle();
  invoke(ctx, 2);
  await settle();
  assert.equal(value(result(ctx, 1)).actorType, 'board');
  assert.equal(value(result(ctx, 2)).code, 'identity_unauthorized');
  assert.equal(calls, 2);
});

for (const [label, fetchImpl, code] of [
  ['invalid JSON', async () => new Response('not-json-with-private-upstream-token'), 'identity_invalid_response'],
  ['network/redirect rejection', async () => { throw new Error('secret-test-value in fetch URL'); }, 'identity_unavailable'],
  ['oversized profile', async () => new Response('x'.repeat(64 * 1024 + 1)), 'identity_unavailable'],
  ['no content', async () => new Response(null, { status: 204 }), 'identity_invalid_response'],
]) {
  test(`${label} does not downgrade to a native agent or leak exception text`, async () => {
    const ctx = makeBridge({ stockCallResult: stockAgentResult, fetchImpl });
    ctx.bridge.initialized = true;
    invoke(ctx);
    await settle();
    assert.equal(value(result(ctx)).code, code);
    assert.equal(ctx.child().received.length, 0);
    assert.doesNotMatch(ctx.output.join('') + ctx.errors.join(''), /secret-test-value|private-upstream-token/);
  });
}

test('identity reads have a real deadline and release concurrency on timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = makeBridge({ fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted-secret-test-value')), { once: true });
  }) });
  ctx.bridge.initialized = true;
  invoke(ctx);
  assert.equal(ctx.bridge.ownActive, 1);
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(value(result(ctx)).code, 'identity_unavailable');
  assert.equal(ctx.bridge.ownActive, 0);
  assert.equal(ctx.bridge.identityPending.size, 0);
  assert.doesNotMatch(ctx.output.join(''), /secret-test-value/);
});

for (const args of [{ agentId: 'forged' }, { companyId: 'forged' }, { apiKey: 'forged' }, null, []]) {
  test(`paperclipMe rejects caller overrides before making a request: ${JSON.stringify(args)}`, async () => {
    let calls = 0;
    const ctx = makeBridge({ fetchImpl: async () => { calls++; return json(profile); } });
    ctx.bridge.initialized = true;
    invoke(ctx, 1, args);
    await settle();
    assert.equal(result(ctx, 1).error.code, -32602);
    assert.equal(calls, 0);
  });
}

test('identity requires initialization and ignores call notifications', async () => {
  let calls = 0;
  const ctx = makeBridge({ fetchImpl: async () => { calls++; return json(profile); } });
  invoke(ctx, 1);
  await settle();
  assert.equal(result(ctx, 1).error.code, -32002);
  ctx.bridge.initialized = true;
  ctx.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'paperclipMe' } }) + '\n');
  await settle();
  assert.equal(calls, 0);
});

test('a stopped native server cannot produce a spurious successful identity', async () => {
  let calls = 0;
  const ctx = makeBridge({ fetchImpl: async () => { calls++; return json(profile); } });
  ctx.bridge.initialized = true;
  ctx.bridge.markUnavailable();
  invoke(ctx);
  await settle();
  assert.equal(result(ctx).error.code, -32603);
  assert.equal(calls, 0);
});

test('duplicate IDs are not forwarded during an in-flight identity request', async () => {
  let complete;
  let calls = 0;
  const ctx = makeBridge({ fetchImpl: () => { calls++; return new Promise((resolve) => { complete = resolve; }); } });
  ctx.bridge.initialized = true;
  invoke(ctx, 7);
  invoke(ctx, 7);
  ctx.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) + '\n');
  await flush();
  assert.equal(calls, 1);
  assert.equal(ctx.child().received.length, 0);
  assert.equal(messages(ctx.output).filter((message) => message.error?.code === -32600).length, 2);
  complete(json(profile));
  await settle();
  assert.equal(ctx.bridge.identityPending.size, 0);
});

test('identity concurrency is bounded, with normal native calls still usable', async () => {
  const complete = [];
  const ctx = makeBridge({ fetchImpl: () => new Promise((resolve) => complete.push(resolve)) });
  ctx.bridge.initialized = true;
  for (let i = 1; i <= 9; i++) invoke(ctx, i);
  assert.equal(complete.length, 8);
  assert.equal(result(ctx, 9).result.isError, true);
  ctx.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'native-ping', method: 'ping' }) + '\n');
  await flush();
  assert.deepEqual(result(ctx, 'native-ping').result, { pong: true });
  for (const resolve of complete) resolve(json(profile));
  await settle();
  assert.equal(ctx.bridge.ownActive, 0);
});

test('tools/list updates only the existing identity description on every page', async () => {
  const stockTools = [
    { name: 'paperclipMe', description: 'Old description', inputSchema: { type: 'object', properties: {} } },
    { name: 'paperclipInboxLite', description: 'Agent only' },
  ];
  const ctx = makeBridge({ stockTools });
  ctx.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  ctx.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  ctx.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { cursor: 'next' } }) + '\n');
  await settle();
  for (const id of [2, 3]) {
    const tools = result(ctx, id).result.tools;
    assert.match(tools[0].description, /human profile.*native agent/);
    assert.deepEqual(tools[0].inputSchema, stockTools[0].inputSchema);
    assert.deepEqual(tools[1], stockTools[1]);
    assert.equal(tools.filter((tool) => tool.name === 'paperclipMe').length, 1);
  }
  assert.equal(result(ctx, 2).result.tools.length, 7);
  assert.equal(result(ctx, 3).result.tools.length, 2);
});


test('legacy native errors without isError remain byte-for-byte unchanged for agents', async () => {
  const nativeError = { content: [{ type: 'text', text: JSON.stringify({ status: 403, error: 'Low-trust self denied', path: '/agents/me' }) }] };
  const ctx = makeBridge({ stockCallResult: nativeError, fetchImpl: async () => json({ error: 'Board authentication required' }, 401) });
  ctx.bridge.initialized = true;
  invoke(ctx);
  await settle();
  assert.deepEqual(result(ctx).result, nativeError);
  assert.equal(value(result(ctx)).status, 403);
});
