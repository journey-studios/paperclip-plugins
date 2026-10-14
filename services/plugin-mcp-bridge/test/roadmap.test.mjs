import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DASHBOARD_TOOLS, OBSERVATORY_TOOLS, ROADMAP_TOOLS } from '../src/bridge.mjs';
import { GOAL_LEVELS, GOAL_STATUSES, MAX_ERROR_DETAIL_LINES, PROJECT_STATUSES, ROADMAP_TOOL_NAMES } from '../src/roadmap.mjs';
import { companyId, env, flush, makeBridge, messages } from './helpers.mjs';

const otherCompany = '00000000-0000-4000-8000-000000000000';
const uuidN = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const goalA = uuidN(1);
const goalB = uuidN(2);
const agentA = uuidN(3);
const foreignGoal = uuidN(4);
const goalL = 'abcdef01-0000-4000-8000-000000000001';
const foreignAgent = uuidN(5);
const missingId = uuidN(6);
const NAMES = ['paperclipCreateProject', 'paperclipUpdateProject', 'paperclipCreateGoal', 'paperclipUpdateGoal', 'paperclipMoveDashboard'];

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const PROJECT_FIELDS = ['name', 'description', 'status', 'goalIds', 'targetDate', 'color', 'leadAgentId', 'archivedAt'];
const GOAL_FIELDS = ['title', 'description', 'level', 'status', 'parentId', 'ownerAgentId'];

/**
 * An in-memory stand-in for the core projects, goals and agents routes. It keeps the host's quirks
 * that matter here: unknown body fields are ignored, `ignore` lists fields it silently drops, a
 * colliding project name gets a numeric suffix, a repeated idempotency key returns the first project
 * with 200, and records carry fields the bridge must never pass on.
 */
function mockHost({ ignore = [], respond } = {}) {
  const store = { projects: new Map(), goals: new Map(), agents: new Map() };
  const requests = [];
  const keys = new Map();
  let counter = 100;
  const nextId = () => uuidN(++counter);
  const host = {
    store,
    requests,
    writes: () => requests.filter((request) => request.method !== 'GET'),
    addProject(fields = {}) {
      const name = fields.name ?? 'Existing project';
      const record = {
        id: nextId(), companyId, name, description: null, status: 'backlog', leadAgentId: null, targetDate: null, color: null,
        icon: null, archivedAt: null, pausedAt: null, urlKey: slugOf(name), goalIds: [], goals: [],
        env: { API_TOKEN: { type: 'plain', value: 'host-secret-value' } },
        executionWorkspacePolicy: { enabled: true },
        workspaces: [{ id: 'w1', cwd: '/srv/private-workspace' }],
        codebase: { repoUrl: 'https://example.test/private.git' },
        ...fields,
      };
      store.projects.set(record.id, record);
      return record;
    },
    addGoal(fields = {}) {
      const record = {
        id: nextId(), companyId, title: 'Existing goal', description: null, level: 'task', status: 'planned', parentId: null,
        ownerAgentId: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...fields,
      };
      store.goals.set(record.id, record);
      return record;
    },
    addAgent(fields = {}) {
      const record = { id: nextId(), companyId, name: 'Agent', adapterConfig: { apiKey: '[redacted]' }, ...fields };
      store.agents.set(record.id, record);
      return record;
    },
    async fetch(url, init) {
      const request = {
        url: new URL(url), method: init.method, options: init, body: init.body === undefined ? undefined : JSON.parse(init.body),
      };
      requests.push(request);
      return respond?.(request, host) ?? handle(request);
    },
  };

  const apply = (record, body, fields, isProject) => {
    for (const field of fields) {
      if (!Object.hasOwn(body, field) || ignore.includes(field)) {
        continue;
      }
      let value = body[field];
      if (field === 'name') {
        const taken = [...store.projects.values()].some((other) => other.id !== record.id && other.companyId === record.companyId && other.name === value);
        value = taken ? `${value} 2` : value;
      }
      record[field] = value;
    }
    if (isProject) {
      record.urlKey = slugOf(record.name);
      record.goals = record.goalIds.map((id) => ({ id, title: 'goal' }));
    }
    return record;
  };

  function handle(request) {
    const { pathname } = request.url;
    let match = pathname.match(/^\/api\/(projects|goals|agents)\/([^/]+)$/);
    if (match && request.method === 'GET') {
      const record = store[match[1]].get(match[2]);
      return record ? json(record) : json({ error: 'Not found' }, 404);
    }
    match = pathname.match(/^\/api\/companies\/([^/]+)\/(projects|goals)$/);
    if (match && request.method === 'POST') {
      const [, owner, collection] = match;
      const key = request.body.idempotencyKey;
      if (collection === 'projects' && key !== undefined && keys.has(key)) {
        return json(keys.get(key), 200);
      }
      const record = collection === 'projects'
        ? apply(host.addProject({ companyId: owner, name: 'unnamed' }), request.body, PROJECT_FIELDS, true)
        : apply(host.addGoal({ companyId: owner, title: 'unnamed' }), request.body, GOAL_FIELDS, false);
      if (collection === 'projects' && key !== undefined) {
        keys.set(key, record);
      }
      return json(record, 201);
    }
    match = pathname.match(/^\/api\/(projects|goals)\/([^/]+)$/);
    if (match && request.method === 'PATCH') {
      const record = store[match[1]].get(match[2]);
      if (!record) {
        return json({ error: 'Not found' }, 404);
      }
      apply(record, request.body, match[1] === 'projects' ? PROJECT_FIELDS : GOAL_FIELDS, match[1] === 'projects');
      return json(record);
    }
    return json({ error: 'not mocked' }, 500);
  }
  return host;
}

function setup(options = {}) {
  const host = mockHost(options);
  const ctx = makeBridge({ fetchImpl: (url, init) => host.fetch(url, init) });
  ctx.bridge.initialized = true;
  host.addGoal({ id: goalA, title: 'Goal A' });
  host.addGoal({ id: goalB, title: 'Goal B' });
  host.addGoal({ id: goalL, title: 'Goal L' });
  host.addAgent({ id: agentA });
  host.addGoal({ id: foreignGoal, companyId: otherCompany });
  host.addAgent({ id: foreignAgent, companyId: otherCompany });
  host.requests.length = 0;
  return { ...ctx, host };
}

const send = (ctx, id, name, args) => ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);

let requestSeq = 0;

async function replyTo(ctx, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await flush();
    const reply = messages(ctx.output).find((entry) => entry.id === id);
    if (reply) {
      return reply;
    }
  }
  throw new Error('no reply from bridge');
}

async function callTool(ctx, name, args, id = ++requestSeq + 1000) {
  send(ctx, id, name, args);
  return replyTo(ctx, id);
}

const textOf = (reply) => reply.result.content.map((item) => item.text).join('\n');
const payloadOf = (reply) => JSON.parse(reply.result.content.at(-1).text);
const noSecrets = (ctx) => assert.doesNotMatch(ctx.output.join('') + ctx.errors.join(''), /secret-test-value|host-secret-value|private-workspace|private\.git/);

async function listTools() {
  const ctx = makeBridge();
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  await flush();
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  await flush();
  return messages(ctx.output).find((entry) => entry.id === 2).result.tools;
}

// ---------------------------------------------------------------------------------------------

test('tools/list appends the five roadmap tools after the Observatory and Dashboards tools, with strict schemas', async () => {
  const listed = await listTools();
  assert.deepEqual(listed.slice(-NAMES.length).map((entry) => entry.name), NAMES);
  assert.deepEqual(ROADMAP_TOOL_NAMES, NAMES);
  assert.deepEqual(listed.slice(1 + OBSERVATORY_TOOLS.length, 1 + OBSERVATORY_TOOLS.length + DASHBOARD_TOOLS.length).map((entry) => entry.name), DASHBOARD_TOOLS.map((entry) => entry.name));
  const byName = new Map(listed.map((entry) => [entry.name, entry]));
  for (const entry of ROADMAP_TOOLS) {
    assert.deepEqual(byName.get(entry.name), entry);
    assert.equal(entry.inputSchema.additionalProperties, false, entry.name);
    assert.ok(!Object.hasOwn(entry.inputSchema.properties, 'companyId'), `${entry.name} must not accept a company`);
    assert.ok(entry.description.length > 80, entry.name);
    assert.ok(entry.description.length < 1400, `${entry.name} description is too long for a model to read quickly`);
    assert.equal(entry.annotations.readOnlyHint, false);
    assert.equal(entry.annotations.destructiveHint, false);
    assert.equal(entry.annotations.openWorldHint, false);
  }
  // Creates add a record every call; updates and the move are idempotent.
  assert.equal(byName.get('paperclipCreateProject').annotations.idempotentHint, false);
  assert.equal(byName.get('paperclipCreateGoal').annotations.idempotentHint, false);
  for (const name of ['paperclipUpdateProject', 'paperclipUpdateGoal', 'paperclipMoveDashboard']) {
    assert.equal(byName.get(name).annotations.idempotentHint, true, name);
  }
  assert.deepEqual(byName.get('paperclipCreateProject').inputSchema.required, ['name']);
  assert.deepEqual(byName.get('paperclipUpdateProject').inputSchema.required, ['projectId']);
  assert.deepEqual(byName.get('paperclipCreateGoal').inputSchema.required, ['title']);
  assert.deepEqual(byName.get('paperclipUpdateGoal').inputSchema.required, ['goalId']);
  assert.deepEqual(byName.get('paperclipMoveDashboard').inputSchema.required, ['slug', 'projectId']);
  assert.deepEqual(Object.keys(byName.get('paperclipCreateProject').inputSchema.properties).sort(),
    ['color', 'description', 'goalIds', 'idempotencyKey', 'leadAgentId', 'name', 'status', 'targetDate']);
  assert.deepEqual(Object.keys(byName.get('paperclipUpdateProject').inputSchema.properties).sort(),
    ['archived', 'color', 'description', 'goalIds', 'leadAgentId', 'name', 'projectId', 'status', 'targetDate']);
  // Never expose host-internal project fields.
  for (const name of ['paperclipCreateProject', 'paperclipUpdateProject']) {
    const text = JSON.stringify(byName.get(name).inputSchema);
    assert.doesNotMatch(text, /"(env|executionWorkspacePolicy|workspace|repositoryIds|repositoryUrls|archivedAt|icon)"/, name);
  }
  // No delete or pause tools exist.
  assert.ok(!listed.some((entry) => /delete|remove|pause/i.test(entry.name)));
  assert.deepEqual(byName.get('paperclipCreateProject').inputSchema.properties.status.enum, PROJECT_STATUSES);
  assert.deepEqual(byName.get('paperclipUpdateProject').inputSchema.properties.status.enum, PROJECT_STATUSES);
  assert.deepEqual(byName.get('paperclipCreateGoal').inputSchema.properties.level.enum, GOAL_LEVELS);
  assert.deepEqual(byName.get('paperclipCreateGoal').inputSchema.properties.status.enum, GOAL_STATUSES);
  assert.deepEqual(byName.get('paperclipUpdateGoal').inputSchema.properties.level.enum, GOAL_LEVELS);
  assert.deepEqual(byName.get('paperclipUpdateGoal').inputSchema.properties.status.enum, GOAL_STATUSES);
});

test('descriptions teach when to use each tool and the host quirks that matter', async () => {
  const byName = new Map((await listTools()).map((entry) => [entry.name, entry]));
  const create = byName.get('paperclipCreateProject').description;
  assert.match(create, /group dashboards/);
  assert.match(create, /NOT idempotent/);
  assert.match(create, /idempotencyKey/);
  assert.match(create, /numeric suffix/);
  assert.match(create, /wakes no agent/);
  assert.match(create, /cannot be deleted or paused/);
  const update = byName.get('paperclipUpdateProject').description;
  assert.match(update, /goalIds REPLACES the whole set/);
  assert.match(update, /\[\] unlinks all/);
  assert.match(update, /null to clear/);
  assert.match(update, /archived true archives/);
  assert.match(byName.get('paperclipCreateGoal').description, /strategic level of the roadmap/);
  assert.match(byName.get('paperclipCreateGoal').description, /NOT idempotent/);
  assert.match(byName.get('paperclipUpdateGoal').description, /achieved or cancelled to close/);
  assert.match(byName.get('paperclipMoveDashboard').description, /Projects group dashboards/);
  assert.match(byName.get('paperclipMoveDashboard').description, /paperclipUpsertDashboard/);
});

test('the enums match the vendored host constants whenever they are available', () => {
  const file = new URL('../../../.paperclip/packages/shared/src/constants.ts', import.meta.url);
  if (!existsSync(file)) {
    return; // a bridge-only checkout has no host source to compare with
  }
  const source = readFileSync(file, 'utf8');
  const constant = (name) => {
    const match = source.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`));
    assert.ok(match, `${name} not found in the host constants`);
    return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  };
  assert.deepEqual(PROJECT_STATUSES, constant('PROJECT_STATUSES'));
  assert.deepEqual(GOAL_LEVELS, constant('GOAL_LEVELS'));
  assert.deepEqual(GOAL_STATUSES, constant('GOAL_STATUSES'));
});

// ---------------------------------------------------------------------------------------------
// Input validation

const VALIDATION_CASES = [
  ['paperclipCreateProject', {}, /name is required/],
  ['paperclipCreateProject', { name: '' }, /name must be a non-blank string of 1-200/],
  ['paperclipCreateProject', { name: '   ' }, /name must be a non-blank string/],
  ['paperclipCreateProject', { name: 'n'.repeat(201) }, /name must be a non-blank string of 1-200/],
  ['paperclipCreateProject', { name: 5 }, /name must be/],
  ['paperclipCreateProject', { name: 'x', companyId: otherCompany }, /unexpected field "companyId"/],
  ['paperclipCreateProject', { name: 'x', env: { A: 'b' } }, /unexpected field "env"/],
  ['paperclipCreateProject', { name: 'x', executionWorkspacePolicy: { enabled: true } }, /unexpected field "executionWorkspacePolicy"/],
  ['paperclipCreateProject', { name: 'x', workspace: { cwd: '/' } }, /unexpected field "workspace"/],
  ['paperclipCreateProject', { name: 'x', repositoryIds: ['1'] }, /unexpected field "repositoryIds"/],
  ['paperclipCreateProject', { name: 'x', repositoryUrls: ['https://a.test/r.git'] }, /unexpected field "repositoryUrls"/],
  ['paperclipCreateProject', { name: 'x', archivedAt: '2026-10-13T00:00:00Z' }, /unexpected field "archivedAt"/],
  ['paperclipCreateProject', { name: 'x', goalId: goalA }, /unexpected field "goalId"/],
  ['paperclipCreateProject', { name: 'x', icon: 'rocket' }, /unexpected field "icon"/],
  ['paperclipCreateProject', { name: 'x', description: 5 }, /description must be a string of at most 10000 characters, or null/],
  ['paperclipCreateProject', { name: 'x', description: 'd'.repeat(10_001) }, /description must be a string of at most 10000/],
  ['paperclipCreateProject', { name: 'x', status: 'paused' }, /status must be one of backlog, planned, in_progress, completed, cancelled/],
  ['paperclipCreateProject', { name: 'x', status: 'IN_PROGRESS' }, /status must be one of/],
  ['paperclipCreateProject', { name: 'x', status: null }, /status must be one of/],
  ['paperclipCreateProject', { name: 'x', goalIds: goalA }, /goalIds must be an array of at most 20 distinct goal UUIDs/],
  ['paperclipCreateProject', { name: 'x', goalIds: ['nope'] }, /goalIds must be an array/],
  ['paperclipCreateProject', { name: 'x', goalIds: [goalA, goalA] }, /goalIds must be an array.*distinct/],
  ['paperclipCreateProject', { name: 'x', goalIds: [goalL, goalL.toUpperCase()] }, /goalIds must be an array.*distinct/],
  ['paperclipCreateProject', { name: 'x', goalIds: Array.from({ length: 21 }, (_, index) => uuidN(500 + index)) }, /goalIds must be an array of at most 20/],
  ['paperclipCreateProject', { name: 'x', goalIds: null }, /goalIds must be an array/],
  ['paperclipCreateProject', { name: 'x', targetDate: '2026-13-01' }, /targetDate must be a calendar date formatted YYYY-MM-DD/],
  ['paperclipCreateProject', { name: 'x', targetDate: '2026-02-30' }, /targetDate must be a calendar date/],
  ['paperclipCreateProject', { name: 'x', targetDate: '2026-10-13T00:00:00Z' }, /targetDate must be a calendar date/],
  ['paperclipCreateProject', { name: 'x', targetDate: '13/10/2026' }, /targetDate must be a calendar date/],
  ['paperclipCreateProject', { name: 'x', targetDate: null }, /targetDate must be a calendar date formatted YYYY-MM-DD\.$/],
  ['paperclipCreateProject', { name: 'x', color: 'red' }, /color must be a color formatted #rrggbb/],
  ['paperclipCreateProject', { name: 'x', color: '#fff' }, /color must be a color formatted #rrggbb/],
  ['paperclipCreateProject', { name: 'x', color: '#ggg000' }, /color must be a color/],
  ['paperclipCreateProject', { name: 'x', color: null }, /color must be a color formatted #rrggbb\.$/],
  ['paperclipCreateProject', { name: 'x', leadAgentId: 'nope' }, /leadAgentId must be a UUID, or null to clear it/],
  ['paperclipCreateProject', { name: 'x', leadAgentId: 5 }, /leadAgentId must be a UUID/],
  ['paperclipCreateProject', { name: 'x', idempotencyKey: '' }, /idempotencyKey must be a non-blank string of 1-255/],
  ['paperclipCreateProject', { name: 'x', idempotencyKey: '  ' }, /idempotencyKey must be a non-blank/],
  ['paperclipCreateProject', { name: 'x', idempotencyKey: 'k'.repeat(256) }, /idempotencyKey must be a non-blank string of 1-255/],
  ['paperclipCreateProject', [], /arguments must be an object/],
  ['paperclipCreateProject', 'x', /arguments must be an object/],
  ['paperclipUpdateProject', {}, /projectId is required/],
  ['paperclipUpdateProject', { name: 'x' }, /projectId is required/],
  ['paperclipUpdateProject', { projectId: 'nope', name: 'x' }, /projectId must be a project UUID/],
  ['paperclipUpdateProject', { projectId: null, name: 'x' }, /projectId must be a project UUID/],
  ['paperclipUpdateProject', { projectId: goalA }, /at least one field besides the id is required: name, description, status, goalIds, targetDate, color, leadAgentId, archived/],
  ['paperclipUpdateProject', { projectId: goalA, idempotencyKey: 'k' }, /unexpected field "idempotencyKey"/],
  ['paperclipUpdateProject', { projectId: goalA, name: null }, /name must be a non-blank string/],
  ['paperclipUpdateProject', { projectId: goalA, status: 'archived' }, /status must be one of/],
  ['paperclipUpdateProject', { projectId: goalA, archived: 'true' }, /archived must be true or false/],
  ['paperclipUpdateProject', { projectId: goalA, archived: null }, /archived must be true or false/],
  ['paperclipUpdateProject', { projectId: goalA, archivedAt: '2026-10-13T00:00:00Z' }, /unexpected field "archivedAt"/],
  ['paperclipUpdateProject', { projectId: goalA, pausedAt: '2026-10-13T00:00:00Z' }, /unexpected field "pausedAt"/],
  ['paperclipUpdateProject', { projectId: goalA, pauseReason: 'manual' }, /unexpected field "pauseReason"/],
  ['paperclipUpdateProject', { projectId: goalA, targetDate: '2026-00-10' }, /targetDate must be a calendar date/],
  ['paperclipUpdateProject', { projectId: goalA, color: '#12345' }, /color must be a color/],
  ['paperclipUpdateProject', { projectId: goalA, goalIds: [goalA, 'x'] }, /goalIds must be an array/],
  ['paperclipUpdateProject', { projectId: goalA, companyId: otherCompany, name: 'x' }, /unexpected field "companyId"/],
  ['paperclipCreateGoal', {}, /title is required/],
  ['paperclipCreateGoal', { title: '' }, /title must be a non-blank string of 1-200/],
  ['paperclipCreateGoal', { title: 't'.repeat(201) }, /title must be a non-blank string of 1-200/],
  ['paperclipCreateGoal', { title: 'x', name: 'x' }, /unexpected field "name"/],
  ['paperclipCreateGoal', { title: 'x', companyId: otherCompany }, /unexpected field "companyId"/],
  ['paperclipCreateGoal', { title: 'x', level: 'galaxy' }, /level must be one of company, team, agent, task/],
  ['paperclipCreateGoal', { title: 'x', status: 'done' }, /status must be one of planned, active, achieved, cancelled/],
  ['paperclipCreateGoal', { title: 'x', description: 7 }, /description must be a string/],
  ['paperclipCreateGoal', { title: 'x', parentId: 'nope' }, /parentId must be a UUID, or null/],
  ['paperclipCreateGoal', { title: 'x', ownerAgentId: 'nope' }, /ownerAgentId must be a UUID, or null/],
  ['paperclipCreateGoal', { title: 'x', idempotencyKey: 'k' }, /unexpected field "idempotencyKey"/],
  ['paperclipUpdateGoal', {}, /goalId is required/],
  ['paperclipUpdateGoal', { title: 'x' }, /goalId is required/],
  ['paperclipUpdateGoal', { goalId: 'nope', title: 'x' }, /goalId must be a goal UUID/],
  ['paperclipUpdateGoal', { goalId: goalA }, /at least one field besides the id is required: title, description, level, status, parentId, ownerAgentId/],
  ['paperclipUpdateGoal', { goalId: goalA, parentId: goalA }, /parentId cannot be the goal itself/],
  ['paperclipUpdateGoal', { goalId: goalA, parentId: goalA.toUpperCase() }, /parentId cannot be the goal itself/],
  ['paperclipUpdateGoal', { goalId: goalA, title: null }, /title must be a non-blank string/],
  ['paperclipUpdateGoal', { goalId: goalA, level: 'org' }, /level must be one of/],
  ['paperclipUpdateGoal', { goalId: goalA, status: 'planned', extra: 1 }, /unexpected field "extra"/],
];

for (const [index, [name, args, pattern]] of VALIDATION_CASES.entries()) {
  test(`validation #${index} rejects bad ${name} input before any HTTP call`, async () => {
    const ctx = setup();
    const reply = await callTool(ctx, name, args);
    assert.equal(reply.result.isError, true);
    assert.match(textOf(reply), /^Invalid input: /);
    assert.match(textOf(reply), pattern);
    assert.equal(ctx.host.requests.length, 0);
    noSecrets(ctx);
  });
}

test('accepted boundary inputs: 20 goals, 200-character names, 10000-character descriptions, null clears, leap day', async () => {
  const ctx = setup();
  const goalIds = [];
  for (let index = 0; index < 20; index++) {
    goalIds.push(ctx.host.addGoal().id);
  }
  const created = await callTool(ctx, 'paperclipCreateProject', {
    name: 'n'.repeat(200), description: 'd'.repeat(10_000), goalIds, targetDate: '2028-02-29', color: '#AbCdEf', idempotencyKey: 'k'.repeat(255),
  });
  assert.equal(created.result.isError, undefined, textOf(created));
  const id = payloadOf(created).project.id;
  const cleared = await callTool(ctx, 'paperclipUpdateProject', { projectId: id, description: null, targetDate: null, color: null, leadAgentId: null, goalIds: [] }, 2);
  assert.equal(cleared.result.isError, undefined, textOf(cleared));
  assert.deepEqual(payloadOf(cleared).project.goalIds, []);
  assert.equal(payloadOf(cleared).warnings, undefined);
});

// ---------------------------------------------------------------------------------------------
// paperclipCreateProject

test('create project: checks the references, then POSTs only allowed fields to the pinned company and reads the project back', async () => {
  const ctx = setup();
  const reply = await callTool(ctx, 'paperclipCreateProject', {
    name: 'Checkout revamp', description: 'Faster **checkout**', status: 'planned', goalIds: [goalA, goalB], targetDate: '2026-12-31',
    color: '#336699', leadAgentId: agentA, idempotencyKey: 'create-1',
  });
  assert.equal(reply.result.isError, undefined, textOf(reply));
  const sequence = ctx.host.requests.map((request) => `${request.method} ${request.url.pathname}`);
  assert.deepEqual(sequence.slice(0, 3).sort(), [`GET /api/agents/${agentA}`, `GET /api/goals/${goalA}`, `GET /api/goals/${goalB}`].sort());
  const [post, readBack] = ctx.host.requests.slice(3);
  assert.equal(`${post.method} ${post.url.pathname}`, `POST /api/companies/${companyId}/projects`);
  assert.deepEqual(post.body, {
    name: 'Checkout revamp', description: 'Faster **checkout**', status: 'planned', goalIds: [goalA, goalB], targetDate: '2026-12-31',
    color: '#336699', leadAgentId: agentA, idempotencyKey: 'create-1',
  });
  assert.equal(ctx.host.requests.length, 5);
  const created = [...ctx.host.store.projects.values()].at(-1);
  assert.equal(`${readBack.method} ${readBack.url.pathname}`, `GET /api/projects/${created.id}`);
  for (const request of ctx.host.requests) {
    assert.equal(request.url.origin, 'https://paperclip.test');
    assert.equal(request.url.searchParams.get('companyId'), companyId);
    assert.equal(request.options.headers.authorization, `Bearer ${env.PAPERCLIP_API_KEY}`);
    assert.equal(request.options.headers.accept, 'application/json');
    assert.equal(request.options.redirect, 'error');
    assert.ok(request.options.signal instanceof AbortSignal);
    assert.equal(request.options.headers['content-type'], request.method === 'GET' ? undefined : 'application/json');
  }
  assert.deepEqual(payloadOf(reply), {
    created: true,
    project: {
      id: created.id, name: 'Checkout revamp', urlKey: 'checkout-revamp', status: 'planned', description: 'Faster **checkout**',
      goalIds: [goalA, goalB], leadAgentId: agentA, targetDate: '2026-12-31', archivedAt: null,
    },
  });
  assert.equal(reply.result.content.length, 1, 'no warning block when everything stuck');
  // Nothing host-internal reaches the model.
  assert.doesNotMatch(textOf(reply), /env|executionWorkspacePolicy|workspaces|codebase|API_TOKEN|private/);
  noSecrets(ctx);
});

test('create project: only the name is needed, and nothing else is sent', async () => {
  const ctx = setup();
  const reply = await callTool(ctx, 'paperclipCreateProject', { name: 'Minimal' });
  assert.equal(reply.result.isError, undefined);
  assert.equal(ctx.host.writes().length, 1);
  assert.deepEqual(ctx.host.writes()[0].body, { name: 'Minimal' });
  assert.equal(payloadOf(reply).project.status, 'backlog');
  assert.equal(ctx.host.requests.length, 2, 'one POST and one read-back, no reference lookups');
});

test('create project: a goal or lead agent from another company, or an unknown one, stops before any write', async () => {
  const cases = [
    [{ goalIds: [goalA, foreignGoal] }, /goalIds\[1\] \(.*\) is not a goal of the configured Paperclip company/],
    [{ goalIds: [missingId] }, /goalIds\[0\] .* is not a goal of the configured Paperclip company/],
    [{ leadAgentId: foreignAgent }, /leadAgentId \(.*\) is not an agent of the configured Paperclip company/],
    [{ leadAgentId: missingId }, /leadAgentId .* of the configured Paperclip company/],
    [{ leadAgentId: goalA }, /leadAgentId .* of the configured Paperclip company/],
  ];
  for (const [extra, pattern] of cases) {
    const ctx = setup();
    const reply = await callTool(ctx, 'paperclipCreateProject', { name: 'Blocked', ...extra });
    assert.equal(reply.result.isError, true, JSON.stringify(extra));
    assert.match(textOf(reply), /^Not found: /);
    assert.match(textOf(reply), pattern);
    assert.match(textOf(reply), /Nothing was written\.$/);
    assert.deepEqual(ctx.host.writes(), []);
    assert.ok(![...ctx.host.store.projects.values()].some((project) => project.name === 'Blocked'));
  }
});

test('create project: the first problem in input order is reported even though lookups run in parallel', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = setup({
    respond: (request) => (request.url.pathname === `/api/goals/${missingId}` ? gate.then(() => json({ error: 'gone' }, 404)) : undefined),
  });
  send(ctx, 1, 'paperclipCreateProject', { name: 'Ordered', goalIds: [missingId, foreignGoal] });
  await flush();
  await flush();
  assert.equal(ctx.host.requests.length, 2, 'both lookups are in flight together');
  release();
  const reply = await replyTo(ctx, 1);
  assert.match(textOf(reply), /^Not found: goalIds\[0\]/);
  assert.equal(ctx.host.writes().length, 0);
});

test('create project: a reference lookup that fails for another reason is a generic failure, not a not-found', async () => {
  const ctx = setup({ respond: (request) => (request.url.pathname === `/api/goals/${goalA}` ? json({ error: 'boom stack at /srv/x.js' }, 500) : undefined) });
  const reply = await callTool(ctx, 'paperclipCreateProject', { name: 'X', goalIds: [goalA] });
  assert.equal(textOf(reply), 'Roadmap request failed. Check bridge configuration and Paperclip availability.');
  assert.equal(ctx.host.writes().length, 0);
  assert.doesNotMatch(ctx.output.join(''), /boom|srv/);
});

test('create project: a reference record without the pinned company echo fails closed', async () => {
  for (const record of [{ id: goalA }, { id: goalA, companyId: null }, { companyId, id: missingId }, [{ id: goalA, companyId }]]) {
    const ctx = setup({ respond: (request) => (request.url.pathname === `/api/goals/${goalA}` ? json(record) : undefined) });
    const reply = await callTool(ctx, 'paperclipCreateProject', { name: 'X', goalIds: [goalA] });
    assert.equal(reply.result.isError, true);
    assert.doesNotMatch(textOf(reply), /Created|created/);
    assert.equal(ctx.host.writes().length, 0, JSON.stringify(record));
  }
});

test('create project: the read-back state is returned, not the echo of the request', async () => {
  // The POST answers with an echo of the request; the stored project ignores the status.
  const ctx = setup({
    ignore: ['status'],
    respond: (request, host) => {
      if (request.method !== 'POST') {
        return undefined;
      }
      const stored = host.addProject({ name: request.body.name });
      return json({ ...stored, ...request.body, status: request.body.status }, 201);
    },
  });
  const reply = await callTool(ctx, 'paperclipCreateProject', { name: 'Echoed', status: 'in_progress' });
  assert.equal(reply.result.isError, undefined);
  assert.equal(payloadOf(reply).project.status, 'backlog', 'status comes from the read-back');
  assert.equal(ctx.host.requests.at(-1).method, 'GET');
  assert.equal(ctx.host.requests.at(-1).url.pathname, `/api/projects/${payloadOf(reply).project.id}`);
});

test('create project: a field the host ignored is flagged, with a leading warning block', async () => {
  const ctx = setup({ ignore: ['status', 'targetDate'] });
  const reply = await callTool(ctx, 'paperclipCreateProject', { name: 'Flagged', status: 'planned', targetDate: '2026-12-31', color: '#112233' });
  assert.equal(reply.result.isError, undefined);
  const payload = payloadOf(reply);
  assert.equal(payload.warnings.length, 2);
  assert.match(payload.warnings[0], /Field "status" was requested as "planned" but reads back as "backlog": Paperclip ignored or changed it\./);
  assert.match(payload.warnings[1], /Field "targetDate" was requested as "2026-12-31" but reads back as null/);
  assert.equal(reply.result.content.length, 2);
  assert.match(reply.result.content[0].text, /^Warning: Field "status"/);
  assert.match(reply.result.content[0].text, /\nWarning: Field "targetDate"/);
  assert.equal(payload.project.status, 'backlog');
});

test('create project: a colliding name that Paperclip suffixes is called out explicitly', async () => {
  const ctx = setup();
  ctx.host.addProject({ name: 'Mobile app' });
  const reply = await callTool(ctx, 'paperclipCreateProject', { name: 'Mobile app' });
  assert.equal(reply.result.isError, undefined);
  const payload = payloadOf(reply);
  assert.equal(payload.project.name, 'Mobile app 2');
  assert.equal(payload.warnings.length, 1);
  assert.match(payload.warnings[0], /The project name was changed: requested "Mobile app" but it reads back as "Mobile app 2"\. Paperclip adds a numeric suffix such as " 2"/);
  assert.match(reply.result.content[0].text, /^Warning: The project name was changed/);
});

test('create project: equivalent stored values raise no warning (goal order, color case, timestamp-shaped date, explicit null)', async () => {
  const ctx = setup({
    respond: (request, host) => {
      if (request.method !== 'POST') {
        return undefined;
      }
      const stored = host.addProject({
        name: 'Same', goalIds: [goalB, goalL.toUpperCase()], color: '#ABCDEF', targetDate: '2026-12-31T00:00:00.000Z', description: null, leadAgentId: null,
      });
      return json(stored, 201);
    },
  });
  const reply = await callTool(ctx, 'paperclipCreateProject', {
    name: 'Same', goalIds: [goalL, goalB], color: '#abcdef', targetDate: '2026-12-31', description: null, leadAgentId: null,
  });
  assert.equal(reply.result.isError, undefined);
  assert.equal(payloadOf(reply).warnings, undefined);
});

test('create project: a repeated idempotency key returns the first project and says so', async () => {
  const ctx = setup();
  const first = await callTool(ctx, 'paperclipCreateProject', { name: 'Once', idempotencyKey: 'same-key' }, 1);
  const second = await callTool(ctx, 'paperclipCreateProject', { name: 'Once', idempotencyKey: 'same-key' }, 2);
  assert.equal(payloadOf(first).created, true);
  assert.equal(payloadOf(second).created, false);
  assert.equal(payloadOf(second).project.id, payloadOf(first).project.id);
  assert.match(payloadOf(second).warnings[0], /already created with this idempotencyKey/);
  assert.equal([...ctx.host.store.projects.values()].filter((project) => project.name === 'Once').length, 1);
});

test('create project: when the read-back is unavailable the write is still reported, with a warning, never as a failure', async () => {
  for (const readBack of [() => json({ error: 'down' }, 503), () => { throw new Error('socket hang up'); }, () => json({ id: 'x', companyId: otherCompany })]) {
    const ctx = setup({ respond: (request) => (request.method === 'GET' && /^\/api\/projects\//.test(request.url.pathname) ? readBack() : undefined) });
    const reply = await callTool(ctx, 'paperclipCreateProject', { name: 'Unreadable' });
    assert.equal(reply.result.isError, undefined, textOf(reply));
    const payload = payloadOf(reply);
    assert.equal(payload.created, true);
    assert.equal(payload.project.name, 'Unreadable');
    assert.match(payload.warnings[0], /could not be read back from Paperclip/);
    assert.equal(ctx.host.writes().length, 1);
  }
});

// ---------------------------------------------------------------------------------------------
// paperclipUpdateProject

test('update project: reads the project first, checks references, PATCHes only the given fields and reads it back', async () => {
  const ctx = setup();
  const project = ctx.host.addProject({ name: 'Old name' });
  ctx.host.requests.length = 0;
  const reply = await callTool(ctx, 'paperclipUpdateProject', { projectId: project.id, name: 'New name', status: 'in_progress', goalIds: [goalB], leadAgentId: agentA, targetDate: '2027-01-15', color: '#010203', description: 'Now **with** text' });
  assert.equal(reply.result.isError, undefined, textOf(reply));
  const sequence = ctx.host.requests.map((request) => `${request.method} ${request.url.pathname}`);
  assert.equal(sequence[0], `GET /api/projects/${project.id}`);
  assert.deepEqual(sequence.slice(1, 3).sort(), [`GET /api/agents/${agentA}`, `GET /api/goals/${goalB}`].sort());
  assert.equal(sequence[3], `PATCH /api/projects/${project.id}`);
  assert.equal(sequence[4], `GET /api/projects/${project.id}`);
  assert.equal(sequence.length, 5);
  assert.deepEqual(ctx.host.requests[3].body, { name: 'New name', description: 'Now **with** text', status: 'in_progress', goalIds: [goalB], targetDate: '2027-01-15', color: '#010203', leadAgentId: agentA });
  assert.deepEqual(payloadOf(reply), {
    updated: true,
    project: {
      id: project.id, name: 'New name', urlKey: 'new-name', status: 'in_progress', description: 'Now **with** text', goalIds: [goalB],
      leadAgentId: agentA, targetDate: '2027-01-15', archivedAt: null,
    },
  });
  assert.doesNotMatch(textOf(reply), /API_TOKEN|private/);
  noSecrets(ctx);
});

test('update project: goalIds replaces the set, and null or empty values clear', async () => {
  const ctx = setup();
  const project = ctx.host.addProject({ goalIds: [goalA, goalB], targetDate: '2026-10-01', color: '#000000', leadAgentId: agentA, description: 'x' });
  const reply = await callTool(ctx, 'paperclipUpdateProject', { projectId: project.id, goalIds: [], targetDate: null, color: null, leadAgentId: null, description: null });
  assert.equal(reply.result.isError, undefined);
  assert.deepEqual(ctx.host.writes()[0].body, { goalIds: [], description: null, targetDate: null, color: null, leadAgentId: null });
  assert.deepEqual(payloadOf(reply).project, {
    id: project.id, name: 'Existing project', urlKey: 'existing-project', status: 'backlog', description: null, goalIds: [], leadAgentId: null, targetDate: null, archivedAt: null,
  });
  // Clearing needs no reference lookups.
  assert.equal(ctx.host.requests.filter((request) => request.url.pathname.startsWith('/api/goals') || request.url.pathname.startsWith('/api/agents')).length, 0);
});

test('update project: an unknown project, or one of another company, is not found and nothing is written', async () => {
  const ctx = setup();
  const foreign = ctx.host.addProject({ companyId: otherCompany, name: 'Foreign' });
  for (const target of [missingId, foreign.id]) {
    const reply = await callTool(ctx, 'paperclipUpdateProject', { projectId: target, name: 'Hijack', archived: true });
    assert.equal(reply.result.isError, true);
    assert.equal(textOf(reply), `Not found: project ${target} does not exist in the configured Paperclip company. Nothing was written.`);
    assert.deepEqual(ctx.host.writes(), []);
    assert.equal(ctx.host.store.projects.get(foreign.id).name, 'Foreign');
  }
});

test('update project: a project answer that cannot be verified (no company, wrong id, 5xx, transport error) never leads to a write', async () => {
  const project = uuidN(900);
  const answers = [
    () => json({ id: project, name: 'No company' }),
    () => json({ id: project, companyId: null }),
    () => json({ id: missingId, companyId }),
    () => json([{ id: project, companyId }]),
    () => new Response('<html>oops</html>', { status: 200 }),
    () => json({ error: 'down' }, 500),
    () => json({ error: 'nope' }, 403),
    () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443'); },
  ];
  for (const answer of answers) {
    const ctx = setup({ respond: (request) => (request.method === 'GET' ? answer() : undefined) });
    const reply = await callTool(ctx, 'paperclipUpdateProject', { projectId: project, name: 'X' });
    assert.equal(reply.result.isError, true);
    assert.equal(ctx.host.writes().length, 0);
    assert.doesNotMatch(textOf(reply), /ECONNREFUSED|oops|10\.0\.0\.1/);
  }
});

test('update project: a random UUID fails as not found without any write', async () => {
  const ctx = setup();
  const reply = await callTool(ctx, 'paperclipUpdateProject', { projectId: '6f1c2a54-9b0e-4c1a-8d77-3e5f0a1b2c3d', status: 'completed' });
  assert.equal(reply.result.isError, true);
  assert.match(textOf(reply), /^Not found: project 6f1c2a54-9b0e-4c1a-8d77-3e5f0a1b2c3d does not exist/);
  assert.equal(ctx.host.requests.length, 1);
  assert.equal(ctx.host.requests[0].method, 'GET');
});

test('update project: a goal or lead agent of another company is rejected before the PATCH', async () => {
  const ctx = setup();
  const project = ctx.host.addProject({ name: 'Keep' });
  const goal = await callTool(ctx, 'paperclipUpdateProject', { projectId: project.id, goalIds: [goalA, foreignGoal] }, 1);
  assert.match(textOf(goal), /^Not found: goalIds\[1\] \(.*\) is not a goal of the configured Paperclip company/);
  const agent = await callTool(ctx, 'paperclipUpdateProject', { projectId: project.id, leadAgentId: foreignAgent }, 2);
  assert.match(textOf(agent), /^Not found: leadAgentId \(.*\) is not an agent of the configured Paperclip company/);
  assert.deepEqual(ctx.host.writes(), []);
  assert.deepEqual(ctx.host.store.projects.get(project.id).goalIds, []);
});

test('update project: archived true sends the current time as an ISO string, false sends null', async () => {
  const ctx = setup();
  const project = ctx.host.addProject({});
  const before = Date.now();
  const archived = await callTool(ctx, 'paperclipUpdateProject', { projectId: project.id, archived: true }, 1);
  const body = ctx.host.writes()[0].body;
  assert.deepEqual(Object.keys(body), ['archivedAt']);
  assert.match(body.archivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(body.archivedAt) >= before - 1000 && Date.parse(body.archivedAt) <= Date.now() + 1000);
  assert.equal(payloadOf(archived).project.archivedAt, body.archivedAt);
  assert.equal(payloadOf(archived).warnings, undefined);

  const restored = await callTool(ctx, 'paperclipUpdateProject', { projectId: project.id, archived: false }, 2);
  assert.deepEqual(ctx.host.writes()[1].body, { archivedAt: null });
  assert.equal(payloadOf(restored).project.archivedAt, null);
});

test('update project: repeating archived does not move archivedAt and writes nothing when nothing else changes', async () => {
  const ctx = setup();
  const stamp = '2026-09-01T10:00:00.000Z';
  const archived = ctx.host.addProject({ archivedAt: stamp });
  const active = ctx.host.addProject({ name: 'Active' });
  const again = await callTool(ctx, 'paperclipUpdateProject', { projectId: archived.id, archived: true }, 1);
  assert.equal(again.result.isError, undefined);
  assert.equal(payloadOf(again).updated, false);
  assert.equal(payloadOf(again).project.id, archived.id);
  assert.equal(payloadOf(again).project.archivedAt, stamp);
  const already = await callTool(ctx, 'paperclipUpdateProject', { projectId: active.id, archived: false }, 2);
  assert.equal(payloadOf(already).updated, false);
  assert.deepEqual(ctx.host.writes(), []);
  // With another change in the same call, archivedAt is still left alone.
  const renamed = await callTool(ctx, 'paperclipUpdateProject', { projectId: archived.id, archived: true, name: 'Renamed' }, 3);
  assert.deepEqual(ctx.host.writes()[0].body, { name: 'Renamed' });
  assert.equal(payloadOf(renamed).project.archivedAt, stamp);
});

test('update project: flags a field that did not stick and a suffixed name', async () => {
  const ctx = setup({ ignore: ['status'] });
  ctx.host.addProject({ name: 'Taken' });
  const project = ctx.host.addProject({ name: 'Mine' });
  const reply = await callTool(ctx, 'paperclipUpdateProject', { projectId: project.id, name: 'Taken', status: 'completed', archived: true });
  const payload = payloadOf(reply);
  assert.equal(payload.project.name, 'Taken 2');
  assert.equal(payload.warnings.length, 2);
  assert.match(payload.warnings[0], /The project name was changed: requested "Taken" but it reads back as "Taken 2"/);
  assert.match(payload.warnings[1], /Field "status" was requested as "completed" but reads back as "backlog"/);
  assert.equal(payload.project.status, 'backlog');
  assert.notEqual(payload.project.archivedAt, null);
  // An archived request the host ignores is flagged as well.
  const ignoring = setup({ ignore: ['archivedAt'] });
  const other = ignoring.host.addProject({});
  const flagged = payloadOf(await callTool(ignoring, 'paperclipUpdateProject', { projectId: other.id, archived: true }));
  assert.match(flagged.warnings[0], /Field "archived" was requested as true but reads back as false/);
});

test('update project: the PATCH answer is not trusted over the read-back, and an unreadable state is reported as such', async () => {
  const ctx = setup({
    respond: (request, host) => {
      if (request.method === 'PATCH') {
        return json({ ...host.store.projects.get(request.url.pathname.split('/').at(-1)), name: 'Echo name', status: 'completed' });
      }
      return undefined;
    },
  });
  const project = ctx.host.addProject({ name: 'Real name' });
  const reply = await callTool(ctx, 'paperclipUpdateProject', { projectId: project.id, status: 'completed' });
  assert.equal(payloadOf(reply).project.name, 'Real name');
  assert.equal(payloadOf(reply).project.status, 'backlog');
  assert.match(payloadOf(reply).warnings[0], /Field "status" was requested as "completed" but reads back as "backlog"/);

  let gets = 0;
  const flaky = setup({ respond: (request) => (request.method === 'GET' && ++gets > 1 ? json({ error: 'down' }, 500) : undefined) });
  const target = flaky.host.addProject({ name: 'Flaky' });
  const flakyReply = await callTool(flaky, 'paperclipUpdateProject', { projectId: target.id, name: 'Flaky 3' });
  assert.equal(flakyReply.result.isError, undefined);
  assert.match(payloadOf(flakyReply).warnings[0], /could not be read back/);
  assert.equal(payloadOf(flakyReply).project.name, 'Flaky 3');
});

// ---------------------------------------------------------------------------------------------
// Goals

test('create goal: checks parent and owner, POSTs to the pinned company and returns the goal read back', async () => {
  const ctx = setup();
  const reply = await callTool(ctx, 'paperclipCreateGoal', { title: 'Grow revenue', description: 'Hit the **target**', level: 'team', status: 'active', parentId: goalA, ownerAgentId: agentA });
  assert.equal(reply.result.isError, undefined, textOf(reply));
  const sequence = ctx.host.requests.map((request) => `${request.method} ${request.url.pathname}`);
  assert.deepEqual(sequence.slice(0, 2).sort(), [`GET /api/agents/${agentA}`, `GET /api/goals/${goalA}`].sort());
  assert.equal(sequence[2], `POST /api/companies/${companyId}/goals`);
  assert.deepEqual(ctx.host.requests[2].body, { title: 'Grow revenue', description: 'Hit the **target**', level: 'team', status: 'active', parentId: goalA, ownerAgentId: agentA });
  const created = [...ctx.host.store.goals.values()].at(-1);
  assert.equal(sequence[3], `GET /api/goals/${created.id}`);
  assert.deepEqual(payloadOf(reply), {
    created: true,
    goal: { id: created.id, title: 'Grow revenue', description: 'Hit the **target**', level: 'team', status: 'active', parentId: goalA, ownerAgentId: agentA },
  });
  assert.doesNotMatch(textOf(reply), /createdAt|updatedAt|companyId/);
});

test('create goal: only the title is needed, and defaults come from the host read-back', async () => {
  const ctx = setup();
  const reply = await callTool(ctx, 'paperclipCreateGoal', { title: 'Plain' });
  assert.deepEqual(ctx.host.writes()[0].body, { title: 'Plain' });
  assert.equal(payloadOf(reply).goal.level, 'task');
  assert.equal(payloadOf(reply).goal.status, 'planned');
  assert.equal(payloadOf(reply).warnings, undefined);
});

test('create goal: parent or owner from another company or unknown stops before the write', async () => {
  const cases = [
    [{ parentId: foreignGoal }, /^Not found: parentId \(.*\) is not a goal of the configured Paperclip company\. Nothing was written\.$/],
    [{ parentId: missingId }, /^Not found: parentId/],
    [{ ownerAgentId: foreignAgent }, /^Not found: ownerAgentId \(.*\) is not an agent of the configured Paperclip company/],
    [{ ownerAgentId: goalA }, /^Not found: ownerAgentId/],
  ];
  for (const [extra, pattern] of cases) {
    const ctx = setup();
    const reply = await callTool(ctx, 'paperclipCreateGoal', { title: 'Blocked', ...extra });
    assert.equal(reply.result.isError, true);
    assert.match(textOf(reply), pattern);
    assert.deepEqual(ctx.host.writes(), []);
  }
});

test('create goal: flags fields the host ignored', async () => {
  const ctx = setup({ ignore: ['level', 'ownerAgentId'] });
  const reply = await callTool(ctx, 'paperclipCreateGoal', { title: 'Flagged', level: 'company', ownerAgentId: agentA });
  const warnings = payloadOf(reply).warnings;
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Field "level" was requested as "company" but reads back as "task"/);
  assert.match(warnings[1], /Field "ownerAgentId" was requested as "[0-9a-f-]+" but reads back as null/);
});

test('update goal: reads the goal first, checks references, PATCHes the given fields and reads it back', async () => {
  const ctx = setup();
  const goal = ctx.host.addGoal({ title: 'Old' });
  ctx.host.requests.length = 0;
  const reply = await callTool(ctx, 'paperclipUpdateGoal', { goalId: goal.id, title: 'Renamed', status: 'achieved', parentId: goalA, ownerAgentId: agentA, description: null, level: 'team' });
  assert.equal(reply.result.isError, undefined, textOf(reply));
  const sequence = ctx.host.requests.map((request) => `${request.method} ${request.url.pathname}`);
  assert.equal(sequence[0], `GET /api/goals/${goal.id}`);
  assert.deepEqual(sequence.slice(1, 3).sort(), [`GET /api/agents/${agentA}`, `GET /api/goals/${goalA}`].sort());
  assert.equal(sequence[3], `PATCH /api/goals/${goal.id}`);
  assert.equal(sequence[4], `GET /api/goals/${goal.id}`);
  assert.deepEqual(ctx.host.requests[3].body, { title: 'Renamed', description: null, level: 'team', status: 'achieved', parentId: goalA, ownerAgentId: agentA });
  assert.deepEqual(payloadOf(reply), {
    updated: true,
    goal: { id: goal.id, title: 'Renamed', description: null, level: 'team', status: 'achieved', parentId: goalA, ownerAgentId: agentA },
  });
});

test('update goal: unknown or foreign goals, parents and owners never reach the PATCH', async () => {
  const ctx = setup();
  const own = ctx.host.addGoal({ title: 'Own' });
  const foreign = ctx.host.addGoal({ companyId: otherCompany, title: 'Foreign' });
  for (const target of [missingId, foreign.id]) {
    const reply = await callTool(ctx, 'paperclipUpdateGoal', { goalId: target, title: 'Hijack' });
    assert.equal(textOf(reply), `Not found: goal ${target} does not exist in the configured Paperclip company. Nothing was written.`);
  }
  assert.match(textOf(await callTool(ctx, 'paperclipUpdateGoal', { goalId: own.id, parentId: foreignGoal })), /^Not found: parentId/);
  assert.match(textOf(await callTool(ctx, 'paperclipUpdateGoal', { goalId: own.id, ownerAgentId: foreignAgent })), /^Not found: ownerAgentId/);
  assert.deepEqual(ctx.host.writes(), []);
  assert.equal(ctx.host.store.goals.get(own.id).parentId, null);
  assert.equal(ctx.host.store.goals.get(foreign.id).title, 'Foreign');
});

test('update goal: null clears the description, parent and owner; unset fields are not sent', async () => {
  const ctx = setup();
  const goal = ctx.host.addGoal({ description: 'x', parentId: goalA, ownerAgentId: agentA });
  const reply = await callTool(ctx, 'paperclipUpdateGoal', { goalId: goal.id, description: null, parentId: null, ownerAgentId: null });
  assert.deepEqual(ctx.host.writes()[0].body, { description: null, parentId: null, ownerAgentId: null });
  assert.equal(payloadOf(reply).goal.parentId, null);
  assert.equal(payloadOf(reply).warnings, undefined);
});

// ---------------------------------------------------------------------------------------------
// Error policy

test('core 400, 404, 409 and 422 answers pass the host text through, bounded, and zod issues become path lines', async () => {
  const cases = [
    [400, { error: 'Validation error', details: [{ code: 'invalid_enum_value', path: ['status'], message: 'Invalid enum value. Expected backlog | planned' }, { path: [], message: 'Required' }, { path: ['goalIds', 0], message: 'Invalid guid' }] },
      'Paperclip rejected the request (HTTP 400): Validation error\n- status: Invalid enum value. Expected backlog | planned\n- Required\n- goalIds.0: Invalid guid'],
    [404, { error: 'Project not found' }, 'Paperclip rejected the request (HTTP 404): Project not found'],
    [409, { error: 'Project idempotency key was used with different inputs' }, 'Paperclip rejected the request (HTTP 409): Project idempotency key was used with different inputs'],
    [422, { error: 'Unknown goal id(s) for this company: abc', details: { unknownGoalIds: ['abc'] } }, 'Paperclip rejected the request (HTTP 422): Unknown goal id(s) for this company: abc'],
    [422, { error: 'Validation error', details: ['plain string detail', 5, null, { no: 'message' }] }, 'Paperclip rejected the request (HTTP 422): Validation error\n- plain string detail'],
  ];
  for (const [status, body, expected] of cases) {
    const ctx = setup({ respond: (request) => (request.method === 'POST' ? json({ ...body, stack: 'at secret.js:1', sql: 'select *' }, status) : undefined) });
    const reply = await callTool(ctx, 'paperclipCreateProject', { name: 'X' });
    assert.equal(reply.result.isError, true);
    assert.equal(textOf(reply), expected);
    noSecrets(ctx);
    assert.doesNotMatch(ctx.output.join(''), /secret\.js|select \*/);
  }
});

test('host error text is bounded to 300 characters and 20 detail lines, one line each', async () => {
  const details = Array.from({ length: 27 }, (_, index) => ({ path: ['goalIds', index], message: `bad\n${'m'.repeat(400)}` }));
  const ctx = setup({ respond: (request) => (request.method === 'PATCH' ? json({ error: `e${'r'.repeat(500)}`, details }, 422) : undefined) });
  const project = ctx.host.addProject({});
  const reply = await callTool(ctx, 'paperclipUpdateProject', { projectId: project.id, name: 'x' });
  const lines = textOf(reply).split('\n');
  assert.equal(lines[0].replace('Paperclip rejected the request (HTTP 422): ', '').length, 300);
  assert.equal(lines.length, 1 + MAX_ERROR_DETAIL_LINES + 1);
  for (const line of lines.slice(1, 1 + MAX_ERROR_DETAIL_LINES)) {
    assert.match(line, /^- goalIds\.\d+: bad m+…?$/);
    assert.ok(line.length - 2 <= 300);
  }
  assert.equal(lines.at(-1), '- (7 more not shown)');
});

test('401, 403, 429, 5xx, transport errors, timeouts and malformed bodies stay generic and echo nothing', async () => {
  const leaks = 'private token response body host-secret-value stack at /srv/app.js SELECT *';
  const responses = [
    () => new Response(leaks, { status: 500 }),
    () => json({ error: leaks }, 500),
    () => json({ error: leaks }, 502),
    () => json({ error: leaks }, 401),
    () => json({ error: leaks }, 403),
    () => json({ error: leaks }, 429),
    () => json({ error: { message: leaks } }, 400),
    () => json({ details: [leaks] }, 422),
    () => new Response(leaks, { status: 400 }),
    () => json([{ error: leaks }], 404),
    () => new Response(leaks, { status: 200 }),
    () => json({ ...leaks.split(' ') }, 201),
    () => new Response('x'.repeat(1024 * 1024 + 1), { status: 201 }),
    () => { throw new Error(leaks); },
  ];
  for (const answer of responses) {
    const ctx = setup({ respond: (request) => (request.method === 'POST' ? answer() : undefined) });
    const reply = await callTool(ctx, 'paperclipCreateProject', { name: 'Generic' });
    assert.equal(reply.result.isError, true);
    assert.match(textOf(reply), /^Roadmap request failed\. Check bridge configuration and Paperclip availability\./);
    assert.doesNotMatch(ctx.output.join('') + ctx.errors.join(''), /private token|host-secret|stack at|SELECT|app\.js/);
  }
  // Write failures that may have been applied say so; refusals (401, 403, 429) do not.
  const uncertain = setup({ respond: (request) => (request.method === 'POST' ? json({ error: 'x' }, 503) : undefined) });
  assert.match(textOf(await callTool(uncertain, 'paperclipCreateProject', { name: 'N' })), /The write may or may not have been applied/);
  const refused = setup({ respond: (request) => (request.method === 'POST' ? json({ error: 'x' }, 403) : undefined) });
  assert.doesNotMatch(textOf(await callTool(refused, 'paperclipCreateProject', { name: 'N' })), /may or may not/);
  const read = setup({ respond: (request) => (request.method === 'GET' ? json({ error: 'x' }, 500) : undefined) });
  const target = read.host.addProject({});
  assert.doesNotMatch(textOf(await callTool(read, 'paperclipUpdateProject', { projectId: target.id, name: 'N' })), /may or may not/);
});

test('a write answer that does not carry the pinned company fails closed', async () => {
  for (const mutate of [(record) => ({ ...record, companyId: otherCompany }), ({ companyId: _drop, ...record }) => record, (record) => ({ ...record, id: 'not-a-uuid' })]) {
    const ctx = setup({ respond: (request, host) => {
      if (request.method !== 'POST') {
        return undefined;
      }
      return json(mutate(host.addProject({ name: request.body.name })), 201);
    } });
    const reply = await callTool(ctx, 'paperclipCreateProject', { name: 'Mismatch' });
    assert.equal(reply.result.isError, true);
    assert.match(textOf(reply), /^Roadmap request failed/);
    assert.doesNotMatch(ctx.output.join(''), /Mismatch/);
  }
});

test('requests are aborted after 10 s for GET and 25 s for POST and PATCH', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = [];
  const ctx = makeBridge({
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      pending.push(init.method);
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      if (init.method === 'GET') {
        resolve(json({ id: goalA, companyId }));
      }
    }),
  });
  ctx.bridge.initialized = true;
  const replyFor = (id) => messages(ctx.output).find((entry) => entry.id === id);
  send(ctx, 1, 'paperclipCreateProject', { name: 'Slow', goalIds: [goalA] });
  await flush(); await flush();
  assert.deepEqual(pending, ['GET', 'POST']);
  t.mock.timers.tick(24_999);
  await flush();
  assert.equal(replyFor(1), undefined, 'POST still within its 25 s budget');
  t.mock.timers.tick(1);
  await flush(); await flush();
  assert.match(textOf(replyFor(1)), /^Roadmap request failed\..*may or may not have been applied/);
  assert.equal(ctx.bridge.ownActive, 0);
});

// ---------------------------------------------------------------------------------------------
// Session handling

test('roadmap tools need an initialized session and ignore notifications', async () => {
  const ctx = setup();
  ctx.bridge.initialized = false;
  const reply = await callTool(ctx, 'paperclipCreateGoal', { title: 'x' });
  assert.equal(reply.error.code, -32002);
  ctx.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'paperclipCreateGoal', arguments: { title: 'x' } } })}\n`);
  await flush();
  assert.equal(ctx.host.requests.length, 0);
  assert.equal(messages(ctx.output).length, 1);
});

test('roadmap calls share the bounded own-tool concurrency, answer busy at the limit and release their slot', async () => {
  const gates = [];
  let holding = true;
  const ctx = setup({
    respond: (request) => (holding && request.method === 'POST' ? new Promise((resolve) => { gates.push(resolve); }) : undefined),
  });
  for (let id = 1; id <= 8; id++) {
    send(ctx, id, 'paperclipCreateGoal', { title: `Goal ${id}` });
  }
  await flush();
  assert.equal(gates.length, 8);
  assert.equal(ctx.bridge.ownActive, 8);
  const busy = await callTool(ctx, 'paperclipCreateProject', { name: 'Busy' }, 9);
  assert.equal(busy.result.isError, true);
  assert.equal(textOf(busy), 'Roadmap tools are busy; retry shortly.');
  assert.equal(ctx.host.writes().length, 8, 'the busy call did not start a request');
  holding = false;
  gates.forEach((resolve) => resolve(json({ error: 'released' }, 400)));
  for (let attempt = 0; attempt < 30 && ctx.bridge.ownActive > 0; attempt++) {
    await flush();
  }
  assert.equal(ctx.bridge.ownActive, 0);
  assert.equal((await callTool(ctx, 'paperclipCreateGoal', { title: 'After' }, 10)).result.isError, undefined);
});

test('an unexpected error inside a roadmap flow becomes the generic failure and frees the slot', async () => {
  const ctx = setup();
  ctx.bridge.callRoadmapTool = async () => { throw new TypeError('boom'); };
  const reply = await callTool(ctx, 'paperclipCreateGoal', { title: 'x' });
  assert.equal(textOf(reply), 'Roadmap request failed. Check bridge configuration and Paperclip availability.');
  assert.equal(ctx.bridge.ownActive, 0);
  assert.doesNotMatch(ctx.output.join(''), /boom/);
});

test('a transport error thrown while sending a write says the write may have been applied', async () => {
  const ctx = setup();
  ctx.bridge.apiRequest = () => { throw new TypeError('boom'); };
  const reply = await callTool(ctx, 'paperclipCreateGoal', { title: 'x' });
  assert.equal(textOf(reply), 'Roadmap request failed. Check bridge configuration and Paperclip availability. The write may or may not have been applied: read the resource before retrying (paperclipListProjects, paperclipListGoals).');
  assert.equal(ctx.bridge.ownActive, 0);
});

test('stock tools keep working next to the roadmap tools', async () => {
  const stockResult = { content: [{ type: 'text', text: '[{"id":"project-1"}]' }] };
  const ctx = makeBridge({ stockCallResult: stockResult });
  ctx.bridge.initialized = true;
  send(ctx, 1, 'paperclipListProjects', { companyId });
  await flush();
  assert.deepEqual(messages(ctx.output).find((entry) => entry.id === 1).result, stockResult);
});
