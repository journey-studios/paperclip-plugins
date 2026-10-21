import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReceiptKey,
  extractReviewDecisionTransition,
  isSelfReviewBlocked,
  mapOutcomeToGitHubEvent,
  parsePullReference,
} from "../src/review-sync-core.js";

test("mapOutcomeToGitHubEvent maps native outcomes fail-closed", () => {
  assert.equal(mapOutcomeToGitHubEvent("approved"), "APPROVE");
  assert.equal(mapOutcomeToGitHubEvent("changes_requested"), "REQUEST_CHANGES");
  assert.equal(mapOutcomeToGitHubEvent("unknown"), null);
});

test("buildReceiptKey is stable per decision/pr/sha/event", () => {
  const key = buildReceiptKey({
    companyId: "c1",
    issueId: "i1",
    decisionId: "d1",
    pull: { owner: "wallynm", repo: "tesselapp", number: 372 },
    headSha: "abc123",
    event: "REQUEST_CHANGES",
  });
  assert.equal(key, "c1:i1:d1:wallynm/tesselapp#372:abc123:REQUEST_CHANGES");
});

test("parsePullReference accepts short form and GitHub URL", () => {
  assert.deepEqual(parsePullReference("wallynm/tesselapp#372"), {
    owner: "wallynm",
    repo: "tesselapp",
    number: 372,
  });
  assert.deepEqual(parsePullReference("https://github.com/wallynm/tesselapp/pull/372"), {
    owner: "wallynm",
    repo: "tesselapp",
    number: 372,
  });
  assert.equal(parsePullReference(""), null);
});

test("isSelfReviewBlocked detects GitHub 422 self-review", () => {
  assert.equal(
    isSelfReviewBlocked({
      status: 422,
      message: "Review Can not request changes on your own pull request",
    }),
    true,
  );
  assert.equal(isSelfReviewBlocked({ status: 403 }), false);
});

test("extractReviewDecisionTransition ignores duplicate snapshots", () => {
  const first = extractReviewDecisionTransition({
    before: { lastDecisionId: null, lastDecisionOutcome: null },
    after: { lastDecisionId: "d1", lastDecisionOutcome: "changes_requested" },
  });
  assert.deepEqual(first, { decisionId: "d1", outcome: "changes_requested" });

  const duplicate = extractReviewDecisionTransition({
    before: { lastDecisionId: "d1", lastDecisionOutcome: "changes_requested" },
    after: { lastDecisionId: "d1", lastDecisionOutcome: "changes_requested" },
  });
  assert.equal(duplicate, null);
});
