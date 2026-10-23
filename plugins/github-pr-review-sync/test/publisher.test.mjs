import test from "node:test";
import assert from "node:assert/strict";
import { publishReviewDecisionsForIssue, readDecisionFromIssueState } from "../src/publisher.js";
import { publicationMarker } from "../src/github-api.js";

test("readDecisionFromIssueState reads native execution fields", () => {
  assert.deepEqual(
    readDecisionFromIssueState({
      lastDecisionId: "d1",
      lastDecisionOutcome: "changes_requested",
    }),
    { decisionId: "d1", outcome: "changes_requested" },
  );
  assert.equal(readDecisionFromIssueState({ lastDecisionId: "d1", lastDecisionOutcome: "pending" }), null);
});

test("publicationMarker is stable for receipt key", () => {
  const marker = publicationMarker("company:issue:decision:pr:sha:EVENT");
  assert.match(marker, /paperclip-github-pr-review-sync/);
});

test("an intake issue cannot bypass verdict evidence through the native decision flow", async () => {
  const ctx = { issues: { get: async () => ({ originKind: "plugin:journey-studios.github-pr-intake", executionState: { lastDecisionId: "d", lastDecisionOutcome: "approved" } }) } };
  assert.equal((await publishReviewDecisionsForIssue(ctx, "company", "issue", null)).skipped, "intake_verdict_required");
});
