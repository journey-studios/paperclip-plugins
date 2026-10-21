import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewBody } from "../src/review-body.js";
import { handleIssueUpdated } from "../src/publisher.js";
import {
  resolveLinkedPullRequests,
  extractPullRefsFromText,
  pullRefFromWorkProductMetadata,
} from "../src/pull-resolution.js";

test("extractPullRefsFromText finds GitHub pull URLs", () => {
  const text = "See https://github.com/wallynm/tesselapp/pull/372 and also https://github.com/org/repo/pull/1/files";
  const refs = extractPullRefsFromText(text);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], { owner: "wallynm", repo: "tesselapp", number: 372 });
});

test("pullRefFromWorkProductMetadata parses repo metadata", () => {
  assert.deepEqual(pullRefFromWorkProductMetadata({ repo: "wallynm/tesselapp", number: 372 }), {
    owner: "wallynm",
    repo: "tesselapp",
    number: 372,
  });
  assert.equal(pullRefFromWorkProductMetadata({}), null);
});

const ctxWith = ({ issue, artifacts = [], comments = [] }) => ({
  issues: { get: async () => issue, listComments: async () => comments },
  artifacts: { list: async () => ({ artifacts }) },
  logger: { warn() {}, info() {}, error() {} },
});

test("only the issue origin and artifacts whose link is a PR count as linked", async () => {
  const ctx = ctxWith({
    issue: {
      originId: "wallynm/tesselapp#5",
      description: "similar to https://github.com/org/other/pull/12",
    },
    comments: [{ body: "also https://github.com/org/other/pull/13" }],
    artifacts: [
      { href: "https://github.com/wallynm/tesselapp/pull/6" },
      { title: "https://github.com/org/other/pull/14", previewText: "https://github.com/org/other/pull/15" },
    ],
  });
  const refs = await resolveLinkedPullRequests(ctx, "i1", "c1");
  assert.deepEqual(refs.map((r) => `${r.owner}/${r.repo}#${r.number}`).sort(), ["wallynm/tesselapp#5", "wallynm/tesselapp#6"]);
});

test("the review body never copies issue thread text", () => {
  const body = buildReviewBody({ identifier: "JOU-1", title: "T" }, [{ body: "secret-token-123" }], null);
  assert.ok(!body.includes("secret-token-123"));
  assert.ok(body.includes("JOU-1"));
});

test("last-decision state uses a scope key object, as the host requires", async () => {
  const keys = [];
  const ctx = {
    ...ctxWith({ issue: { executionState: { lastDecisionId: "d1", lastDecisionOutcome: "approved" } } }),
    state: {
      get: async (key) => {
        keys.push(key);
        return "d1";
      },
      set: async (key) => keys.push(key),
    },
  };
  await handleIssueUpdated(ctx, { entityId: "i1", companyId: "c1", payload: {} });
  assert.ok(keys.length > 0);
  for (const key of keys) {
    assert.equal(typeof key, "object");
    assert.equal(key.scopeKind, "instance");
    assert.match(key.stateKey, /last-published-decision:i1/);
  }
});
