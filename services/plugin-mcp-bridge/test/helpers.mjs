import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DASHBOARD_TOOLS, McpBridge, OBSERVATORY_TOOLS, ROADMAP_TOOLS } from '../src/bridge.mjs';

export const companyId = 'd9f67265-9c8f-4cbe-b91c-b3e0ea26da02';
export const agentId = '7067603c-5ee4-4db8-87f1-8c16a54f44a2';
export const runId = '150c11ef-4863-4a50-b4a3-95c1bf2b6224';
export const env = {
  PAPERCLIP_API_URL: 'https://paperclip.test',
  PAPERCLIP_API_KEY: 'secret-test-value',
  PAPERCLIP_COMPANY_ID: companyId,
};

function fakeChild({ stockCallResult, stockTools, initializeResult, initializeError } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.received = [];
  child.stdin.on('data', (buf) => {
    const message = JSON.parse(buf.toString());
    child.received.push(message);
    if (message.method === 'tools/call' && stockCallResult !== undefined) {
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: stockCallResult })}\n`);
    }
    if (message.method === 'initialize') {
      const answer = initializeError
        ? { jsonrpc: '2.0', id: message.id, error: initializeError }
        : { jsonrpc: '2.0', id: message.id, result: initializeResult ?? { protocolVersion: '2025-03-26', capabilities: { tools: {} } } };
      child.stdout.write(`${JSON.stringify(answer)}\n`);
    }
    if (message.method === 'tools/list') {
      const collisions = { collision: OBSERVATORY_TOOLS[0], 'collision-dashboards': DASHBOARD_TOOLS[0], 'collision-roadmap': ROADMAP_TOOLS.at(-1) };
      const collision = collisions[message.params?.cursor];
      const tools = collision ? [{ name: collision.name }] : (stockTools ?? [{ name: 'existingTool' }]);
      const nextCursor = message.params?.cursor ? 'stock-next-2' : 'stock-next-1';
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools, nextCursor } })}\n`);
    }
    if (message.method === 'ping') child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { pong: true } })}\n`);
  });
  return child;
}

export function makeBridge({ fetchImpl = async () => new Response('{}'), bridgeEnv = env, stockCallResult, stockTools, initializeResult, initializeError } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let child;
  const bridge = new McpBridge({
    env: bridgeEnv,
    spawn: (...args) => { child = fakeChild({ stockCallResult, stockTools, initializeResult, initializeError }); child.spawnArgs = args; return child; },
    fetchImpl,
    stdin,
    stdout,
    stderr,
  });
  const output = [];
  const errors = [];
  stdout.on('data', (chunk) => output.push(chunk.toString()));
  stderr.on('data', (chunk) => errors.push(chunk.toString()));
  return { bridge, stdin, stdout, stderr, child: () => child, output, errors };
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));
export const messages = (items) => items.join('').trim().split('\n').filter(Boolean).map(JSON.parse);

