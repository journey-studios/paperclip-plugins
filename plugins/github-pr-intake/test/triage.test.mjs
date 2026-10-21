import test from "node:test";
import assert from "node:assert/strict";
import { TRIAGE_MARKER, createTriageClient, formatTriageComment } from "../src/triage.js";
import { validateConfig, normalizeConfig } from "../src/config.js";
import { APP_KEY_REF, COMPANY, TRIAGE_SERVICE, fixture, rawPull, repoConfig } from "./helpers.mjs";

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const APP = { appId: "5412678", privateKeyRef: APP_KEY_REF };
const RESULT = {
  effort: 2,
  relevant_tests: "Yes",
  security_concerns: "No",
  key_issues: [{ file: "src/a.ts", header: "Possible null access", content: "value may be undefined", start_line: 10, end_line: 12 }],
};

/** A fake pr-triage service: records submissions and answers with whatever the test scripts. */
function fakeTriage() {
  const service = { submitted: [], answers: new Map(), failSubmit: false, nextId: 1 };
  service.client = {
    async submit(config, payload) {
      if (service.failSubmit) throw new Error("service unavailable");
      service.submitted.push({ config, payload });
      const id = `job-${service.nextId++}`;
      service.answers.set(id, { status: "running" });
      return { id, status: "queued" };
    },
    async status(_config, id) {
      return service.answers.get(id) ?? { status: "lost" };
    },
  };
  service.finishAll = (result = RESULT) => {
    for (const id of service.answers.keys()) service.answers.set(id, { status: "done", result });
  };
  return service;
}

function triageFixture(overrides = {}) {
  const service = fakeTriage();
  const minted = [];
  const appTokens = { tokenFor: async (args) => { minted.push(args); return `app-token-${args.permissions ? "read" : "full"}`; } };
  const f = fixture({
    config: { githubApp: APP, triageService: TRIAGE_SERVICE, repositories: [repoConfig({ triage: true })] },
    appTokens,
    triage: service.client,
    ...overrides,
  });
  return { f, service, minted };
}

test("triage is off unless the repository opts in", async () => {
  const service = fakeTriage();
  const f = fixture({ config: { githubApp: APP, triageService: TRIAGE_SERVICE }, appTokens: { tokenFor: async () => "t" }, triage: service.client });
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  assert.equal(service.submitted.length, 0);
  assert.equal(f.issues.length, 1, "the review issue is created as usual");
});

test("an opted-in repository submits a read-only token and posts the answer as one comment", async () => {
  const { f, service, minted } = triageFixture();
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  assert.equal(f.issues.length, 1);
  assert.equal(service.submitted.length, 1);
  const { config, payload } = service.submitted[0];
  assert.equal(config.token, "triage-service-token");
  assert.equal(config.url, "http://pr-triage:8080", "trailing slash trimmed");
  assert.deepEqual({ repo: payload.repo, number: payload.number, head_sha: payload.head_sha }, { repo: "wallynm/tesselapp", number: 5, head_sha: SHA1 });
  assert.equal(payload.token, "app-token-read", "the service only ever receives the narrow token");
  assert.ok(minted.some((m) => m.permissions && m.permissions.contents === "read" && !("pull_requests" in m.permissions && m.permissions.pull_requests === "write")));

  assert.equal((await f.engine.reconcile()).triage, 0, "still running: nothing to post yet");
  assert.equal(f.issueComments.length, 0);

  service.finishAll();
  assert.equal((await f.engine.reconcile()).triage, 1);
  assert.equal(f.issueComments.length, 1);
  assert.ok(f.issueComments[0].body.startsWith(TRIAGE_MARKER));
  assert.match(f.issueComments[0].body, /Possible null access/);
});

test("a new push updates the same comment instead of adding another", async () => {
  const { f, service } = triageFixture({});
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  service.finishAll();
  await f.engine.reconcile();
  assert.equal(f.issueComments.length, 1);

  const pushed = rawPull({ number: 5, sha: SHA2 });
  f.setPull(pushed);
  await f.engine.onPullEvent({ kind: "pull_request", deliveryId: "d-push", action: "synchronize", repo: "wallynm/tesselapp", pull: { number: 5, headSha: SHA2, state: "open", draft: false, labels: [], baseRef: "main", author: { login: "wallynm", type: "User" }, title: "t", url: "u", headRef: "x", baseSha: "b" } }, { companyId: COMPANY });
  f.advance(120_000);
  await f.engine.processDue();
  assert.equal(service.submitted.length, 2, "the new head is triaged again");
  service.finishAll({ ...RESULT, key_issues: [] });
  await f.engine.reconcile();
  assert.equal(f.issueComments.length, 1, "still a single comment");
  assert.match(f.issueComments[0].body, /No issues to flag/);
});

test("an answer about an older head is dropped", async () => {
  const { f, service } = triageFixture();
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  f.setPull(rawPull({ number: 5, sha: SHA2 })); // GitHub moved on while the service was working
  service.finishAll();
  await f.engine.reconcile();
  assert.equal(f.issueComments.length, 0);
});

test("a service outage never prevents the review issue and is retried later", async () => {
  const { f, service } = triageFixture();
  service.failSubmit = true;
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  assert.equal(f.issues.length, 1, "Thermo's review issue is unaffected");
  assert.equal(service.submitted.length, 0);

  service.failSubmit = false;
  await f.engine.reconcile();
  assert.equal(service.submitted.length, 1, "the next reconcile submits again");
  service.finishAll();
  await f.engine.reconcile();
  assert.equal(f.issueComments.length, 1);
});

test("a job the service forgot is resubmitted a bounded number of times", async () => {
  const { f, service } = triageFixture();
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  for (let i = 0; i < 6; i += 1) {
    service.answers.clear(); // the service restarted: every known job is gone
    await f.engine.reconcile();
  }
  assert.equal(service.submitted.length, 3, "three attempts, then it gives up");
  assert.equal(f.issueComments.length, 0);
});

test("a static token is refused: triage needs a token that can be narrowed to read-only", async () => {
  const service = fakeTriage();
  const f = fixture({ config: { triageService: TRIAGE_SERVICE, repositories: [repoConfig({ triage: true })] }, triage: service.client });
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  assert.equal(service.submitted.length, 0);
  assert.equal(f.issues.length, 1);
});

test("a human comment that copies the marker is not mistaken for the bot's", async () => {
  const { f, service } = triageFixture();
  f.issueComments.push({ id: 99, body: `${TRIAGE_MARKER}\nfake`, user: { type: "User" } });
  await f.open(rawPull({ number: 5, sha: SHA1 }));
  service.finishAll();
  await f.engine.reconcile();
  assert.equal(f.issueComments.find((c) => c.id === 99).body.endsWith("fake"), true, "the human comment is untouched");
  assert.equal(f.issueComments.length, 2, "the bot added its own");
});

test("the public comment is bounded and carries no links, images, HTML or mentions from the model", () => {
  const hostile = {
    effort: 3,
    relevant_tests: "No",
    security_concerns: "See [report](http://evil.example/x) ![p](http://evil.example/p.png) <script>x</script> @octocat <!-- hidden -->",
    key_issues: Array.from({ length: 20 }, (_, i) => ({ file: "a`b.ts", header: `H${i} [x](http://evil.example)`, content: "c".repeat(5000), start_line: 1, end_line: 2 })),
  };
  const body = formatTriageComment({ result: hostile, sha: SHA1 });
  assert.ok(body.startsWith(TRIAGE_MARKER));
  assert.ok(!body.includes("evil.example"));
  assert.ok(!body.includes("<script"));
  assert.ok(!body.includes("<!-- hidden"));
  assert.ok(body.includes("@​octocat"));
  assert.ok(body.length <= 8000);
  assert.equal((body.match(/^\d+\. /gm) ?? []).length, 8, "at most eight points");
});

test("the client treats an unknown job as lost and surfaces other failures", async () => {
  const responses = [new Response("{}", { status: 404 }), new Response("{}", { status: 500 }), new Response(JSON.stringify({ status: "done", result: {} }), { status: 200 })];
  const calls = [];
  const client = createTriageClient({ http: { fetch: async (url, init) => { calls.push({ url, init }); return responses.shift(); } } });
  const service = { url: "http://pr-triage:8080", token: "tok" };
  assert.deepEqual(await client.status(service, "abc"), { status: "lost" });
  await assert.rejects(client.status(service, "abc"), /triage status failed: 500/);
  assert.equal((await client.status(service, "abc")).status, "done");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
});

test("config: triage needs the company-wide service, and the service must be http(s) with a secret reference", () => {
  const ref = TRIAGE_SERVICE.tokenRef;
  const repo = { fullName: "o/r", defaultReviewerAgentId: "a" };
  assert.ok(validateConfig({ repositories: [{ ...repo, triage: true }], triageService: { url: "http://svc:8080", tokenRef: ref } }).ok);
  assert.ok(!validateConfig({ repositories: [{ ...repo, triage: true }] }).ok, "triage without triageService");
  assert.ok(!validateConfig({ triageService: { url: "ftp://svc", tokenRef: ref } }).ok, "not http(s)");
  assert.ok(!validateConfig({ triageService: { url: "http://svc", tokenRef: "plain-token" } }).ok, "not a secret reference");
  assert.ok(!validateConfig({ repositories: [{ ...repo, triage: "yes" }], triageService: { url: "http://svc", tokenRef: ref } }).ok);

  const normalized = normalizeConfig({ triageService: { url: "http://svc:8080/", tokenRef: ref }, repositories: [{ ...repo, triage: true }, { fullName: "o/s", defaultReviewerAgentId: "a" }] }, COMPANY);
  assert.deepEqual(normalized.repositories.get("o/r").triageService, { url: "http://svc:8080", tokenRef: ref });
  assert.equal(normalized.repositories.get("o/s").triageService, null);
});
