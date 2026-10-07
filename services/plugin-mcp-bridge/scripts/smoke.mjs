import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';

// Read-only integration check; credentials never enter argv or test output.
const env = { ...process.env };
if (!env.PAPERCLIP_API_KEY && env.PAPERCLIP_API_KEY_FILE) {
  env.PAPERCLIP_API_KEY = readFileSync(env.PAPERCLIP_API_KEY_FILE, 'utf8').trim();
}
const child = spawn(process.execPath, [fileURLToPath(new URL('../src/bridge.mjs', import.meta.url))], {
  env, stdio: ['pipe', 'pipe', 'ignore'],
});
const pending = new Map();
let seq = 0;
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
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
try {
  await request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'observatory-readonly-smoke', version: '0.1.0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const catalog = await request('tools/list', {});
  const names = new Set(catalog.tools.map((tool) => tool.name));
  const added = ['paperclipAgentHealthOverview', 'paperclipDiagnoseAgent', 'paperclipListRunFailures', 'paperclipFindAgentAnomalies', 'paperclipTraceRun'];
  for (const name of added) assert(names.has(name), `Missing tool: ${name}`);
  assert.equal(names.size, catalog.tools.length, 'Tool names must be unique');
  const stock = await call('paperclipListAgents', { companyId: env.PAPERCLIP_COMPANY_ID });
  assert.notEqual(stock.isError, true, 'Official MCP tool failed');
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
  console.log(JSON.stringify({
    ok: true, toolsTotal: catalog.tools.length, addedTools: added.length,
    agents: overview.agents.length, runs: overview.summary?.runsTotal,
    failuresReturned: failures.failures?.length ?? failures.items?.length,
    anomaliesReturned: anomalies.anomalies?.length ?? anomalies.items?.length,
    traceEvents, checks: ['official-server', ...added, 'input-bounds', 'company-override', 'unknown-agent'],
  }));
} catch {
  console.error('Observatory live smoke failed; check the plugin and MCP bridge configuration.');
  process.exitCode = 1;
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  pending.clear();
  lines.close();
  child.stdin.end();
  child.kill('SIGTERM');
}
