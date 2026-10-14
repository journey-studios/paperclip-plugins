import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GatewayClient } from '../src/gateway-client.mjs';
import { GATEWAY, agentKey, completedEnvelope, connectionsEnv, createClock, createGateway, descriptor, json } from './gateway-helpers.mjs';

const setup = (overrides = {}) => {
  const clock = createClock();
  const gateway = createGateway({ clock, ...overrides });
  const client = new GatewayClient({ env: connectionsEnv, fetchImpl: gateway.fetch, now: clock.now });
  return { clock, gateway, client };
};

test('the session is created on first use, reused afterwards, and only the key opens it', async () => {
  const { gateway, client } = setup();
  assert.equal(gateway.requests.length, 0, 'nothing is requested until a tool is needed');
  const listed = await client.listTools();
  assert.equal(listed.kind, 'ok');
  assert.equal((await client.callTool('mcp.posthog-1a2b3c4d:query-run', { query: 'x' })).kind, 'ok');
  await client.listTools();

  const [create] = gateway.ofKind('create');
  assert.equal(gateway.ofKind('create').length, 1);
  assert.equal(create.method, 'POST');
  assert.deepEqual(create.body, { ttlMs: 3_600_000 });
  assert.equal(create.headers.authorization, `Bearer ${agentKey}`);
  assert.equal(create.redirect, 'error', 'a credential must never follow a redirect');

  for (const request of [...gateway.ofKind('list'), ...gateway.ofKind('call')]) {
    assert.equal(gateway.tokenOf(request), 'gw-token-1', 'the raw token, without Bearer');
    assert.equal(request.headers.authorization, undefined, 'the agent key is never sent with tool traffic');
    assert.equal(Object.keys(request.headers).some((name) => name.toLowerCase() === 'x-paperclip-run-id'), false);
    assert.equal(request.redirect, 'error');
  }
  const [call] = gateway.ofKind('call');
  assert.deepEqual(call.body, { tool: 'mcp.posthog-1a2b3c4d:query-run', parameters: { query: 'x' }, timeoutMs: 55_000 });
});

test('concurrent first requests share a single session creation', async () => {
  const { gateway, client } = setup();
  const results = await Promise.all([client.listTools(), client.listTools(), client.callTool('t', {})]);
  assert.deepEqual(results.map((result) => result.kind), ['ok', 'ok', 'ok']);
  assert.equal(gateway.ofKind('create').length, 1);
});

test('the session is renewed once fewer than 60 seconds remain', async () => {
  const { clock, gateway, client } = setup();
  await client.listTools();
  clock.advance(3_600_000 - 61_000);
  await client.listTools();
  assert.equal(gateway.ofKind('create').length, 1, '61 s left is still fresh');
  clock.advance(2_000);
  await client.listTools();
  assert.equal(gateway.ofKind('create').length, 2, '59 s left triggers a renewal');
  assert.deepEqual(gateway.ofKind('list').map(gateway.tokenOf), ['gw-token-1', 'gw-token-1', 'gw-token-2']);
});

test('a session that reports no usable expiry is assumed to last the requested hour', async () => {
  const { clock, gateway, client } = setup();
  gateway.handlers.create = () => {
    gateway.state.created++;
    return json(201, { sessionId: 'session-x', token: 'gw-token-x', expiresAt: 'not a date' });
  };
  await client.listTools();
  await client.listTools();
  assert.equal(gateway.ofKind('create').length, 1);
  clock.advance(3_600_000 - 30_000);
  await client.listTools();
  assert.equal(gateway.ofKind('create').length, 2);
});

for (const code of ['session_expired', 'session_revoked', 'session_invalid']) {
  test(`a ${code} answer gets one new session and one repeat`, async () => {
    const { gateway, client } = setup();
    let refused = 0;
    gateway.handlers.call = (request) => {
      if (gateway.tokenOf(request) === 'gw-token-1') {
        refused++;
        return json(401, { error: 'Session is no longer valid', reasonCode: code });
      }
      return gateway.defaults.call(request);
    };
    const outcome = await client.callTool('tool-a', { n: 1 });
    assert.equal(outcome.kind, 'ok');
    assert.equal(refused, 1);
    assert.equal(gateway.ofKind('create').length, 2);
    assert.deepEqual(gateway.ofKind('call').map(gateway.tokenOf), ['gw-token-1', 'gw-token-2']);
    assert.deepEqual(gateway.ofKind('call')[1].body, gateway.ofKind('call')[0].body);
  });
}

test('a second session-expired answer is a failure, not a loop', async () => {
  const { gateway, client } = setup();
  gateway.handlers.list = () => json(401, { error: 'expired', reasonCode: 'session_expired' });
  const outcome = await client.listTools();
  assert.deepEqual(outcome, { kind: 'failed', httpStatus: 401, reasonCode: 'session_expired' });
  assert.equal(gateway.ofKind('list').length, 2);
  assert.equal(gateway.ofKind('create').length, 2);
  assert.equal(client.unavailable, false);
});

test('a refresh by a concurrent request is not thrown away by a late 401 for the old token', async () => {
  const { gateway, client } = setup();
  await client.listTools();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let first = true;
  gateway.handlers.call = async (request) => {
    if (first) {
      first = false;
      await held;
      return json(401, { error: 'expired', reasonCode: 'session_expired' });
    }
    return gateway.defaults.call(request);
  };
  const slow = client.callTool('a', {});
  await new Promise((resolve) => setImmediate(resolve));
  // Another request already replaced the session while the first one was in flight.
  gateway.handlers.list = (request) => (gateway.tokenOf(request) === 'gw-token-1'
    ? json(401, { error: 'expired', reasonCode: 'session_expired' }) : gateway.defaults.list(request));
  await client.listTools();
  assert.equal(gateway.ofKind('create').length, 2);
  release();
  assert.equal((await slow).kind, 'ok');
  assert.equal(gateway.ofKind('create').length, 2, 'the late 401 reused the newer session instead of dropping it');
});

const noRunCases = [
  ['403 run_inactive', 403, { error: 'Run is not active', reasonCode: 'run_inactive' }],
  ['403 run_company_mismatch', 403, { error: 'Mismatch', reasonCode: 'run_company_mismatch' }],
  ['403 run_agent_mismatch', 403, { error: 'Mismatch', reasonCode: 'run_agent_mismatch' }],
  ['403 run_context_mismatch', 403, { error: 'Mismatch', reasonCode: 'run_context_mismatch' }],
  ['403 error and code', 403, { error: 'Forbidden', code: 'forbidden' }],
  ['404 agent_not_found', 404, { error: 'Agent not found', reasonCode: 'agent_not_found' }],
  ['400 without reasonCode', 400, { error: 'Agent credential required' }],
  ['401 invalid token', 401, { error: 'Unauthorized' }],
];
for (const [label, status, body] of noRunCases) {
  test(`session creation answering ${label} makes the client permanently unavailable`, async () => {
    const { gateway, client } = setup();
    gateway.handlers.create = () => json(status, body);
    assert.deepEqual(await client.listTools(), { kind: 'unavailable' });
    assert.equal(client.unavailable, true);
    assert.deepEqual(await client.callTool('t', {}), { kind: 'unavailable' });
    assert.deepEqual(await client.listTools(), { kind: 'unavailable' });
    assert.equal(gateway.requests.length, 1, 'no further session attempts');
  });
}

test('session_run_inactive on a tool request ends availability for good', async () => {
  const { gateway, client } = setup();
  await client.listTools();
  gateway.handlers.call = () => json(401, { error: 'The run is over', reasonCode: 'session_run_inactive' });
  assert.deepEqual(await client.callTool('t', {}), { kind: 'unavailable' });
  assert.equal(client.unavailable, true);
  const before = gateway.requests.length;
  assert.deepEqual(await client.listTools(), { kind: 'unavailable' });
  assert.equal(gateway.requests.length, before);
});

test('transient trouble creating a session does not make the client unavailable', async () => {
  const { gateway, client } = setup();
  gateway.handlers.create = () => json(503, { error: 'try later', reasonCode: 'gateway_busy' });
  assert.deepEqual(await client.listTools(), { kind: 'failed', httpStatus: 503, reasonCode: 'gateway_busy' });
  assert.equal(client.unavailable, false);
  gateway.handlers.create = gateway.defaults.create;
  assert.equal((await client.listTools()).kind, 'ok');

  const malformed = setup();
  malformed.gateway.handlers.create = () => json(201, { sessionId: 's', expiresAt: '2030-01-01T00:00:00Z' });
  assert.equal((await malformed.client.listTools()).kind, 'failed', 'a session without a token is unusable');
  assert.equal(malformed.client.unavailable, false);
});

test('gateway answers become refusals that keep only the error text, instructions and codes', async () => {
  const { gateway, client } = setup();
  gateway.handlers.call = () => json(409, {
    error: 'approval_required',
    reasonCode: 'approval_required',
    instructions: 'Do not repeat this call.',
    approvalId: 'secret-approval-internal',
    findings: ['internal'],
  });
  const outcome = await client.callTool('t', {});
  assert.deepEqual(outcome, {
    kind: 'refused', httpStatus: 409, codes: ['approval_required'], error: 'approval_required', instructions: 'Do not repeat this call.',
  });

  gateway.handlers.call = () => json(403, { error: 'This tool is denied by the default policy.', reasonCode: 'deny_default' });
  assert.deepEqual(await client.callTool('t', {}), {
    kind: 'refused', httpStatus: 403, codes: ['deny_default'], error: 'This tool is denied by the default policy.', instructions: undefined,
  });

  gateway.handlers.call = () => new Response('<html>proxy says no</html>', { status: 404 });
  assert.deepEqual(await client.callTool('t', {}), {
    kind: 'refused', httpStatus: 404, codes: [], error: undefined, instructions: undefined,
  });
});

test('upstream failures keep at most a short code, never the body or execution details', async () => {
  const { gateway, client } = setup();
  gateway.handlers.call = () => json(502, {
    error: 'The remote MCP server failed with a very long explanation that is not a code',
    reasonCode: 'mcp_remote_error',
    execution: { stderr: 'EXECUTION-DETAIL', url: 'https://upstream.example' },
  });
  const outcome = await client.callTool('t', {});
  assert.deepEqual(outcome, { kind: 'failed', httpStatus: 502, reasonCode: 'mcp_remote_error' });
  assert.doesNotMatch(JSON.stringify(outcome), /EXECUTION-DETAIL|upstream\.example/);

  gateway.handlers.call = () => json(504, { error: 'tool timeout: it took too long', execution: 'EXECUTION-DETAIL' });
  assert.deepEqual(await client.callTool('t', {}), { kind: 'failed', httpStatus: 504, reasonCode: undefined });
});

test('transport errors, bad bodies and oversized bodies are failures', async () => {
  const { gateway, client } = setup();
  await client.listTools();

  gateway.handlers.call = () => { throw new TypeError('fetch failed: ECONNRESET to internal-host'); };
  assert.deepEqual(await client.callTool('t', {}), { kind: 'failed' });

  gateway.handlers.call = () => new Response('not json', { status: 200 });
  assert.deepEqual(await client.callTool('t', {}), { kind: 'failed', httpStatus: 200 });

  gateway.handlers.call = () => json(200, ['not', 'an', 'envelope']);
  assert.equal((await client.callTool('t', {})).kind, 'failed');

  gateway.handlers.call = () => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 });
  assert.deepEqual(await client.callTool('t', {}), { kind: 'failed' });

  gateway.handlers.list = () => json(200, { tools: [] });
  assert.equal((await client.listTools()).kind, 'failed', 'the catalog must be a bare array');
});

test('the catalog drops entries without a usable name', async () => {
  const { gateway, client } = setup();
  gateway.tools = [descriptor('a'), null, 'text', { description: 'no name' }, { name: '' }, { name: 5 }, descriptor('b')];
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((entry) => entry.name), ['a', 'b']);
});

test('PAPERCLIP_API_URL with or without /api reaches the same gateway path', async () => {
  for (const url of ['http://127.0.0.1:3100', 'http://127.0.0.1:3100/', 'http://127.0.0.1:3100/api', 'http://127.0.0.1:3100/api/']) {
    const clock = createClock();
    const gateway = createGateway({ clock });
    const client = new GatewayClient({ env: { ...connectionsEnv, PAPERCLIP_API_URL: url }, fetchImpl: gateway.fetch, now: clock.now });
    await client.listTools();
    assert.deepEqual(gateway.requests.map((request) => request.path), [`${GATEWAY}/sessions`, `${GATEWAY}/tools`], url);
  }
});

test('the client refuses an unsafe API URL and degrades quietly when the run credentials are absent', async () => {
  for (const url of ['http://paperclip.test', 'ftp://paperclip.test', 'https://user:pass@paperclip.test']) {
    assert.throws(() => new GatewayClient({ env: { ...connectionsEnv, PAPERCLIP_API_URL: url } }), /configuration is invalid/, url);
  }
  assert.doesNotThrow(() => new GatewayClient({ env: { ...connectionsEnv, PAPERCLIP_API_URL: 'http://paperclip:3100', PAPERCLIP_ALLOW_INSECURE_HTTP: '1' } }));

  for (const env of [{}, { PAPERCLIP_API_URL: connectionsEnv.PAPERCLIP_API_URL }, { PAPERCLIP_API_KEY: agentKey }]) {
    let calls = 0;
    const client = new GatewayClient({ env, fetchImpl: async () => { calls++; return json(200, []); } });
    assert.equal(client.unavailable, true);
    assert.deepEqual(await client.listTools(), { kind: 'unavailable' });
    assert.deepEqual(await client.callTool('t', {}), { kind: 'unavailable' });
    await client.close();
    assert.equal(calls, 0, 'no network without run credentials');
  }
});

test('close revokes the session with the agent key, once, and ends availability', async () => {
  const { gateway, client } = setup();
  await client.close();
  assert.equal(gateway.requests.length, 0, 'nothing to revoke before a session exists');

  const used = setup();
  await used.client.listTools();
  await used.client.close();
  await used.client.close();
  const [revoke] = used.gateway.ofKind('revoke');
  assert.equal(used.gateway.ofKind('revoke').length, 1);
  assert.equal(revoke.path, `${GATEWAY}/sessions/session-1/revoke`);
  assert.equal(revoke.method, 'POST');
  assert.deepEqual(revoke.body, {});
  assert.equal(revoke.headers.authorization, `Bearer ${agentKey}`);
  assert.deepEqual(await used.client.listTools(), { kind: 'unavailable' });
  assert.equal(used.gateway.ofKind('create').length, 1);
});

test('close tolerates a failing revoke and aborts requests that are still running', async () => {
  const { gateway, client } = setup();
  await client.listTools();
  gateway.handlers.call = (request) => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  gateway.handlers.revoke = () => { throw new Error('connection refused'); };
  const running = client.callTool('slow', {});
  await new Promise((resolve) => setImmediate(resolve));
  await client.close();
  assert.deepEqual(await running, { kind: 'failed' });
});

test('revocation gives up after two seconds', async (t) => {
  const { gateway, client } = setup();
  await client.listTools();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  gateway.handlers.revoke = (request) => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const closing = client.close();
  t.mock.timers.tick(1_999);
  let done = false;
  void closing.then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false, 'still waiting just before the deadline');
  t.mock.timers.tick(1);
  await closing;
  assert.equal(done, true);
});

test('envelopes are returned untouched for the caller to translate', async () => {
  const { gateway, client } = setup();
  const envelope = completedEnvelope('t', { content: 'x', data: { content: [], structuredContent: { a: 1 }, isError: false } });
  gateway.handlers.call = () => json(200, envelope);
  assert.deepEqual(await client.callTool('t', {}), { kind: 'ok', envelope });
});
