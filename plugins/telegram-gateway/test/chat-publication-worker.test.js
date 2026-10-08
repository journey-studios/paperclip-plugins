import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(here, "../dist/worker.js");

function startWorker({ ledger = { attempts: 5, terminal: true, lastFailure: "publication_attempt_failed" }, published = [], bridgeError = null, bridgeState = "published", publicationEnabled = true } = {}) {
  const child = spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "pipe"] });
  const state = new Map();
  state.set(JSON.stringify({ scopeKind: "company", scopeId: "company-a", stateKey: "human-decision-publication:comment-1" }), ledger);
  state.set(JSON.stringify({ scopeKind: "company", scopeId: "company-a", stateKey: "published-comment-ids" }), published);
  const outbound = [];
  const observed = [];
  const waiters = [];
  const stderr = [];
  child.stderr.setEncoding("utf8").on("data", (chunk) => stderr.push(chunk));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    observed.push(message);
    const readyIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (readyIndex >= 0) waiters.splice(readyIndex, 1)[0].resolve(message);
    if (message.method) {
      outbound.push(message);
      if (message.id !== undefined) {
        const method = message.method;
        let result = null;
        if (method === "state.get") {
          const key = message.params;
          result = state.get(JSON.stringify(key)) ?? null;
        } else if (method === "state.set") {
          const { value, ...key } = message.params;
          state.set(JSON.stringify(key), value);
        } else if (method === "state.delete") {
          state.delete(JSON.stringify(message.params));
        } else if (method === "config.get") {
          result = { founderUserId: "founder", liaisonAgentId: "liaison", publicationEnabled };
        } else if (method === "chat.publishComment") {
          if (bridgeError) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: bridgeError } })}\n`);
          else result = { id: "publication-1", companyId: "company-a", state: bridgeState };
        }
        if (!bridgeError || method !== "chat.publishComment") {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
        }
      }
    }
  });
  function waitFor(predicate) {
    const found = observed.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolveWait, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for worker RPC; stderr=${stderr.join("")}`)), 3000);
      waiters.push({ predicate, resolve: (value) => { clearTimeout(timer); resolveWait(value); } });
    });
  }
  function request(id, method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  }
  async function close() {
    child.stdin.end();
    await new Promise((resolveClose) => child.once("exit", resolveClose));
  }
  return { child, state, outbound, observed, waitFor, request, close };
}

async function initializedHarness(options = {}) {
  const harness = startWorker(options);
  harness.request("init-response", "initialize", {
    manifest: {
      id: "journey-studios.founder-comms-router", apiVersion: 1, version: "0.3.5",
      capabilities: options.capabilities ?? ["chat.publications.publish_existing_comment"],
    },
    config: {},
  });
  const init = await harness.waitFor((message) => message.id === "init-response");
  assert.ok(init.result && !init.error, "worker initialization succeeds with the chat capability");
  const next = await harness.waitFor((message) => message.method === "state.get" && message.params?.stateKey === "known-companies");
  assert.ok(next);
  return harness;
}

async function invokeAction(options = {}, { caller = { type: "user", userId: "founder", companyId: "company-a" }, companyId = "company-a" } = {}) {
  const h = await initializedHarness(options);
  try {
    h.request("action-response", "performAction", {
      key: "retry-terminal-human-decision-publication",
      companyId,
      params: { commentId: "comment-1", companyId },
      actorContext: caller,
    });
    const response = await h.waitFor((message) => message.id === "action-response");
    const ledgerKey = JSON.stringify({ scopeKind: "company", scopeId: "company-a", stateKey: "human-decision-publication:comment-1" });
    return { response, methods: h.outbound.map((message) => message.method), ledger: h.state.get(ledgerKey) };
  } finally { await h.close(); }
}

test("built worker sends scoped chat.publishComment RPC for explicit founder recovery", async () => {
  const h = await initializedHarness();
  try {
    h.request("action-response", "performAction", {
      key: "retry-terminal-human-decision-publication",
      companyId: "company-a",
      params: { commentId: "comment-1", companyId: "company-a" },
      actorContext: { type: "user", userId: "founder", companyId: "company-a" },
    });
    const bridge = await h.waitFor((message) => message.method === "chat.publishComment");
    assert.deepEqual(bridge.params, { commentId: "comment-1", companyId: "company-a" });
    const result = await h.waitFor((message) => message.id === "action-response");
    assert.equal(result.result.retried, true);
    assert.equal(JSON.stringify(result).includes("provider secret"), false);
  } finally { await h.close(); }
});

test("built worker propagates host publication errors without exposing provider text", async () => {
  const h = await initializedHarness({ bridgeError: "provider secret detail" });
  try {
    h.request("action-response", "performAction", {
      key: "retry-terminal-human-decision-publication", companyId: "company-a",
      params: { commentId: "comment-1", companyId: "company-a" },
      actorContext: { type: "user", userId: "founder", companyId: "company-a" },
    });
    const bridge = await h.waitFor((message) => message.method === "chat.publishComment");
    assert.equal(bridge.params.companyId, "company-a");
    const result = await h.waitFor((message) => message.id === "action-response");
    assert.equal(result.result.reason, "publication_attempt_failed");
    assert.equal(JSON.stringify(result).includes("provider secret detail"), false);
  } finally { await h.close(); }
});

test("recovery action rejects unauthorized, disabled, cross-company, and ineligible retries", async () => {
  const cases = [
    [{}, { caller: { type: "agent", agentId: "liaison", companyId: "company-a" } }, "Authenticated company user required"],
    [{}, { caller: { type: "user", userId: "other", companyId: "company-a" } }, "Founder access required"],
    [{}, { caller: { type: "user", userId: "founder", companyId: null } }, "Authenticated company user required"],
    [{}, { caller: { type: "user", userId: "founder", companyId: "company-a" }, companyId: "company-b" }, "Company scope mismatch"],
    [{ ledger: { attempts: 2, terminal: false, lastFailure: "publication_attempt_failed" } }, {}, "not_retryable"],
    [{ ledger: { attempts: 5, terminal: true, lastFailure: "provider_rejected" } }, {}, "not_retryable"],
    [{ publicationEnabled: false }, {}, "publication_disabled"],
    [{ published: ["comment-1"] }, {}, "already_published"],
  ];
  for (const [options, invocation, expected] of cases) {
    const { response, methods } = await invokeAction(options, invocation);
    if (response.error) assert.match(response.error.message, new RegExp(expected));
    else assert.equal(response.result.reason, expected);
    assert.equal(methods.includes("chat.publishComment"), false, `${expected} must not reach the host bridge`);
  }
});

test("failed explicit recovery remains terminal and never starts an automatic retry loop", async () => {
  const { response, methods, ledger } = await invokeAction({
    ledger: { attempts: 1, terminal: true, lastFailure: "publication_attempt_failed" },
    bridgeError: "provider secret detail",
  });
  assert.equal(response.result.reason, "publication_attempt_failed");
  assert.equal(methods.filter((method) => method === "chat.publishComment").length, 1);
  assert.equal(ledger.terminal, true);
  assert.equal(ledger.attempts, 2);
  assert.equal(JSON.stringify(response).includes("provider secret detail"), false);
});

test("built worker fails closed without manifest capability and records native rejection as terminal", async () => {
  const missingCapability = await invokeAction({ capabilities: [] });
  assert.equal(missingCapability.response.result.reason, "publication_attempt_failed");
  assert.equal(missingCapability.methods.includes("chat.publishComment"), false);

  const rejected = await invokeAction({ bridgeState: "failed" });
  assert.equal(rejected.response.result.reason, "provider_rejected");
  assert.equal(rejected.methods.filter((method) => method === "chat.publishComment").length, 1);
  assert.equal(rejected.ledger.terminal, true);
  assert.equal(rejected.ledger.lastFailure, "provider_rejected");
});
