import { access, chmod, copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergeRunConnectionsConfig } from '../src/run-connections-config.mjs';

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

export async function installRunConnections({ client, configPath, serverPath, nodePath = process.execPath, dryRun = false }) {
  if (!isAbsolute(configPath) || !isAbsolute(serverPath) || !isAbsolute(nodePath)) throw new Error('MCP_INSTALL_ABSOLUTE_PATHS_REQUIRED');
  const server = await realpath(serverPath);
  const executable = await realpath(nodePath);
  await access(executable, constants.X_OK);
  let selectedConfigPath = configPath;
  if (client === 'opencode' && configPath.endsWith('.json')) {
    try { await stat(configPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await stat(`${configPath}c`); selectedConfigPath = `${configPath}c`; }
      catch (alternateError) { if (alternateError.code !== 'ENOENT') throw alternateError; }
    }
  }
  let target = selectedConfigPath;
  let before = null;
  try {
    target = await realpath(selectedConfigPath);
    if ((await stat(target)).size > MAX_CONFIG_BYTES) throw new Error('MCP_CONFIGURATION_TOO_LARGE');
    before = await readFile(target, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let existing = {};
  if (before !== null) {
    try { existing = JSON.parse(before); }
    catch { throw new Error('MCP_CONFIGURATION_REQUIRES_VALID_JSON'); }
  }
  const result = mergeRunConnectionsConfig(existing, { client, serverPath: server, nodePath: executable });
  const summary = { client, configPath: target, serverPath: server, serverName: result.serverName, serverCount: result.serverCount, changed: result.changed, dryRun };
  if (!result.changed || dryRun) return summary;
  const backupPath = before === null ? null : `${target}.before-paperclip-run-connections`;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (before !== null) {
    const current = await readFile(target, 'utf8');
    if (current !== before) throw new Error('MCP_CONFIGURATION_CHANGED_DURING_INSTALL');
    try { await copyFile(target, backupPath, constants.COPYFILE_EXCL); await chmod(backupPath, 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const temporary = `${target}.paperclip-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(result.config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
  return { ...summary, backupPath };
}

function optionsOf(args) {
  const result = {};
  const fields = new Map([['--client', 'client'], ['--config', 'configPath'], ['--server', 'serverPath'], ['--node', 'nodePath']]);
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--dry-run') { result.dryRun = true; continue; }
    if (!fields.has(key) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('MCP_INSTALL_ARGUMENTS_INVALID');
    const field = fields.get(key);
    if (Object.hasOwn(result, field)) throw new Error('MCP_INSTALL_ARGUMENTS_INVALID');
    result[field] = args[++index];
  }
  if (!result.client || !result.configPath || !result.serverPath) throw new Error('MCP_INSTALL_ARGUMENTS_INVALID');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await installRunConnections(optionsOf(process.argv.slice(2))))}\n`); }
  catch (error) {
    const code = /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'MCP_INSTALL_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
