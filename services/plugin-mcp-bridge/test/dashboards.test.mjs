import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DASHBOARD_TOOLS, OBSERVATORY_TOOLS } from '../src/bridge.mjs';
import { MAX_REQUEST_BODY_BYTES } from '../src/dashboards.mjs';
import { companyId, env, flush, makeBridge, messages } from './helpers.mjs';

const API = '/api/plugins/journeystudios.project-dashboards/api';
const otherCompany = '00000000-0000-4000-8000-000000000000';
const projectId = '3c9c5b0e-3b1e-4a0e-9d52-8f2a6b0a1c11';
const slug = 'delivery-status';
const spec = { version: 1, title: 'Delivery', datasets: {}, sections: [] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const DASHBOARD_NAMES = DASHBOARD_TOOLS.map((entry) => entry.name);

function setup({ respond = () => json({ companyId }), ...options } = {}) {
  const requests = [];
  const ctx = makeBridge({
    ...options,
    fetchImpl: async (url, init) => {
      const request = { url: new URL(url), options: init, body: init.body === undefined ? undefined : JSON.parse(init.body) };
      requests.push(request);
      return respond(request);
    },
  });
  ctx.bridge.initialized = true;
  return { ...ctx, requests };
}

const send = (ctx, id, name, args) => ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);

async function callTool(ctx, name, args, id = 1) {
  send(ctx, id, name, args);
  for (let attempt = 0; attempt < 50; attempt++) {
    await flush();
    const reply = messages(ctx.output).find((entry) => entry.id === id);
    if (reply) return reply;
  }
  throw new Error('no reply from bridge');
}

const textOf = (reply) => reply.result.content.map((item) => item.text).join('\n');
const payloadOf = (reply) => JSON.parse(reply.result.content.at(-1).text);
const noSecrets = (ctx) => assert.doesNotMatch(ctx.output.join('') + ctx.errors.join(''), /secret-test-value/);

test('tools/list advertises the six dashboard tools with strict schemas and annotations', async () => {
  const ctx = makeBridge();
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  await flush();
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  await flush();
  const listed = messages(ctx.output).find((entry) => entry.id === 2).result.tools;
  assert.deepEqual(listed.slice(-6).map((entry) => entry.name), [
    'paperclipListDashboards', 'paperclipGetDashboard', 'paperclipDashboardStatus',
    'paperclipUpsertDashboard', 'paperclipUpdateDashboardDataset', 'paperclipValidateDashboardSpec',
  ]);
  assert.deepEqual(listed.slice(1, 1 + OBSERVATORY_TOOLS.length).map((entry) => entry.name), OBSERVATORY_TOOLS.map((entry) => entry.name));
  const byName = new Map(listed.map((entry) => [entry.name, entry]));
  for (const entry of DASHBOARD_TOOLS) {
    assert.equal(entry.inputSchema.additionalProperties, false);
    assert.ok(!Object.hasOwn(entry.inputSchema.properties, 'companyId'), `${entry.name} must not accept a company`);
    assert.ok(entry.description.length > 40);
    assert.deepEqual(byName.get(entry.name), entry);
  }
  for (const name of ['paperclipListDashboards', 'paperclipGetDashboard', 'paperclipDashboardStatus', 'paperclipValidateDashboardSpec']) {
    assert.equal(byName.get(name).annotations.readOnlyHint, true);
  }
  for (const name of ['paperclipUpsertDashboard', 'paperclipUpdateDashboardDataset']) {
    assert.deepEqual(
      [byName.get(name).annotations.readOnlyHint, byName.get(name).annotations.destructiveHint, byName.get(name).annotations.idempotentHint],
      [false, false, true],
    );
  }
  assert.deepEqual(byName.get('paperclipGetDashboard').inputSchema.required, ['slug']);
  assert.deepEqual(byName.get('paperclipUpsertDashboard').inputSchema.required, ['slug', 'spec']);
  assert.deepEqual(byName.get('paperclipUpdateDashboardDataset').inputSchema.required, ['slug', 'datasetId', 'rows']);
  assert.equal(byName.get('paperclipListDashboards').inputSchema.required, undefined);
  // Mentioned so the model can find the dry-run and refresh tools from the writer's description.
  assert.match(byName.get('paperclipUpsertDashboard').description, /paperclipValidateDashboardSpec/);
  assert.match(byName.get('paperclipUpsertDashboard').description, /paperclipUpdateDashboardDataset/);
  assert.match(byName.get('paperclipUpsertDashboard').description, /markdown, mermaid, callout, kpis, chart, table or statusList/);
});

const REQUEST_CASES = [
  { name: 'paperclipListDashboards', args: {}, method: 'GET', path: '/dashboards', query: {}, reply: { dashboards: [] } },
  { name: 'paperclipListDashboards', args: { projectId }, method: 'GET', path: '/dashboards', query: { projectId }, reply: { dashboards: [] } },
  { name: 'paperclipGetDashboard', args: { slug }, method: 'GET', path: `/dashboards/${slug}`, query: {}, reply: { dashboard: { slug, spec } } },
  { name: 'paperclipDashboardStatus', args: { slug }, method: 'GET', path: `/dashboards/${slug}/status`, query: {}, reply: { status: { slug, health: 'fresh' } } },
  {
    name: 'paperclipUpsertDashboard', args: { slug, title: 'Delivery', projectId, spec }, method: 'POST', path: '/dashboards', query: {},
    body: { slug, title: 'Delivery', projectId, spec }, reply: { created: true, dashboard: { slug } },
  },
  {
    name: 'paperclipUpsertDashboard', args: { slug, projectId, spec }, method: 'POST', path: '/dashboards', query: {},
    body: { slug, projectId, spec }, reply: { created: false, dashboard: { slug } },
  },
  {
    name: 'paperclipUpsertDashboard', args: { slug, spec }, method: 'POST', path: '/dashboards', query: {},
    body: { slug, spec }, reply: { created: true, dashboard: { slug } },
  },
  {
    name: 'paperclipUpdateDashboardDataset',
    args: { slug, datasetId: 'phases_1-a', rows: [{ a: 1 }], columns: ['a'], description: 'd', source: 's', updatedAt: '2026-10-13T12:00:00Z' },
    method: 'POST', path: `/dashboards/${slug}/datasets/phases_1-a`, query: {},
    body: { rows: [{ a: 1 }], columns: ['a'], description: 'd', source: 's', updatedAt: '2026-10-13T12:00:00Z' },
    reply: { dashboard: { slug }, dataset: { id: 'phases_1-a', rows: 1 } },
  },
  {
    name: 'paperclipUpdateDashboardDataset', args: { slug, datasetId: 'Phases', rows: [] }, method: 'POST',
    path: `/dashboards/${slug}/datasets/Phases`, query: {}, body: { rows: [] }, reply: { dashboard: { slug }, dataset: { id: 'Phases', rows: 0 } },
  },
  {
    name: 'paperclipValidateDashboardSpec', args: { spec }, method: 'POST', path: '/validate', query: {},
    body: { spec }, reply: { valid: true, datasets: 0, sections: 0 },
  },
];

for (const [index, scenario] of REQUEST_CASES.entries()) {
  test(`${scenario.name} #${index} sends ${scenario.method} ${scenario.path} pinned to the configured company`, async () => {
    const ctx = setup({ respond: () => json({ companyId, ...scenario.reply }) });
    const reply = await callTool(ctx, scenario.name, scenario.args);
    assert.equal(reply.result.isError, undefined);
    assert.equal(ctx.requests.length, 1);
    const [{ url, options, body }] = ctx.requests;
    assert.equal(url.origin, 'https://paperclip.test');
    assert.equal(url.pathname, `${API}${scenario.path}`);
    assert.deepEqual(Object.fromEntries(url.searchParams), { companyId, ...scenario.query });
    assert.equal(options.method, scenario.method);
    assert.equal(options.headers.authorization, `Bearer ${env.PAPERCLIP_API_KEY}`);
    assert.equal(options.headers.accept, 'application/json');
    assert.equal(options.headers['content-type'], scenario.method === 'POST' ? 'application/json' : undefined);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(body, scenario.body);
    if (scenario.method === 'GET') assert.equal(options.body, undefined);
    // The company echo is verified by the bridge and not repeated to the model.
    assert.deepEqual(payloadOf(reply), scenario.reply);
    noSecrets(ctx);
  });
}

test('the HTTP helper always uses the configured company, even if a caller passes another one as a param', async () => {
  const ctx = setup({ respond: () => json({ companyId }) });
  await ctx.bridge.apiRequest(`${API}/dashboards`, { params: { companyId: otherCompany, projectId } });
  await ctx.bridge.apiRequest(`${API}/validate`, { method: 'POST', body: '{}', params: { companyId: otherCompany } });
  assert.equal(ctx.requests.length, 2);
  for (const { url } of ctx.requests) {
    assert.deepEqual(url.searchParams.getAll('companyId'), [companyId]);
    assert.doesNotMatch(url.toString(), new RegExp(otherCompany));
  }
});

test('a company in the input is rejected for every dashboard tool and never reaches the network', async () => {
  const valid = {
    paperclipListDashboards: {},
    paperclipGetDashboard: { slug },
    paperclipDashboardStatus: { slug },
    paperclipUpsertDashboard: { slug, spec },
    paperclipUpdateDashboardDataset: { slug, datasetId: 'phases', rows: [] },
    paperclipValidateDashboardSpec: { spec },
  };
  assert.deepEqual(Object.keys(valid), DASHBOARD_NAMES);
  const ctx = setup();
  let id = 0;
  for (const name of DASHBOARD_NAMES) {
    const reply = await callTool(ctx, name, { ...valid[name], companyId: otherCompany }, ++id);
    assert.equal(reply.result.isError, true, name);
    assert.match(textOf(reply), /^Invalid input: unexpected field/);
  }
  assert.equal(ctx.requests.length, 0);
});

const VALIDATION_CASES = [
  ['paperclipListDashboards', { projectId: 'not-a-uuid' }, /projectId must be a UUID/],
  ['paperclipListDashboards', { projectId: null }, /projectId must be a UUID/],
  ['paperclipListDashboards', { projectId: 5 }, /projectId/],
  ['paperclipListDashboards', { slug }, /unexpected field/],
  ['paperclipGetDashboard', {}, /slug is required/],
  ['paperclipGetDashboard', { slug: 'UPPER' }, /slug must match/],
  ['paperclipGetDashboard', { slug: '' }, /slug must match/],
  ['paperclipGetDashboard', { slug: 'a'.repeat(65) }, /slug must match/],
  ['paperclipGetDashboard', { slug: 'a/b' }, /slug must match/],
  ['paperclipGetDashboard', { slug: '../status' }, /slug must match/],
  ['paperclipGetDashboard', { slug: 'a b' }, /slug must match/],
  ['paperclipGetDashboard', { slug: 'snake_case' }, /slug must match/],
  ['paperclipGetDashboard', { slug: 5 }, /slug must match/],
  ['paperclipGetDashboard', { slug, extra: true }, /unexpected field/],
  ['paperclipDashboardStatus', { slug: 'a%2Fb' }, /slug must match/],
  ['paperclipUpsertDashboard', { slug }, /spec is required/],
  ['paperclipUpsertDashboard', { spec }, /slug is required/],
  ['paperclipUpsertDashboard', { slug, spec: [] }, /spec must be a JSON object/],
  ['paperclipUpsertDashboard', { slug, spec: 'text' }, /spec must be a JSON object/],
  ['paperclipUpsertDashboard', { slug, spec: null }, /spec must be a JSON object/],
  ['paperclipUpsertDashboard', { slug, spec, title: '' }, /title must be/],
  ['paperclipUpsertDashboard', { slug, spec, title: 't'.repeat(201) }, /title must be/],
  ['paperclipUpsertDashboard', { slug, spec, title: 5 }, /title must be/],
  ['paperclipUpsertDashboard', { slug, spec, projectId: 'nope' }, /projectId must be a project UUID/],
  ['paperclipUpsertDashboard', { slug, spec, projectId: 5 }, /projectId must be a project UUID/],
  ['paperclipUpsertDashboard', { slug, spec, projectId: '' }, /projectId must be a project UUID/],
  ['paperclipUpsertDashboard', { slug, spec, projectId: null }, /projectId must be a project UUID \(null is not accepted: every dashboard belongs to a project\)/],
  ['paperclipUpsertDashboard', { slug, spec, delete: true }, /unexpected field/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd' }, /rows is required/],
  ['paperclipUpdateDashboardDataset', { slug, rows: [] }, /datasetId is required/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: {} }, /rows must be an array/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: [null] }, /rows must be an array/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: [[]] }, /rows must be an array/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: [1] }, /rows must be an array/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: Array.from({ length: 10_001 }, () => ({})) }, /at most 10000/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'bad id', rows: [] }, /datasetId must match/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'a/b', rows: [] }, /datasetId must match/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'a'.repeat(65), rows: [] }, /datasetId must match/],
  ['paperclipUpdateDashboardDataset', { slug: 'Bad', datasetId: 'd', rows: [] }, /slug must match/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: [], columns: 'a' }, /columns must be an array/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: [], columns: [5] }, /columns must be an array/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: [], columns: [''] }, /columns must be an array/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: [], columns: Array.from({ length: 201 }, (_, i) => `c${i}`) }, /at most 200/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: [], columns: ['c'.repeat(201)] }, /columns must be an array/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: [], description: 5 }, /description must be/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: [], description: 'x'.repeat(10_001) }, /description must be/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: [], source: 's'.repeat(501) }, /source must be/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: [], updatedAt: 'yesterday' }, /updatedAt must be an ISO/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: [], updatedAt: '2026-13-45T00:00:00Z' }, /updatedAt must be an ISO/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: [], updatedAt: 1760000000 }, /updatedAt must be an ISO/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: [], updatedAt: `2026-10-13T00:00:00Z${' '.repeat(64)}` }, /updatedAt must be an ISO/],
  ['paperclipUpdateDashboardDataset', { slug, datasetId: 'd', rows: [], projectId }, /unexpected field/],
  ['paperclipValidateDashboardSpec', {}, /spec is required/],
  ['paperclipValidateDashboardSpec', { spec: [] }, /spec must be a JSON object/],
  ['paperclipValidateDashboardSpec', { spec, slug }, /unexpected field/],
  ['paperclipGetDashboard', [], /arguments must be an object/],
  ['paperclipGetDashboard', 'slug', /arguments must be an object/],
];

for (const [index, [name, args, pattern]] of VALIDATION_CASES.entries()) {
  test(`validation #${index} rejects bad ${name} input before any HTTP call`, async () => {
    const ctx = setup();
    const reply = await callTool(ctx, name, args);
    assert.equal(reply.result.isError, true);
    assert.match(textOf(reply), /^Invalid input: /);
    assert.match(textOf(reply), pattern);
    assert.equal(ctx.requests.length, 0);
    noSecrets(ctx);
  });
}

test('accepted boundary inputs: 10000 rows, 200 columns, date-only and offset timestamps, 64-char identifiers', async () => {
  const ctx = setup({ respond: () => json({ companyId, dashboard: {}, dataset: {} }) });
  for (const updatedAt of ['2026-10-13', '2026-10-13T12:00:00.123456789Z', '2026-10-13T12:00:00-03:00']) {
    const reply = await callTool(ctx, 'paperclipUpdateDashboardDataset', {
      slug: 'a'.repeat(64), datasetId: 'D'.repeat(64), updatedAt,
      rows: Array.from({ length: 10_000 }, () => ({})),
      columns: Array.from({ length: 200 }, (_, i) => `c${i}`),
    }, updatedAt.length);
    assert.equal(reply.result.isError, undefined, updatedAt);
  }
  assert.equal(ctx.requests.length, 3);
});

test('request body is capped by serialized bytes, not characters', async () => {
  const ctx = setup({ respond: () => json({ companyId, valid: true, datasets: 0, sections: 0 }) });
  const overhead = Buffer.byteLength(JSON.stringify({ spec: { x: '' } }));
  const exact = await callTool(ctx, 'paperclipValidateDashboardSpec', { spec: { x: 'a'.repeat(MAX_REQUEST_BODY_BYTES - overhead) } }, 1);
  assert.equal(exact.result.isError, undefined);
  assert.equal(Buffer.byteLength(ctx.requests[0].options.body), MAX_REQUEST_BODY_BYTES);

  const over = await callTool(ctx, 'paperclipValidateDashboardSpec', { spec: { x: 'a'.repeat(MAX_REQUEST_BODY_BYTES - overhead + 1) } }, 2);
  assert.equal(over.result.isError, true);
  assert.match(textOf(over), /Invalid input: request body is larger than 950000 bytes/);

  // 475,001 two-byte characters are well under 950,000 characters but over the byte limit.
  const wide = await callTool(ctx, 'paperclipValidateDashboardSpec', { spec: { x: 'é'.repeat(475_001) } }, 3);
  assert.equal(wide.result.isError, true);
  assert.match(textOf(wide), /larger than 950000 bytes/);

  const rows = await callTool(ctx, 'paperclipUpdateDashboardDataset', {
    // Stays below the bridge's 1 MiB per-line MCP input limit while exceeding the 950,000-byte request cap.
    slug, datasetId: 'phases', rows: Array.from({ length: 5_000 }, () => ({ note: 'n'.repeat(190) })),
  }, 4);
  assert.equal(rows.result.isError, true);
  assert.match(textOf(rows), /larger than 950000 bytes/);
  assert.equal(ctx.requests.length, 1, 'oversized bodies never reach the network');
});

test('422 invalid_spec passes at most 50 detail lines of at most 300 characters through to the model', async () => {
  const details = [
    'sections[0].blocks[1].dataset: unknown dataset "x" (declared: phases)',
    ...Array.from({ length: 53 }, (_, index) => `datasets.p.rows[${index}].${'z'.repeat(400)}`),
    42,
    { not: 'a string' },
  ];
  const ctx = setup({ respond: () => json({ companyId, error: 'invalid_spec', details, extra: 'ignored' }, 422) });
  const reply = await callTool(ctx, 'paperclipValidateDashboardSpec', { spec });
  assert.equal(reply.result.isError, true);
  const lines = textOf(reply).split('\n');
  assert.equal(lines[0], 'Project Dashboards rejected the request (HTTP 422): invalid_spec');
  assert.equal(lines[1], '- sections[0].blocks[1].dataset: unknown dataset "x" (declared: phases)');
  const detailLines = lines.slice(1, 51);
  assert.equal(detailLines.length, 50);
  for (const line of detailLines) {
    assert.match(line, /^- /);
    assert.ok(line.length - 2 <= 300, `detail line has ${line.length - 2} characters`);
  }
  assert.equal(detailLines[1].endsWith('…'), true);
  assert.equal(lines[51], '- (4 more not shown)');
  assert.equal(lines.length, 52);
  assert.doesNotMatch(textOf(reply), /ignored|not a string/);
  noSecrets(ctx);
});

test('422 detail text is single-line and tolerates a missing or malformed details list', async () => {
  const ctx = setup({ respond: () => json({ companyId, error: 'invalid_spec', details: ['line one\nline two\r\n\tindented'] }, 422) });
  const reply = await callTool(ctx, 'paperclipUpsertDashboard', { slug, spec });
  assert.equal(textOf(reply), 'Project Dashboards rejected the request (HTTP 422): invalid_spec\n- line one line two indented');
  for (const details of [undefined, 'oops', null, {}]) {
    const bare = setup({ respond: () => json({ companyId, error: 'invalid_spec', details }, 422) });
    const result = await callTool(bare, 'paperclipUpsertDashboard', { slug, spec });
    assert.equal(result.result.isError, true);
    assert.equal(textOf(result), 'Project Dashboards rejected the request (HTTP 422): invalid_spec');
  }
});

test('documented 400, 404 and 413 client errors return the plugin error text as a tool error', async () => {
  const cases = [
    [400, { error: 'projectId does not belong to this company' }, 'Project Dashboards rejected the request (HTTP 400): projectId does not belong to this company'],
    [404, { error: 'not_found' }, 'Project Dashboards rejected the request (HTTP 404): not_found'],
    [413, { error: 'spec_too_large', limitBytes: 262_144 }, 'Project Dashboards rejected the request (HTTP 413): spec_too_large (limit 262144 bytes)'],
    [413, { error: 'spec_too_large', limitBytes: 'x'.repeat(1000) }, 'Project Dashboards rejected the request (HTTP 413): spec_too_large'],
  ];
  for (const [status, body, expected] of cases) {
    const ctx = setup({ respond: () => json({ companyId, ...body, details: ['not for non-422'], stack: 'at secret.js:1' }, status) });
    const reply = await callTool(ctx, 'paperclipUpsertDashboard', { slug, spec });
    assert.equal(reply.result.isError, true);
    assert.equal(textOf(reply), expected);
  }
  const long = setup({ respond: () => json({ companyId, error: 'e'.repeat(1000) }, 400) });
  const reply = await callTool(long, 'paperclipGetDashboard', { slug });
  assert.equal(textOf(reply).split(': ')[1].length, 300);
});

test('a plugin 404 for a missing dashboard is a normal not_found, not "plugin unavailable"', async () => {
  const ctx = setup({ respond: () => json({ companyId, error: 'not_found' }, 404) });
  const reply = await callTool(ctx, 'paperclipDashboardStatus', { slug: 'missing' });
  assert.equal(reply.result.isError, true);
  assert.match(textOf(reply), /HTTP 404\): not_found/);
  assert.doesNotMatch(textOf(reply), /unavailable/);
});

test('every dashboard belongs to a project: upsert takes a project UUID, optional only for updates, never null', async () => {
  const ctx = makeBridge();
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  await flush();
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  await flush();
  const byName = new Map(messages(ctx.output).find((entry) => entry.id === 2).result.tools.map((entry) => [entry.name, entry]));
  const upsert = byName.get('paperclipUpsertDashboard');
  assert.equal(upsert.inputSchema.properties.projectId.type, 'string');
  assert.equal(upsert.inputSchema.properties.projectId.format, 'uuid');
  assert.deepEqual(upsert.inputSchema.required, ['slug', 'spec'], 'projectId stays optional for updates');
  assert.doesNotMatch(JSON.stringify(upsert.inputSchema), /"null"/);
  assert.match(upsert.description, /belongs to a Paperclip project/);
  assert.match(upsert.description, /projectId is required when creating/);
  assert.match(upsert.description, /omit it to leave it where it is \(in its project, or without one\), or pass a project UUID to move it/);
  assert.doesNotMatch(upsert.description, /company-level|null/);
  const list = byName.get('paperclipListDashboards');
  assert.match(list.description, /projectId and projectName/);
  assert.match(list.description, /projectId input limits the list to one project/);
});

test('upsert sends projectId only when given: omitted keeps the dashboard project, a UUID moves it', async () => {
  const ctx = setup({ respond: () => json({ companyId, created: false, dashboard: { slug } }) });
  assert.equal((await callTool(ctx, 'paperclipUpsertDashboard', { slug, spec }, 1)).result.isError, undefined);
  assert.equal((await callTool(ctx, 'paperclipUpsertDashboard', { slug, spec, projectId }, 2)).result.isError, undefined);
  assert.deepEqual(ctx.requests.map((request) => request.body), [{ slug, spec }, { slug, projectId, spec }]);
});

test('a null projectId on upsert is refused by the bridge with a clear message and no HTTP call', async () => {
  const ctx = setup();
  const reply = await callTool(ctx, 'paperclipUpsertDashboard', { slug, spec, projectId: null });
  assert.equal(reply.result.isError, true);
  assert.equal(textOf(reply), 'Invalid input: projectId must be a project UUID (null is not accepted: every dashboard belongs to a project).');
  assert.equal(ctx.requests.length, 0);
});

test('the plugin project errors (project_required, project_not_found, project_archived) reach the model as client errors', async () => {
  for (const code of ['project_required', 'project_not_found', 'project_archived']) {
    const ctx = setup({ respond: () => json({ companyId, error: code }, 400) });
    const reply = await callTool(ctx, 'paperclipUpsertDashboard', { slug, spec });
    assert.equal(reply.result.isError, true, code);
    assert.equal(textOf(reply), `Project Dashboards rejected the request (HTTP 400): ${code}`);
    assert.doesNotMatch(textOf(reply), /unavailable|request failed/);
    assert.equal(ctx.requests.length, 1);
    noSecrets(ctx);
  }
  // Without the company echo the same status is not trusted: it stays a generic failure.
  const foreign = setup({ respond: () => json({ companyId: otherCompany, error: 'project_not_found' }, 400) });
  const rejected = await callTool(foreign, 'paperclipUpsertDashboard', { slug, spec, projectId });
  assert.match(textOf(rejected), /^Project Dashboards request failed/);
  assert.doesNotMatch(foreign.output.join(''), /project_not_found/);
});

test('5xx, auth failures, transport errors and malformed bodies stay generic and echo nothing upstream', async () => {
  const leaks = 'private token response body secret-test-value stack at /srv/plugin.js SELECT *';
  const responses = [
    () => new Response(leaks, { status: 500 }),
    () => json({ companyId, error: leaks, stack: leaks }, 500),
    () => json({ companyId, error: 'internal_error' }, 502),
    () => json({ error: leaks }, 401),
    () => json({ companyId, error: leaks }, 403),
    () => json({ companyId, error: leaks }, 429),
    () => json({ companyId, error: leaks }, 409),
    () => json({ error: leaks }, 400),
    () => json({ error: leaks, details: [leaks] }, 422),
    () => json({ companyId, details: [leaks] }, 422),
    () => json({ companyId, error: { message: leaks } }, 400),
    () => new Response(leaks, { status: 200 }),
    () => new Response('', { status: 200 }),
    () => json([{ companyId }], 200),
    () => json(null, 200),
    () => new Response('x'.repeat(1024 * 1024 + 1)),
    () => { throw new Error(leaks); },
  ];
  for (const respond of responses) {
    const ctx = setup({ respond });
    const reply = await callTool(ctx, 'paperclipUpsertDashboard', { slug, spec });
    assert.equal(reply.result.isError, true);
    assert.equal(textOf(reply), 'Project Dashboards request failed. Check bridge configuration and plugin availability.');
    assert.doesNotMatch(ctx.output.join('') + ctx.errors.join(''), /private token|stack at|SELECT|secret-test-value|internal_error/);
  }
});

test('a response for another company or without company proof fails closed for success and error statuses', async () => {
  const secret = 'foreign tenant data';
  const responses = [
    [200, { companyId: otherCompany, dashboards: [{ title: secret }] }],
    [200, { dashboards: [{ title: secret }] }],
    [200, { companyId: null, dashboards: [{ title: secret }] }],
    [200, { companyId: companyId.toUpperCase(), dashboards: [{ title: secret }] }],
    [422, { companyId: otherCompany, error: secret, details: [secret] }],
    [400, { companyId: otherCompany, error: secret }],
    [404, { companyId: otherCompany, error: 'not_found' }],
    [413, { companyId: otherCompany, error: secret }],
  ];
  for (const [status, body] of responses) {
    const ctx = setup({ respond: () => json(body, status) });
    const reply = await callTool(ctx, 'paperclipListDashboards', {});
    assert.equal(reply.result.isError, true);
    assert.match(textOf(reply), /^Project Dashboards request failed/);
    assert.doesNotMatch(ctx.output.join(''), new RegExp(`${secret}|${otherCompany}`));
  }
});

test('an absent plugin (host 404 without company echo, or 503) is reported as unavailable', async () => {
  const absent = [
    () => new Response('<html>Not Found</html>', { status: 404 }),
    () => json({ error: 'Plugin not found' }, 404),
    () => json({ error: 'API route not found' }, 404),
    () => new Response('', { status: 404 }),
    () => json({ error: 'Plugin is not ready' }, 503),
    () => new Response('upstream connect error', { status: 503 }),
    () => json({ companyId, error: 'unavailable' }, 503),
  ];
  for (const respond of absent) {
    const ctx = setup({ respond });
    for (const [name, args] of [['paperclipListDashboards', {}], ['paperclipUpsertDashboard', { slug, spec }]]) {
      const reply = await callTool(ctx, name, args, name.length);
      assert.equal(reply.result.isError, true);
      assert.match(textOf(reply), /^Project Dashboards plugin unavailable/);
    }
  }
});

test('stock tools and Observatory tools keep working while the Dashboards plugin is unavailable', async () => {
  const stockResult = { content: [{ type: 'text', text: '[{"id":"agent-1"}]' }] };
  const ctx = setup({
    stockCallResult: stockResult,
    respond: ({ url }) => (url.pathname.startsWith(`${API}/`)
      ? json({ error: 'Plugin not found' }, 404)
      : json({ companyId, agents: [] })),
  });
  const dashboards = await callTool(ctx, 'paperclipListDashboards', {}, 1);
  assert.match(textOf(dashboards), /plugin unavailable/);
  const observatory = await callTool(ctx, 'paperclipAgentHealthOverview', { windowHours: 24 }, 2);
  assert.equal(observatory.result.isError, undefined);
  assert.deepEqual(JSON.parse(observatory.result.content[0].text), { companyId, agents: [] });
  assert.equal(ctx.requests.at(-1).url.pathname, '/api/plugins/journey-studios.agent-observatory/api/overview');
  send(ctx, 3, 'paperclipListAgents', { companyId });
  await flush();
  assert.deepEqual(messages(ctx.output).find((entry) => entry.id === 3).result, stockResult);
  assert.equal(ctx.bridge.ownActive, 0);
});

test('paperclipDashboardStatus prepends a one-line summary and keeps the JSON payload', async () => {
  const status = {
    id: 'a', slug, title: 'Delivery "status"\nline two', projectId: null, projectName: null, revision: 7,
    updatedAt: '2026-10-13T12:00:00.000Z', checkedAt: '2026-10-13T13:00:00.000Z', health: 'stale', staleCount: 2,
    datasets: [{ id: 'phases', title: 'Phases', rows: 5, updatedAt: null, ageMinutes: null, staleAfterHours: 24, stale: true }],
    sections: 3, blocks: 9,
  };
  const ctx = setup({ respond: () => json({ companyId, status }) });
  const reply = await callTool(ctx, 'paperclipDashboardStatus', { slug });
  const [summary, data] = reply.result.content;
  assert.equal(reply.result.content.length, 2);
  assert.equal(summary.text, 'Dashboard "Delivery "status" line two": revision 7, health stale, 2 stale dataset(s), updated 2026-10-13T12:00:00.000Z');
  assert.equal(summary.text.includes('\n'), false);
  assert.deepEqual(JSON.parse(data.text), { status });
  assert.equal(data.text.includes('\n'), false, 'payload is compact JSON');

  // Other tools return the payload only, and an unexpected status shape degrades to plain JSON.
  const list = setup({ respond: () => json({ companyId, dashboards: [] }) });
  assert.equal((await callTool(list, 'paperclipListDashboards', {})).result.content.length, 1);
  const odd = setup({ respond: () => json({ companyId, status: 'weird' }) });
  const oddReply = await callTool(odd, 'paperclipDashboardStatus', { slug });
  assert.equal(oddReply.result.content.length, 1);
  assert.deepEqual(payloadOf(oddReply), { status: 'weird' });
});

test('dashboard calls share the bounded own-tool concurrency and release their slot', async () => {
  const gates = [];
  let holding = true;
  const ctx = setup({
    respond: () => (holding
      ? new Promise((resolve) => { gates.push(resolve); })
      : json({ companyId, valid: true, datasets: 0, sections: 0 })),
  });
  for (let id = 1; id <= 4; id++) send(ctx, id, 'paperclipValidateDashboardSpec', { spec });
  for (let id = 5; id <= 8; id++) send(ctx, id, 'paperclipAgentHealthOverview', { windowHours: 24 });
  await flush();
  assert.equal(gates.length, 8);
  assert.equal(ctx.bridge.ownActive, 8);
  const busy = await callTool(ctx, 'paperclipGetDashboard', { slug }, 9);
  assert.equal(busy.result.isError, true);
  assert.equal(textOf(busy), 'Project Dashboards is busy; retry shortly.');
  assert.equal(gates.length, 8, 'the busy call did not start a request');
  gates.forEach((resolve) => resolve(json({ companyId, valid: true, datasets: 0, sections: 0 })));
  for (let attempt = 0; attempt < 20 && ctx.bridge.ownActive > 0; attempt++) await flush();
  assert.equal(ctx.bridge.ownActive, 0);
  holding = false;
  const after = await callTool(ctx, 'paperclipValidateDashboardSpec', { spec }, 10);
  assert.equal(after.result.isError, undefined);
});

test('requests are aborted after 10 s for GET and 25 s for POST', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = [];
  const ctx = makeBridge({
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      pending.push(init.method);
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  ctx.bridge.initialized = true;
  const replyFor = (id) => messages(ctx.output).find((entry) => entry.id === id);

  send(ctx, 1, 'paperclipGetDashboard', { slug });
  send(ctx, 2, 'paperclipValidateDashboardSpec', { spec });
  await flush();
  assert.deepEqual(pending, ['GET', 'POST']);
  t.mock.timers.tick(9_999);
  await flush();
  assert.equal(replyFor(1), undefined);
  t.mock.timers.tick(1);
  await flush(); await flush();
  assert.match(textOf(replyFor(1)), /^Project Dashboards request failed/);
  assert.equal(replyFor(2), undefined, 'POST is still within its 25 s budget');
  t.mock.timers.tick(14_999);
  await flush();
  assert.equal(replyFor(2), undefined);
  t.mock.timers.tick(1);
  await flush(); await flush();
  assert.match(textOf(replyFor(2)), /^Project Dashboards request failed/);
  assert.equal(ctx.bridge.ownActive, 0);
});

test('dashboard tools require an initialized MCP session and ignore notifications', async () => {
  const ctx = setup();
  ctx.bridge.initialized = false;
  const reply = await callTool(ctx, 'paperclipListDashboards', {});
  assert.equal(reply.error.code, -32002);
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'paperclipListDashboards', arguments: {} } })}\n`);
  await flush();
  assert.equal(ctx.requests.length, 0);
  assert.equal(ctx.output.length > 0, true);
  assert.equal(messages(ctx.output).length, 1);
});
