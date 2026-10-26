import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeRunConnectionsConfig, localConnectionsCommand, RUN_CONNECTIONS_NAME } from '../src/run-connections-config.mjs';
import { installRunConnections } from '../scripts/install-run-connections.mjs';
import { agentKey, completedEnvelope, connectionsEnv, createGateway, descriptor, json, makeConnections, toolText } from './gateway-helpers.mjs';

const options = { serverPath: '/opt/paperclip-bridge/src/connections-server.mjs', nodePath: '/usr/local/bin/node' };

test('AGY and OpenCode registrations preserve existing servers, permissions and providers without storing run identity', () => {
  for (const client of ['agy', 'opencode']) {
    const key = client === 'agy' ? 'mcpServers' : 'mcp';
    const existing = { provider: { existing: { baseURL: 'https://models.example' } }, permission: { edit: 'ask' }, [key]: { original: { command: ['keep-me'] } } };
    const before = JSON.stringify(existing);
    const merged = mergeRunConnectionsConfig(existing, { ...options, client });
    assert.equal(merged.changed, true);
    assert.deepEqual(merged.config[key].original, existing[key].original);
    assert.deepEqual(merged.config.provider, existing.provider);
    assert.deepEqual(merged.config.permission, existing.permission);
    assert.equal(JSON.stringify(existing), before, 'caller config is not mutated');
    const registration = merged.config[key][RUN_CONNECTIONS_NAME];
    assert.equal(registration.env, undefined); assert.equal(registration.headers, undefined);
    assert.doesNotMatch(JSON.stringify(registration), /PAPERCLIP_(?:API_KEY|AGENT_ID|COMPANY_ID|RUN_ID)|Bearer|token|companyId|runId/i);
    assert.equal(mergeRunConnectionsConfig(merged.config, { ...options, client }).changed, false);
  }
});

test('installer refuses collisions and identity-bearing registrations instead of overwriting them', () => {
  for (const entry of [{ command: 'other', args: [] }, { command: options.nodePath, args: [options.serverPath], disabled: false, env: { PAPERCLIP_API_KEY: 'fixed-secret' } }]) {
    assert.throws(() => mergeRunConnectionsConfig({ mcpServers: { [RUN_CONNECTIONS_NAME]: entry } }, { ...options, client: 'agy' }), /MCP_SERVER_NAME_ALREADY_IN_USE/);
  }
  assert.throws(() => mergeRunConnectionsConfig({ mcp: [] }, { ...options, client: 'opencode' }), /MCP_SERVER_MAP_INVALID/);
});

test('filesystem install supports dry-run, atomic merge, original backup, idempotency and config symlinks', async (suite) => {
  const directory = await mkdtemp(join(tmpdir(), 'paperclip-mcp-install-'));
  suite.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'connections-server.mjs'); await writeFile(script, '// fixture\n');
  const target = join(directory, 'config.json'); const original = '{"mcpServers":{"existing":{"command":"keep"}},"theme":"dark"}\n';
  await writeFile(target, original);
  const configPath = join(directory, 'linked-config.json'); await symlink(target, configPath);
  const args = { client: 'agy', configPath, serverPath: script };
  const preview = await installRunConnections({ ...args, dryRun: true });
  assert.equal(preview.changed, true); assert.equal(await readFile(target, 'utf8'), original);
  const first = await installRunConnections(args); const installed = await readFile(target, 'utf8');
  assert.equal(first.changed, true); assert.equal(await readFile(first.backupPath, 'utf8'), original);
  assert.equal(JSON.parse(installed).theme, 'dark'); assert.equal(JSON.parse(installed).mcpServers.existing.command, 'keep');
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.equal((await installRunConnections(args)).changed, false);
  assert.equal(await readFile(first.backupPath, 'utf8'), original);
  assert.equal(await readFile(configPath, 'utf8'), installed);
});

test('invalid existing JSON fails safely and is not replaced', async (suite) => {
  const directory = await mkdtemp(join(tmpdir(), 'paperclip-mcp-invalid-'));
  suite.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'connections-server.mjs'); await writeFile(script, '// fixture\n');
  const target = join(directory, 'config.json'); await writeFile(target, 'invalid confidential config');
  await assert.rejects(installRunConnections({ client: 'agy', configPath: target, serverPath: script }), /MCP_CONFIGURATION_REQUIRES_VALID_JSON/);
  assert.equal(await readFile(target, 'utf8'), 'invalid confidential config');
});

test('an agent MCP client discovers native Social Publisher tools and invokes them only through its JWT-bound gateway session', async () => {
  const name = 'journey-studios.social-publisher:social.accounts.list';
  const gateway = createGateway({ tools: [descriptor(name, { providerType: 'paperclip_plugin', parametersSchema: { type: 'object', properties: {}, additionalProperties: false }, connectionId: undefined, pluginId: 'social-plugin' })] });
  gateway.handlers.call = (request) => json(200, completedEnvelope(name, { content: JSON.stringify({ accounts: [], connectivity: ['NOT_CONNECTED'] }) }));
  const ctx = makeConnections({ gateway, env: { ...connectionsEnv, PAPERCLIP_AGENT_ID: 'forged-agent', PAPERCLIP_COMPANY_ID: 'forged-company', PAPERCLIP_RUN_ID: 'forged-run' } });
  await ctx.initialize();
  const listed = await ctx.request('tools/list');
  assert.equal(listed.result.tools.length, 1);
  assert.equal(listed.result.tools[0].name, 'journey-studios_social-publisher_social_accounts_list');
  const result = await ctx.request('tools/call', { name: listed.result.tools[0].name, arguments: {} });
  assert.equal(JSON.parse(toolText(result.result)).accounts.length, 0);
  const create = gateway.ofKind('create')[0];
  assert.equal(create.headers.authorization, `Bearer ${agentKey}`);
  assert.deepEqual(create.body, { ttlMs: 3_600_000 });
  const call = gateway.ofKind('call')[0];
  assert.deepEqual(call.body, { tool: name, parameters: {}, timeoutMs: 55_000 });
  assert.equal(call.headers.authorization, undefined);
  assert.equal(gateway.tokenOf(call), 'gw-token-1');
  assert.doesNotMatch(ctx.everything(), /forged-agent|forged-company|forged-run|agent-jwt-SECRET-key-value|gw-token-1/);
  await ctx.server.shutdown();
});


test('OpenCode keeps an existing JSON-compatible jsonc config instead of creating a shadowing json', async (suite) => {
  const directory = await mkdtemp(join(tmpdir(), 'paperclip-mcp-jsonc-'));
  suite.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'connections-server.mjs'); await writeFile(script, '// fixture\n');
  const configPath = join(directory, 'opencode.json');
  const jsoncPath = `${configPath}c`;
  await writeFile(jsoncPath, JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { original: { type: 'remote', url: 'https://original.example/mcp', enabled: true } } }));
  const result = await installRunConnections({ client: 'opencode', configPath, serverPath: script });
  assert.equal(result.configPath, jsoncPath);
  await assert.rejects(stat(configPath), { code: 'ENOENT' });
  const installed = JSON.parse(await readFile(jsoncPath, 'utf8'));
  assert.equal(installed.mcp.original.url, 'https://original.example/mcp');
  assert.equal(installed.mcp[RUN_CONNECTIONS_NAME].enabled, true);
});


test('a shared config in an SSH runner without the app source remains a valid empty MCP server', async () => {
  const command = localConnectionsCommand('/missing-paperclip-app-source/connections-server.mjs', process.execPath);
  const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }), JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'not-installed', arguments: {} } })].join('\n') + '\n');
  const exitCode = await new Promise((accept, reject) => { child.on('error', reject); child.on('exit', accept); });
  assert.equal(exitCode, 0); assert.equal(stderr, '');
  const replies = stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(replies[0].result.serverInfo.name, 'paperclip-run-connections-unavailable');
  assert.deepEqual(replies[1].result, { tools: [] });
  assert.equal(replies[2].result.isError, true);
});
