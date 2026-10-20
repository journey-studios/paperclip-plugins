import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { parsePullRequestDelivery, peekRepository, reviewIssueDescription, verifyGithubSignature } from "../src/github.js";

const REPO = "wallynm/tesselapp";
const SECRET = "a-strong-webhook-secret-with-32-chars";
const SHA = "a".repeat(40);
const ID = "11111111-1111-4111-8111-111111111111";
const iso = "2026-10-20T12:34:56Z";
const payload = (overrides = {}) => ({
  action: "opened",
  number: 373,
  repository: { full_name: REPO },
  pull_request: {
    title: "Update image credits",
    html_url: `https://github.com/${REPO}/pull/373`,
    head: { sha: SHA },
    base: { ref: "main" },
    user: { login: "dev" },
    state: "open",
    draft: false,
    updated_at: iso,
  },
  ...overrides,
});
const headers = { "x-github-event": "pull_request", "x-github-delivery": ID };

test("verifies raw body signature and rejects invalid signatures", () => {
  const raw = JSON.stringify(payload());
  const signature = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  assert.equal(verifyGithubSignature(raw, signature, SECRET), true);
  assert.equal(verifyGithubSignature(raw + " ", signature, SECRET), false);
  assert.equal(verifyGithubSignature(raw, signature, "wrong"), false);
  assert.equal(verifyGithubSignature(raw, "sha1=missing", SECRET), false);
  assert.equal(verifyGithubSignature(raw, signature, ""), false);
});

test("parses strict PR URL, SHA, updated date and delivery", () => {
  const { repository, payload: parsed } = peekRepository(JSON.stringify(payload()));
  assert.equal(repository, REPO);
  const event = parsePullRequestDelivery({ headers }, parsed);
  assert.equal(event.number, 373);
  assert.equal(event.sha, SHA);
  assert.equal(event.updatedAt, iso);
  assert.equal(event.draft, false);
  assert.equal(parsePullRequestDelivery({
    headers: { ...headers, "x-github-event": "issue_comment" },
  }, parsed), null);
  assert.throws(
    () => parsePullRequestDelivery({ headers }, payload({
      pull_request: { ...payload().pull_request, html_url: "https://evil.example/pull/373" },
    })),
    /does not match/,
  );
});

test("accepts only known signed event shapes and bounds the request size", () => {
  assert.throws(() => peekRepository("not-json"), /Malformed/);
  assert.throws(() => peekRepository("x".repeat(600_000)), /oversized/);
  assert.throws(
    () => parsePullRequestDelivery({ headers }, payload({
      pull_request: { ...payload().pull_request, head: { sha: "untrusted" } },
    })),
    /Invalid PR/,
  );
  assert.throws(
    () => parsePullRequestDelivery({ headers: { "x-github-event": "pull_request" } }, payload()),
    /delivery/,
  );
  assert.equal(
    parsePullRequestDelivery({ headers }, payload({ action: "labeled" })),
    null,
  );
});

test("review Issue pins SHA and delegates official publication to JOU-490", () => {
  const event = parsePullRequestDelivery({ headers }, payload());
  const desc = reviewIssueDescription({
    repository: event.repository,
    pr_number: event.number,
    head_sha: event.sha,
    base_ref: event.baseRef,
    pr_url: event.url,
  });
  assert.match(desc, new RegExp(SHA));
  assert.match(desc, /JOU-490/);
  assert.match(desc, /untrusted content/);
  assert.doesNotMatch(desc, /merge automatically/i);
});
