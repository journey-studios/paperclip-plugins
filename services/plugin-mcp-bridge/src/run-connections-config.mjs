import { basename, isAbsolute } from 'node:path';

export const RUN_CONNECTIONS_NAME = 'paperclip-run-connections';

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const EMPTY_MCP = `const readline=require('node:readline');const send=(v)=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',(line)=>{if(line.length>1048576)return;let m;try{m=JSON.parse(line)}catch{return}if(!m||m.jsonrpc!=='2.0'||!Object.hasOwn(m,'id'))return;const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'paperclip-run-connections-unavailable',version:'1'}}:m.method==='tools/list'?{tools:[]}:m.method==='ping'?{}:m.method==='tools/call'?{isError:true,content:[{type:'text',text:'Paperclip native tools are unavailable in this execution environment.'}]}:null;if(result!==null)send({jsonrpc:'2.0',id:m.id,result});else send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}})});`;

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

// Global configs are also copied/mounted into SSH runners. A missing app-local source must
// produce an empty valid MCP server there, not a broken command or a different identity.
export function localConnectionsCommand(serverPath, nodePath) {
  const command = `if [ -f ${shellQuote(serverPath)} ] && [ -r ${shellQuote(serverPath)} ]; then exec ${shellQuote(nodePath)} ${shellQuote(serverPath)}; else exec node -e ${shellQuote(EMPTY_MCP)}; fi`;
  return ['/bin/sh', '-c', command];
}

/** Register only a command. The child inherits its active run JWT; no identity or credential is stored. */
export function mergeRunConnectionsConfig(existing, { client, serverPath, nodePath }) {
  if (!record(existing)) throw new Error('MCP_CONFIGURATION_MUST_BE_OBJECT');
  if (!['agy', 'opencode'].includes(client)) throw new Error('MCP_CLIENT_NOT_SUPPORTED');
  if (!isAbsolute(serverPath) || basename(serverPath) !== 'connections-server.mjs' || !isAbsolute(nodePath)) {
    throw new Error('MCP_ABSOLUTE_EXECUTABLE_AND_SERVER_REQUIRED');
  }
  const key = client === 'agy' ? 'mcpServers' : 'mcp';
  if (existing[key] !== undefined && !record(existing[key])) throw new Error('MCP_SERVER_MAP_INVALID');
  const servers = existing[key] ?? {};
  const command = localConnectionsCommand(serverPath, nodePath);
  const expected = client === 'agy'
    ? { command: command[0], args: command.slice(1), disabled: false }
    : { type: 'local', command, enabled: true };
  const current = servers[RUN_CONNECTIONS_NAME];
  if (current !== undefined) {
    if (!record(current)) throw new Error('MCP_SERVER_NAME_ALREADY_IN_USE');
    const owned = client === 'agy'
      ? current.command === expected.command && JSON.stringify(current.args) === JSON.stringify(expected.args)
      : current.type === 'local' && JSON.stringify(current.command) === JSON.stringify(expected.command);
    // Never overwrite another server, nor preserve a fixed credential/identity on this run-bound server.
    const allowedKeys = client === 'agy' ? ['command', 'args', 'disabled'] : ['type', 'command', 'enabled'];
    if (!owned || Object.keys(current).some((name) => !allowedKeys.includes(name))) throw new Error('MCP_SERVER_NAME_ALREADY_IN_USE');
  }
  const changed = JSON.stringify(current) !== JSON.stringify(expected);
  return {
    config: { ...existing, [key]: { ...servers, [RUN_CONNECTIONS_NAME]: expected } },
    changed,
    serverName: RUN_CONNECTIONS_NAME,
    serverCount: Object.keys(servers).length + (current === undefined ? 1 : 0),
  };
}
