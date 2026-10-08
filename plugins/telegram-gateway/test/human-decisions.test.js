import test from "node:test";
import assert from "node:assert/strict";
import {
  buildApprovalCardBody,
  buildInteractionCardBody,
  isFounderReachableInteraction,
  sanitizeMarkdownField,
  stripSensitiveText,
} from "../src/human-decisions.js";

test("stripSensitiveText redacts bearer tokens and long secrets", () => {
  const input = "Use Bearer abcdefghijklmnop and api_key=super-secret-value";
  const out = stripSensitiveText(input);
  assert.match(out, /\[redacted\]/);
  assert.doesNotMatch(out, /super-secret-value/);
});

test("JOU-84 style interaction card is readable without secret payload", () => {
  const issue = { id: "issue-84", identifier: "JOU-84", companyId: "companyA" };
  const interaction = {
    id: "2ba4cad6-3ffa-4439-ab81-b312c52b2bf2",
    kind: "request_confirmation",
    status: "pending",
    effectiveResolverPolicy: "human_only",
    title: "Confirm credential proposal",
    payload: {
      prompt: "Approve storing the GitHub token?",
      detailsMarkdown: "Token value: ghp_deadbeefnotreal",
      rejectRequiresReason: true,
      target: { type: "issue_document", issueId: issue.id, key: "plan" },
      secretProposal: { label: "github_token", value: "ghp_topsecret" },
    },
    updatedAt: "2026-10-08T00:00:00.000Z",
  };
  assert.equal(isFounderReachableInteraction(interaction, "founder-a"), true);
  const body = buildInteractionCardBody(interaction, issue, "companyA");
  assert.match(body, /FOUNDER_HUMAN_DECISION_CARD/);
  assert.match(body, /JOU-84#interaction-2ba4cad6/);
  assert.match(body, /human_only/);
  assert.match(body, /one-tap buttons are not available/i);
  assert.doesNotMatch(body, /ghp_topsecret/);
  assert.doesNotMatch(body, /ghp_deadbeef/);
  assert.match(body, /\[redacted/);
});

test("restricted action and connection cards never fall back to raw prompt or details", () => {
  const issue = { id: "issue-1", identifier: "JOU-1", companyId: "companyA" };
  for (const restricted of [
    { toolAction: { toolName: "deploy", arguments: { token: "raw-token" } } },
    { connectionAuthorization: { token: "raw-token" } },
    { connectionIntent: { token: "raw-token" } },
  ]) {
    const body = buildInteractionCardBody({
      id: "interaction-1",
      kind: "request_confirmation",
      status: "pending",
      title: "Review in Paperclip",
      payload: { ...restricted, prompt: "OAuth-code-abc12345", detailsMarkdown: "opaque-bearer-abcdef123456" },
    }, issue, "companyA");
    assert.match(body, /Review in Paperclip/);
    assert.doesNotMatch(body, /OAuth-code-abc12345|opaque-bearer-abcdef123456|raw-token/);
  }
});

test("approval card includes canonical link and coverage gap note", () => {
  const approval = {
    id: "appr-1",
    companyId: "companyA",
    status: "pending",
    type: "request_board_approval",
    updatedAt: "2026-10-08T00:00:00.000Z",
    payload: {
      title: "Spend approval",
      summary: "Approve $40 hosting",
      recommendedAction: "Approve",
      risks: ["Usage may grow"],
    },
  };
  const body = buildApprovalCardBody(approval, { identifier: "JOU-90" }, "companyA");
  assert.match(body, /\/JOU\/approvals\/appr-1/);
  assert.match(body, /decisions/);
  assert.equal(sanitizeMarkdownField("  hello  "), "hello");
});
