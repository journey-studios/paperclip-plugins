import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { plugin } from "../src/worker.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const REVIEWER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const SECRET_ID = "44444444-4444-4444-8444-444444444444";
const WEBHOOK_SECRET = "example-webhook-secret-that-is-long-enough";
const SHA = "a".repeat(40);
const DELIVERY = "55555555-5555-4555-8555-555555555555";
const fullName = "wallynm/tesselapp";

const config = {
  enabled: true,
  reviewerAgentId: REVIEWER,
  githubWebhookSecretRef: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
  repositories: [{ fullName, projectId: PROJECT }],
};

function event(repo = fullName) {
  return {
    action: "opened",
    number: 373,
    repository: { full_name: repo },
    pull_request: {
      title: "Implement price controls",
      html_url: `https://github.com/${repo}/pull/373`,
      head: { sha: SHA },
      base: { ref: "main" },
      user: { login: "dev" },
      state: "open",
      draft: false,
      updated_at: "2026-10-20T12:00:00Z",
    },
  };
}

function signed(payload, secret = WEBHOOK_SECRET) {
  const rawBody = JSON.stringify(payload);
  return {
    endpointKey: "github",
    rawBody,
    requestId: DELIVERY,
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": DELIVERY,
      "x-hub-signature-256":
        "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex"),
    },
  };
}

function fakeContext() {
  const calls = [];
  const handlers = new Map();
  const jobs = new Map();
  return {
    calls,
    handlers,
    jobs,
    ctx: {
      db: {
        namespace: "plugin_pr_review_orchestrator_167e9509eb",
        async execute(sql, args) {
          calls.push({ kind: "sql-write", sql, args });
          return { rowCount: 1 };
        },
        async query(sql, args) {
          calls.push({ kind: "sql-read", sql, args });
          return [];
        },
      },
      events: {
        on(name, handler) { handlers.set(name, handler); },
      },
      jobs: {
        register(name, handler) { jobs.set(name, handler); },
      },
      secrets: {
        async resolve(ref, opts) {
          calls.push({ kind: "resolve-secret", ref, opts });
          return WEBHOOK_SECRET;
        },
      },
      logger: { info() {}, warn() {}, error() {} },
    },
  };
}

test("plugin registers expected event and recovery triggers", async () => {
  const h = fakeContext();
  await plugin.setup(h.ctx);
  assert.ok(h.handlers.has("agent.run.finished"));
  assert.ok(h.handlers.has("agent.run.failed"));
  assert.ok(h.handlers.has("agent.run.cancelled"));
  assert.ok(h.handlers.has("issue.updated"));
  assert.ok(h.jobs.has("reconcile"));
});

test("unverified or unauthorized GitHub payload never touches the queue", async () => {
  const h = fakeContext();
  await plugin.setup(h.ctx);
  await plugin.onConfigChanged(config, { companyId: COMPANY });
  await assert.rejects(
    plugin.onWebhook(signed(event(), "a-wrong-secret-for-testing-only")),
    /signature/,
  );
  assert.equal(h.calls.some((c) => c.kind === "sql-write"), false);
  const foreign = signed(event("attacker/repo"));
  await assert.rejects(plugin.onWebhook(foreign), /not mapped/);
  assert.equal(h.calls.filter((c) => c.kind === "resolve-secret").length, 1);
  assert.equal(h.calls.some((c) => c.kind === "sql-write"), false);
});

test("valid signed event is routed to a single configured company", async () => {
  const h = fakeContext();
  await plugin.setup(h.ctx);
  await plugin.onConfigChanged(config, { companyId: COMPANY });
  await plugin.onWebhook(signed(event()));
  const writes = h.calls.filter((c) => c.kind === "sql-write");
  assert.ok(writes.length >= 2);
  assert.ok(writes.every((c) => c.args[0] === COMPANY || c.args[1] === COMPANY));
  const secret = h.calls.find((c) => c.kind === "resolve-secret");
  assert.equal(secret.opts.companyId, COMPANY);
  assert.equal(secret.opts.configPath, "githubWebhookSecretRef");
  assert.equal(secret.ref.secretId, SECRET_ID);
});

test("disabled routing does not accept signed webhooks", async () => {
  const h = fakeContext();
  await plugin.setup(h.ctx);
  await plugin.onConfigChanged({ ...config, enabled: false }, { companyId: COMPANY });
  await assert.rejects(plugin.onWebhook(signed(event())), /not mapped/);
  assert.equal(h.calls.length, 0);
});
