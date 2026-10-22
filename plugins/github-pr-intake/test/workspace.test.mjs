import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceClient } from "../src/workspace.js";
import { validateConfig } from "../src/config.js";
import { APP_KEY_REF, WORKSPACE_SERVICE, fixture, rawPull, repoConfig } from "./helpers.mjs";

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const APP = { appId: "5412678", privateKeyRef: APP_KEY_REF };
const ROOT = "/paperclip/review-worktrees/wallynm__tesselapp";

function fakeWorkspaces({ fail = false } = {}) {
  const service = { submitted: [] };
  service.client = {
    async submit(config, payload) {
      if (fail) throw new Error("service unavailable");
      service.submitted.push({ config, payload });
      const path = `${ROOT}/${payload.number}-${payload.head_sha.slice(0, 12)}`;
      return { path, marker: `${path}.ready`, status: "preparing" };
    },
  };
  return service;
}

function workspaceFixture({ fail = false, worktree = true } = {}) {
  const service = fakeWorkspaces({ fail });
  const minted = [];
  const appTokens = { tokenFor: async (args) => { minted.push(args); return `app-token-${args.permissions ? "read" : "full"}`; } };
  const f = fixture({
    config: { githubApp: APP, workspaceService: WORKSPACE_SERVICE, repositories: [repoConfig({ worktree })] },
    appTokens,
    workspaces: service.client,
  });
  return { f, service, minted };
}

test("the review issue points at a worktree of the PR at its head, requested with a read-only token", async () => {
  const { f, service } = workspaceFixture();
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  assert.equal(service.submitted.length, 1);
  const { config, payload } = service.submitted[0];
  assert.deepEqual(config, { url: "http://review-workspaces:8080", token: "workspace-service-token" });
  assert.deepEqual(payload, { repo: "wallynm/tesselapp", number: 5, head_sha: SHA1, token: "app-token-read" });
  const body = f.issues[0].description;
  assert.match(body, /## Code at the head commit/);
  assert.ok(body.includes(`${ROOT}/5-111111111111`));
  assert.ok(body.includes(`[ -f "${ROOT}/5-111111111111.ready" ]`));
});

test("a new head gets its own worktree in the new-head comment", async () => {
  const { f, service } = workspaceFixture();
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  await f.open(rawPull({ number: 5, sha: SHA2 }), "synchronize");
  f.advance(120_000);
  await f.engine.processDue();
  assert.equal(service.submitted.length, 2);
  const comment = f.comments.find((c) => c.body.startsWith("New commits were pushed"));
  assert.ok(comment.body.includes(`${ROOT}/5-222222222222`));
});

test("a failed worktree request never stops the review; the package says to review from the diff", async () => {
  const { f } = workspaceFixture({ fail: true });
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  assert.equal(f.issues.length, 1);
  assert.match(f.issues[0].description, /No worktree could be prepared for this head/);
  assert.ok(f.logs.some(([level, msg]) => level === "warn" && msg.includes("worktree request failed")));
});

test("repositories without worktree get no section and no request", async () => {
  const { f, service } = workspaceFixture({ worktree: false });
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  assert.equal(service.submitted.length, 0);
  assert.doesNotMatch(f.issues[0].description, /Code at the head commit/);
});

test("the client refuses paths that could break out of the shell snippet", async () => {
  const answers = [
    { path: '/x"; rm -rf /; "', marker: "/x.ready" },
    { path: "/paperclip/../etc", marker: "/paperclip/../etc.ready" },
    { path: "relative/path", marker: "relative/path.ready" },
  ];
  for (const answer of answers) {
    const ctx = { http: { fetch: async () => new Response(JSON.stringify({ ...answer, status: "preparing" }), { status: 202 }) } };
    await assert.rejects(createWorkspaceClient(ctx).submit({ url: "http://s", token: "t" }, {}), /unexpected path/, answer.path);
  }
  const ok = { http: { fetch: async () => new Response(JSON.stringify({ path: `${ROOT}/5-1`, marker: `${ROOT}/5-1.ready`, status: "ready" }), { status: 202 }) } };
  assert.equal((await createWorkspaceClient(ok).submit({ url: "http://s", token: "t" }, {})).status, "ready");
});

test("config: worktree needs the company-wide workspace service", () => {
  const { errors } = validateConfig({ repositories: [repoConfig({ worktree: true })] });
  assert.ok(errors.some((e) => e.includes("worktree needs the company-wide workspaceService")));
  assert.ok(validateConfig({ workspaceService: { url: "ftp://x", tokenRef: APP_KEY_REF } }).errors.some((e) => e.includes("workspaceService needs")));
  assert.ok(validateConfig({ repositories: [repoConfig({ worktree: "yes" })] }).errors.some((e) => e.includes("worktree must be a boolean")));
});
