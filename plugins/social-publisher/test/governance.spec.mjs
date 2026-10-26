import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { contentHash } from "../src/catalog.js";
import {
  evaluateChannelPolicy,
  approvalMatches,
  validateContentForPlatforms,
  factualEvidenceStatus,
} from "../src/governance.js";
import { factualEvidence } from "./helpers.mjs";
const agentId = randomUUID();
const account = {
  id: randomUUID(),
  platform: "x",
  status: "connected",
  verificationStatus: "VERIFIED",
  policy: "approval_required",
  killSwitch: false,
  dailyLimit: 5,
  postsToday: 0,
  allowedAgentIds: [agentId],
};
function approved(extra = {}) {
  const post = {
    text: "Tessel RPG",
    platforms: ["x"],
    platformCustomizations: {},
    mediaUrls: [],
    targets: [{ platform: "x", accountId: account.id }],
    campaign: "tessel-social-daily",
    dryRun: false,
    metadata: { factualEvidence },
    status: "approved",
    version: 1,
    ...extra,
  };
  post.contentHash = contentHash(post);
  post.approvalHash = post.contentHash;
  post.approvedBy = "founder";
  post.approvedAt = new Date().toISOString();
  post.approvalExpiresAt = new Date(Date.now() + 60000).toISOString();
  return post;
}

test("approval is a content-and-destination capability, not a boolean status", () => {
  const p = approved();
  assert.equal(approvalMatches(p), true);
  assert.equal(approvalMatches({ ...p, text: "Different content" }), false);
  assert.equal(approvalMatches({ ...p, targets: [] }), false);
  assert.equal(approvalMatches({ ...p, approvalHash: "wrong" }), false);
  assert.equal(
    approvalMatches({ ...p, approvalExpiresAt: new Date(Date.now() - 1).toISOString() }),
    false,
  );
  assert.equal(
    approvalMatches({ status: "approved", approvedAt: new Date().toISOString() }),
    false,
  );
});

test("live policy fails closed on identity, verification, account policy, global stop and quota", () => {
  const p = approved();
  const options = { actor: { actorType: "agent", actorId: agentId }, config: {} };
  assert.equal(evaluateChannelPolicy(account, p, options).allowed, true);
  for (const changed of [
    null,
    { ...account, status: "expired" },
    { ...account, verificationStatus: "CONNECTED_UNVERIFIED" },
    { ...account, policy: "disabled" },
    { ...account, killSwitch: true },
    { ...account, dailyLimit: 0 },
    { ...account, postsToday: 5 },
    { ...account, allowedAgentIds: [] },
  ])
    assert.equal(evaluateChannelPolicy(changed, p, options).allowed, false);
  assert.equal(
    evaluateChannelPolicy(account, p, { ...options, config: { killSwitch: true } }).allowed,
    false,
  );
  assert.equal(
    evaluateChannelPolicy(account, { ...p, status: "rejected" }, options).allowed,
    false,
  );
});

test("autonomous mode requires explicit opt-in and independently verified factual evidence", () => {
  const p = approved({ campaign: "independent-campaign" });
  const autonomous = { ...account, policy: "autonomous", autonomousOptIn: true };
  assert.equal(evaluateChannelPolicy(autonomous, p, { factsVerified: true }).allowed, true);
  assert.equal(evaluateChannelPolicy(autonomous, p, { factsVerified: false }).allowed, false);
  assert.equal(
    evaluateChannelPolicy({ ...autonomous, autonomousOptIn: false }, p, { factsVerified: true })
      .allowed,
    false,
  );
  const daily = approved();
  delete daily.approvedAt;
  assert.equal(
    evaluateChannelPolicy(autonomous, daily, { factsVerified: true }).requiresApproval,
    true,
  );
});

test("missing, duplicate and unsupported destinations cannot bypass validation", () => {
  for (const platforms of [undefined, [], ["x", "x"], ["fake"]])
    assert.equal(validateContentForPlatforms({ text: "Hello" }, platforms).valid, false);
  const result = validateContentForPlatforms({ text: "Short" }, ["instagram", "x", "threads"]);
  assert.equal(result.valid, false);
  assert.equal(result.platforms.x.valid, true);
  assert.equal(result.platforms.threads.valid, true);
});

test("factual sources are bounded released product evidence and autonomy needs operator verification", () => {
  const post = { metadata: { factualEvidence } };
  assert.equal(factualEvidenceStatus(post).status, "HUMAN_REVIEW_REQUIRED");
  assert.equal(
    factualEvidenceStatus(post, {
      verifiedEvidenceHashes: factualEvidenceStatus(post).evidenceHashes,
    }).status,
    "VERIFIED",
  );
  const verifiedHashes = factualEvidenceStatus(post).evidenceHashes;
  assert.equal(
    factualEvidenceStatus(
      {
        metadata: {
          factualEvidence: [{ ...factualEvidence[0], claim: "Forged claim with same evidence id" }],
        },
      },
      { verifiedEvidenceHashes: verifiedHashes },
    ).independentlyVerified,
    false,
  );
  for (const source of [
    { ...factualEvidence[0], sourceUrl: "https://attacker.example/" },
    { ...factualEvidence[0], releaseStatus: "planned" },
    { ...factualEvidence[0], sourceUrl: "https://github.com/other/repo" },
  ])
    assert.equal(factualEvidenceStatus({ metadata: { factualEvidence: [source] } }).valid, false);
});
