import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';

// Read-only integration check; credentials never enter argv or test output.
// Dashboard and changelog writes only happen when SMOKE_DASHBOARD_WRITE=1 (see README).
// The roadmap tools (projects, goals, dashboard moves) are only exercised with input that cannot
// write anything: it is rejected by the bridge, or it names resources that do not exist.
const env = { ...process.env };
if (!env.PAPERCLIP_API_KEY && env.PAPERCLIP_API_KEY_FILE) {
  env.PAPERCLIP_API_KEY = readFileSync(env.PAPERCLIP_API_KEY_FILE, 'utf8').trim();
}
// A new dashboard needs a project; an existing one is updated in place. So SMOKE_DASHBOARD_PROJECT_ID is
// optional in write mode and only matters when the smoke dashboard has to be created. If it is set, it must
// be a UUID; fail before anything starts.
class SmokeConfigError extends Error {}
const dashboardProject = env.SMOKE_DASHBOARD_PROJECT_ID || undefined;
if (env.SMOKE_DASHBOARD_WRITE === '1' && dashboardProject !== undefined
  && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(dashboardProject)) {
  console.error(JSON.stringify({ ok: false, stage: 'configuration', error: 'SMOKE_DASHBOARD_PROJECT_ID must be the UUID of a project in the configured company.' }));
  process.exit(1);
}
// Optional: scopes the changelog checks (and, in write mode, receives one smoke note).
const changelogProject = env.SMOKE_CHANGELOG_PROJECT_ID || undefined;
if (changelogProject !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(changelogProject)) {
  console.error(JSON.stringify({ ok: false, stage: 'configuration', error: 'SMOKE_CHANGELOG_PROJECT_ID must be the UUID of a project in the configured company.' }));
  process.exit(1);
}
const child = spawn(process.execPath, [fileURLToPath(new URL('../src/bridge.mjs', import.meta.url))], {
  env, stdio: ['pipe', 'pipe', 'ignore'],
});
const pending = new Map();
let seq = 0;
const lines = createInterface({ input: child.stdout });
// Server-initiated notifications (no id). The bridge must announce a refreshed tool list exactly once.
let listChangedNotifications = 0;
lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined && message.method === 'notifications/tools/list_changed') listChangedNotifications++;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timer);
  message.error ? waiter.reject(new Error('MCP request failed')) : waiter.resolve(message.result);
});
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error('MCP request timed out'));
  }, 20_000);
  pending.set(id, { resolve, reject, timer });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = (name, args) => request('tools/call', { name, arguments: args });
const data = (result) => {
  assert.notEqual(result.isError, true, 'Read-only tool failed');
  const value = JSON.parse(result.content.find((item) => item.type === 'text').text);
  assert.equal(value.companyId, env.PAPERCLIP_COMPANY_ID);
  return value;
};
const DASHBOARD_SMOKE_SLUG = 'mcp-bridge-smoke';
const dashboardTools = ['paperclipListDashboards', 'paperclipGetDashboard', 'paperclipDashboardStatus',
  'paperclipUpsertDashboard', 'paperclipUpdateDashboardDataset', 'paperclipValidateDashboardSpec',
  'paperclipListChangelog', 'paperclipAddChangelogEntry', 'paperclipUpdateChangelogEntry', 'paperclipImportChangelogFromIssues'];
const roadmapTools = ['paperclipCreateProject', 'paperclipUpdateProject', 'paperclipCreateGoal', 'paperclipUpdateGoal', 'paperclipMoveDashboard'];
const smokeSpec = (rows, updatedAt = new Date().toISOString()) => ({
  version: 1,
  title: 'MCP bridge smoke test',
  summary: 'Written by the plugin-mcp-bridge smoke test; safe to ignore.',
  datasets: {
    smoke: {
      title: 'Smoke rows',
      description: 'Rows written by the MCP bridge smoke test.',
      source: 'plugin-mcp-bridge smoke test',
      updatedAt,
      columns: ['name', 'value'],
      rows,
    },
  },
  sections: [{
    id: 'main',
    title: 'Smoke test',
    blocks: [
      { type: 'kpis', items: [{ label: 'Checks', value: { dataset: 'smoke', field: 'value', agg: 'sum' }, format: 'int' }] },
      { type: 'markdown', content: 'Written by the `plugin-mcp-bridge` smoke test.' },
    ],
  }],
});
// Dashboard tools return the plugin payload (without the company echo, which the
// bridge already verified); the status tool prepends a summary line, so read the last block.
const dashboardData = (result, what) => {
  assert.notEqual(result.isError, true, `${what} failed`);
  return JSON.parse(result.content.at(-1).text);
};
const errorText = (result) => result.content.map((item) => item.text).join('\n');
let stage = 'initialize';
try {
  const handshake = await request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'observatory-readonly-smoke', version: '0.1.0' },
  });
  assert.equal(handshake.capabilities?.tools?.listChanged, true, 'initialize must advertise tools.listChanged');
  assert.equal(listChangedNotifications, 0, 'tools/list_changed must not precede the initialized notification');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  stage = 'list-changed';
  for (let waited = 0; listChangedNotifications === 0 && waited < 50; waited++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(listChangedNotifications, 1, 'tools/list_changed must follow notifications/initialized exactly once');
  stage = 'catalog';
  const catalog = await request('tools/list', {});
  const names = new Set(catalog.tools.map((tool) => tool.name));
  const added = ['paperclipAgentHealthOverview', 'paperclipDiagnoseAgent', 'paperclipListRunFailures', 'paperclipFindAgentAnomalies', 'paperclipTraceRun'];
  for (const name of [...added, ...dashboardTools, ...roadmapTools]) assert(names.has(name), `Missing tool: ${name}`);
  assert.equal(names.size, catalog.tools.length, 'Tool names must be unique');
  stage = 'identity';
  const identity = await call('paperclipMe', {});
  if (env.PAPERCLIP_SMOKE_EXPECT_AUTH_FAILURE === '1') {
    assert.equal(identity.isError, true, 'Invalid credentials must not resolve an identity');
    const denial = JSON.parse(identity.content.find((item) => item.type === 'text').text);
    assert.equal(denial.code, 'identity_unauthorized');
    console.log(JSON.stringify({ ok: true, checks: ['invalid-credential-denied'] }));
  } else {
  assert.notEqual(identity.isError, true, 'Actor lookup failed');
  const actor = JSON.parse(identity.content.find((item) => item.type === 'text').text);
  assert.equal(typeof actor.id, 'string');
  const isBoard = actor.actorType === 'board';
  stage = 'native-identity';
  const direct = await call('paperclipApiRequest', { method: 'GET', path: isBoard ? '/auth/profile' : '/agents/me' });
  assert.notEqual(direct.isError, true, 'Native identity endpoint failed');
  const directActor = JSON.parse(direct.content.find((item) => item.type === 'text').text);
  assert.equal(actor.id, directActor.id, 'Identity must match the authenticated principal');
  if (isBoard) {
    assert.equal(actor.email, directActor.email);
    assert.deepEqual(Object.keys(actor).sort(), ['actorType', 'email', 'id', 'image', 'name']);
    stage = 'agent-only-denial';
    const agentOnly = await call('paperclipApiRequest', { method: 'GET', path: '/agents/me' });
    // The native server serializes API errors as text without isError.
    // Verify the actual HTTP denial, not that optional MCP envelope flag.
    const error = JSON.parse(agentOnly.content.find((item) => item.type === 'text').text);
    assert.equal(error.status, 401);
    assert.equal(error.body?.error, 'Agent authentication required');
  }
  stage = 'stock-company-read';
  const stock = await call('paperclipListAgents', { companyId: env.PAPERCLIP_COMPANY_ID });
  assert.notEqual(stock.isError, true, 'Official MCP tool failed');
  const stockAgents = JSON.parse(stock.content.find((item) => item.type === 'text').text);
  assert(Array.isArray(stockAgents), 'Official company agent list must be an array, not a textual error');
  if (env.PAPERCLIP_SMOKE_IDENTITY_ONLY === '1') {
    console.log(JSON.stringify({ ok: true, actorType: isBoard ? 'board' : 'agent', toolsTotal: catalog.tools.length,
      checks: ['identity-matches-native', 'no-credential-fields', 'stock-company-read', ...(isBoard ? ['agent-only-denied'] : [])] }));
  } else {
  stage = 'observatory';
  const overview = data(await call(added[0], { windowHours: 24 }));
  assert(overview.agents.length > 0, 'No agents available for the live check');
  const agent = overview.agents.find((row) => row.lastRunId) ?? overview.agents[0];
  const detail = data(await call(added[1], { agentId: agent.id, windowHours: 24 }));
  assert.equal(detail.agent.id, agent.id);
  const failures = data(await call(added[2], { windowHours: 24, limit: 20 }));
  const anomalies = data(await call(added[3], { windowHours: 24, limit: 20 }));
  let traceEvents = null;
  if (agent.lastRunId) {
    const trace = data(await call(added[4], { runId: agent.lastRunId }));
    assert.equal(trace.run.id, agent.lastRunId);
    traceEvents = trace.events?.length ?? 0;
    for (const event of trace.events ?? []) {
      assert(!('payload' in event) && !('message' in event), 'Raw event data must not be returned');
    }
  }
  assert.equal((await call(added[0], { windowHours: 0 })).isError, true);
  assert.equal((await call(added[0], { windowHours: 24, companyId: randomUUID() })).isError, true);
  assert.equal((await call(added[1], { windowHours: 24, agentId: randomUUID() })).isError, true);
  stage = 'dashboards';
  const dashboardChecks = ['dashboard-list'];
  const listed = dashboardData(await call('paperclipListDashboards', {}), 'list dashboards');
  assert(Array.isArray(listed.dashboards), 'Dashboard list must be an array');
  const readSlug = env.SMOKE_DASHBOARD_SLUG;
  if (readSlug) {
    const status = dashboardData(await call('paperclipDashboardStatus', { slug: readSlug }), 'dashboard status').status;
    assert.equal(status.slug, readSlug);
    assert(['fresh', 'stale', 'unknown'].includes(status.health), 'Unexpected dashboard health');
    assert(Array.isArray(status.datasets));
    const dashboard = dashboardData(await call('paperclipGetDashboard', { slug: readSlug }), 'get dashboard').dashboard;
    assert.equal(dashboard.slug, readSlug);
    assert.equal(typeof dashboard.spec, 'object');
    dashboardChecks.push('dashboard-status', 'dashboard-get');
  }
  // Validation is a dry run: nothing is stored.
  assert.equal(dashboardData(await call('paperclipValidateDashboardSpec', { spec: smokeSpec([{ name: 'check', value: 1 }]) }), 'validate spec').valid, true);
  const invalid = await call('paperclipValidateDashboardSpec', { spec: { version: 1 } });
  assert.equal(invalid.isError, true, 'An invalid spec must be rejected');
  assert.match(errorText(invalid), /HTTP 422\): invalid_spec/);
  const missing = await call('paperclipDashboardStatus', { slug: `mcp-bridge-missing-${randomUUID().slice(0, 8)}` });
  assert.equal(missing.isError, true);
  assert.match(errorText(missing), /HTTP 404\): not_found/);
  assert.equal((await call('paperclipGetDashboard', { slug: 'Not A Slug' })).isError, true);
  assert.equal((await call('paperclipListDashboards', { companyId: randomUUID() })).isError, true);
  // projectId: null is refused by the bridge itself, before any HTTP call. The spec is deliberately
  // invalid, so even a regression could not store a dashboard.
  const nullProject = await call('paperclipUpsertDashboard', { slug: 'mcp-bridge-smoke-null-project', projectId: null, spec: { version: 1 } });
  assert.equal(nullProject.isError, true, 'projectId null must be rejected');
  assert.match(errorText(nullProject), /^Invalid input: projectId must be a project UUID/);
  dashboardChecks.push('dashboard-validate', 'dashboard-invalid-spec-422', 'dashboard-not-found-404', 'dashboard-input-bounds', 'dashboard-company-override', 'dashboard-null-project-rejected');
  // Roadmap tools. Nothing is created: every bad input below is rejected by the bridge before any HTTP call,
  // and each one is also invalid for Paperclip itself (bad status or level, no fields, unknown ids), so even
  // a validation regression could not store a project or a goal.
  stage = 'roadmap';
  const roadmapChecks = [];
  const goalProbe = randomUUID();
  const badInputs = [
    ['paperclipCreateProject', {}],
    ['paperclipCreateProject', { name: 'mcp-bridge-smoke', status: 'bogus' }],
    ['paperclipCreateProject', { name: 'mcp-bridge-smoke', status: 'bogus', companyId: randomUUID() }],
    ['paperclipCreateProject', { name: 'mcp-bridge-smoke', status: 'bogus', env: { SMOKE: 'x' } }],
    ['paperclipUpdateProject', { projectId: randomUUID() }],
    ['paperclipCreateGoal', { title: 'mcp-bridge-smoke', level: 'galaxy' }],
    ['paperclipUpdateGoal', { goalId: goalProbe, parentId: goalProbe }],
    ['paperclipMoveDashboard', { slug: 'Not A Slug', projectId: randomUUID() }],
  ];
  for (const [name, args] of badInputs) {
    const rejected = await call(name, args);
    assert.equal(rejected.isError, true, `${name} must reject bad input`);
    assert.match(errorText(rejected), /^Invalid input: /, `${name} must reject bad input in the bridge`);
  }
  // Unknown ids: the bridge reads the resource first and stops there, so nothing can be written.
  const missingProject = await call('paperclipUpdateProject', { projectId: randomUUID(), name: 'mcp-bridge-smoke' });
  assert.equal(missingProject.isError, true);
  assert.match(errorText(missingProject), /^Not found: project [0-9a-f-]{36} does not exist in the configured Paperclip company\. Nothing was written\.$/);
  const missingGoal = await call('paperclipUpdateGoal', { goalId: randomUUID(), title: 'mcp-bridge-smoke' });
  assert.equal(missingGoal.isError, true);
  assert.match(errorText(missingGoal), /^Not found: goal [0-9a-f-]{36} does not exist in the configured Paperclip company\. Nothing was written\.$/);
  // Moving an unknown dashboard answers the plugin's own not_found (the target project is never looked at).
  const missingMove = await call('paperclipMoveDashboard', { slug: `mcp-bridge-missing-${randomUUID().slice(0, 8)}`, projectId: randomUUID() });
  assert.equal(missingMove.isError, true);
  assert.match(errorText(missingMove), /HTTP 404\): not_found/);
  roadmapChecks.push('roadmap-input-bounds', 'roadmap-update-project-not-found', 'roadmap-update-goal-not-found', 'roadmap-move-dashboard-not-found');
  // Changelog reads only. The input checks below are rejected by the bridge itself, before any HTTP call.
  stage = 'changelog';
  const changelog = dashboardData(await call('paperclipListChangelog', { limit: 5 }), 'list changelog');
  assert(Array.isArray(changelog.entries), 'Changelog entries must be an array');
  assert(changelog.nextCursor === null || typeof changelog.nextCursor === 'string', 'Changelog cursor must be a string or null');
  if (changelogProject) {
    const scoped = dashboardData(await call('paperclipListChangelog', { projectId: changelogProject, includeIssues: false, limit: 5 }), 'list project changelog');
    assert(scoped.entries.every((entry) => entry.projectId === changelogProject && entry.kind !== 'issue'), 'Project changelog must be filtered');
    dashboardChecks.push('changelog-project-filter');
  }
  assert.equal((await call('paperclipListChangelog', { limit: 0 })).isError, true);
  assert.equal((await call('paperclipListChangelog', { companyId: randomUUID() })).isError, true);
  assert.equal((await call('paperclipAddChangelogEntry', { projectId: randomUUID(), kind: 'issue', title: 'smoke' })).isError, true, 'The issue kind must be rejected');
  assert.equal((await call('paperclipUpdateChangelogEntry', { entryId: randomUUID() })).isError, true, 'An update needs at least one field');
  dashboardChecks.push('changelog-list', 'changelog-input-bounds');
  if (env.SMOKE_DASHBOARD_WRITE === '1') {
    // Opt-in WRITE mode: upserts the smoke dashboard and refreshes its dataset. An existing dashboard is
    // upserted without projectId, so it keeps its project (or stays projectless); a new one is created in
    // SMOKE_DASHBOARD_PROJECT_ID.
    // There is no delete tool; remove the dashboard from the board UI if unwanted.
    stage = 'dashboards-write';
    const probe = await call('paperclipGetDashboard', { slug: DASHBOARD_SMOKE_SLUG });
    let existing = null;
    if (probe.isError === true) {
      assert.match(errorText(probe), /HTTP 404\): not_found/, 'Reading the smoke dashboard failed');
    } else {
      existing = dashboardData(probe, 'read smoke dashboard').dashboard;
    }
    if (!existing && !dashboardProject) {
      throw new SmokeConfigError(`Dashboard "${DASHBOARD_SMOKE_SLUG}" does not exist yet, so SMOKE_DASHBOARD_PROJECT_ID (the UUID of a project in the configured company) is required to create it: every new dashboard belongs to a project. Nothing was written.`);
    }
    const created = dashboardData(await call('paperclipUpsertDashboard', {
      slug: DASHBOARD_SMOKE_SLUG, title: 'MCP bridge smoke test', ...(existing ? {} : { projectId: dashboardProject }), spec: smokeSpec([{ name: 'check', value: 1 }]),
    }), 'upsert dashboard');
    assert.equal(created.created, !existing);
    assert.equal(created.dashboard.slug, DASHBOARD_SMOKE_SLUG);
    assert.equal(
      created.dashboard.projectId,
      existing ? existing.projectId : dashboardProject,
      existing ? 'An existing smoke dashboard must keep its project' : 'The new smoke dashboard must belong to the configured project',
    );
    const value = Date.now();
    const refreshed = dashboardData(await call('paperclipUpdateDashboardDataset', {
      slug: DASHBOARD_SMOKE_SLUG, datasetId: 'smoke', rows: [{ name: 'check', value }], updatedAt: new Date().toISOString(),
    }), 'update dataset');
    assert.equal(refreshed.dataset.id, 'smoke');
    assert.equal(refreshed.dataset.rows, 1);
    assert(refreshed.dashboard.revision > created.dashboard.revision, 'Dataset update must bump the revision');
    const stored = dashboardData(await call('paperclipGetDashboard', { slug: DASHBOARD_SMOKE_SLUG }), 'read back dashboard').dashboard;
    assert.deepEqual(stored.spec.datasets.smoke.rows, [{ name: 'check', value }]);
    const after = dashboardData(await call('paperclipDashboardStatus', { slug: DASHBOARD_SMOKE_SLUG }), 'dashboard status after write').status;
    assert.equal(after.datasets.find((dataset) => dataset.id === 'smoke')?.stale, false);
    dashboardChecks.push(existing ? 'dashboard-updated-in-place' : 'dashboard-created-in-project', 'dashboard-upsert', 'dashboard-dataset-update', 'dashboard-read-back');
    if (changelogProject) {
      // Adding an entry is not idempotent: each run leaves one "note" in the project changelog.
      // There is no delete tool; remove it from the board UI if unwanted. Import is never exercised here.
      stage = 'changelog-write';
      const marker = `MCP bridge smoke test ${new Date().toISOString()}`;
      const added = dashboardData(await call('paperclipAddChangelogEntry', {
        projectId: changelogProject, kind: 'note', title: marker, body: 'Written by the `plugin-mcp-bridge` smoke test; safe to ignore.',
      }), 'add changelog entry').entry;
      assert.equal(added.title, marker);
      assert.equal(added.kind, 'note');
      assert.equal(added.projectId, changelogProject);
      const edited = dashboardData(await call('paperclipUpdateChangelogEntry', { entryId: added.id, version: 'smoke', body: null }), 'update changelog entry').entry;
      assert.equal(edited.id, added.id);
      assert.equal(edited.version, 'smoke');
      assert.equal(edited.body, null);
      const found = dashboardData(await call('paperclipListChangelog', { projectId: changelogProject, kinds: ['note'], limit: 20 }), 'read back changelog').entries
        .find((entry) => entry.id === added.id);
      assert(found, 'The new entry must be listed');
      assert.equal(found.version, 'smoke');
      dashboardChecks.push('changelog-add', 'changelog-update', 'changelog-read-back');
    }
  }
  assert.equal(listChangedNotifications, 1, 'tools/list_changed must be sent exactly once');
  console.log(JSON.stringify({
    ok: true, toolsTotal: catalog.tools.length, addedTools: added.length + dashboardTools.length + roadmapTools.length,
    dashboards: listed.dashboards.length, changelogEntriesSeen: changelog.entries.length, dashboardWrites: env.SMOKE_DASHBOARD_WRITE === '1',
    agents: overview.agents.length, runs: overview.summary?.runsTotal,
    failuresReturned: failures.failures?.length ?? failures.items?.length,
    anomaliesReturned: anomalies.anomalies?.length ?? anomalies.items?.length,
    traceEvents, checks: ['official-server', 'tools-list-changed', ...added, 'input-bounds', 'company-override', 'unknown-agent', ...dashboardChecks, ...roadmapChecks],
  }));
  }
  }
} catch (error) {
  const mode = env.SMOKE_DASHBOARD_WRITE === '1' ? 'MCP smoke (dashboard and changelog write mode)' : 'Read-only MCP smoke';
  console.error(JSON.stringify({
    ok: false, stage,
    error: error instanceof SmokeConfigError ? error.message : `${mode} failed; no credentials or response bodies logged.`,
  }));
  process.exitCode = 1;
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  pending.clear();
  lines.close();
  child.stdin.end();
  child.kill('SIGTERM');
}
