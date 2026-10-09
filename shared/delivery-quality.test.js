import test from "node:test";
import assert from "node:assert/strict";
import { compareDeliveryQuality, pairControlledSkillTests, readDeliveryQuality, summarizeDeliveryQuality } from "./delivery-quality.js";

function row(overrides = {}) {
  return {
    id: `evaluation-${Math.random()}`,
    companyId: "company-1",
    revisionId: "revision-1",
    workProductId: "work-product-1",
    agentId: "agent-1",
    rubric: "research-v1",
    contributionRole: "author",
    reviewerType: "human",
    reviewerId: "reviewer-1",
    score: 80,
    deliveredAt: "2026-10-09T00:00:00.000Z",
    executionProfile: {
      role: "analyst", reportsTo: "lead-1", configuredModel: "model-a", effectiveModel: "model-a-effective", modelCoverage: "effective_known", skillsContentCoverage: "complete",
      adapterType: "native", configRevisionId: "config-1", instructionFingerprint: "instructions-a", instructionCoverage: "bundle",
      runtimeContextCoverage: "native_verified",
      nativeRuntimeContext: { aggregateDigest: "aggregate-v1", promptDigest: "prompt-a", instructionBundleDigest: "bundle-a", mcpDigest: "mcp-a", skills: [{ key: "research", versionId: "v1", bundleDigest: "sha-v1" }] },
      skills: [{ key: "research", versionId: "v1", versionBasis: "pinned", contentFingerprint: "sha-v1", exposure: "selected", usage: "unknown" }],
    },
    hypotheses: [],
    ...overrides,
  };
}

function quality(cohorts, extra = {}) {
  return { companyId: "company-1", environment: "production", start: "", end: "", cohorts, coverage: { truncated: false }, samples: [], notes: [], ...extra };
}

test("aggregates multiple reviews into one delivery grade and keeps cohorts separate", () => {
  const cohorts = summarizeDeliveryQuality([
    row({ id: "r1a", score: 80 }), row({ id: "r1b", score: 90, reviewerId: "reviewer-2" }),
    row({ id: "r2", revisionId: "revision-2", score: 65 }),
    row({ id: "other-role", contributionRole: "curator", score: 100 }),
  ]);
  const author = cohorts.find(cohort => cohort.contributionRole === "author");
  assert.equal(author.assessedDeliveries, 2);
  assert.equal(author.reviewCount, 3);
  assert.equal(author.score, 75);
  assert.equal(cohorts.length, 2);
  assert.equal(author.skills[0].usage, "unknown");
});

test("only compares a changed skill when the rest of the profile and effective model match", () => {
  const before = summarizeDeliveryQuality(Array.from({ length: 5 }, (_, i) => row({ id: `before-${i}`, revisionId: `before-rev-${i}`, score: 70 })));
  const after = summarizeDeliveryQuality(Array.from({ length: 5 }, (_, i) => row({ id: `after-${i}`, revisionId: `after-rev-${i}`, score: 76, executionProfile: { ...row().executionProfile, skills: [{ key: "research", versionId: "v2", versionBasis: "catalog", contentFingerprint: "sha-v2", exposure: "selected", usage: "unknown" }] } })));
  const [result] = compareDeliveryQuality(quality(before), quality(after), { changedSkillKeys: ["research"] });
  assert.equal(result.outcome, "within_threshold");
  assert.equal(result.reason, "absolute_change_below_10_point_observational_threshold_v1");
  assert.equal(result.causality, "association");
  assert.equal(result.baselineSamples.length, 5);
  assert.match(result.currentSamples[0].feedbackHref, /evaluationId=/);
});

test("does not attribute a skill-only change when the affected agent kept the same skill version", () => {
  const before = summarizeDeliveryQuality(Array.from({ length: 5 }, (_, i) => row({ id: `before-${i}`, revisionId: `before-rev-${i}`, score: 70 })));
  const after = summarizeDeliveryQuality(Array.from({ length: 5 }, (_, i) => row({ id: `after-${i}`, revisionId: `after-rev-${i}`, score: 95 })));
  const [result] = compareDeliveryQuality(quality(before), quality(after), { changedSkillKeys: ["research"] });
  assert.equal(result.outcome, "inconclusive");
  assert.equal(result.reason, "changed_skill_exposure_not_varied");
  assert.equal(result.delta, null);
});

test("does not compare a changed skill when the selected target bytes are unknown", () => {
  const before = summarizeDeliveryQuality(Array.from({ length: 5 }, (_, i) => row({ id: `before-${i}`, revisionId: `before-rev-${i}`, score: 70 })));
  const after = summarizeDeliveryQuality(Array.from({ length: 5 }, (_, i) => row({ id: `after-${i}`, revisionId: `after-rev-${i}`, score: 85, executionProfile: { ...row().executionProfile, skillsContentCoverage: "unknown", skills: [{ key: "research", versionId: "v2", versionBasis: "catalog", contentFingerprint: null, exposure: "selected", usage: "unknown" }] } })));
  const [result] = compareDeliveryQuality(quality(before), quality(after), { changedSkillKeys: ["research"] });
  assert.equal(result.outcome, "inconclusive");
  assert.ok(result.confounders.includes("target_skill_content_unknown"));
});

test("prompt and MCP digests split production cohorts and make temporal comparisons inconclusive", () => {
  const before = summarizeDeliveryQuality(Array.from({ length: 5 }, (_, i) => row({ id: `before-context-${i}`, revisionId: `before-context-rev-${i}`, score: 70 })));
  for (const [field, value, expected] of [["promptDigest", "prompt-b", "prompt_digest"], ["mcpDigest", "mcp-b", "mcp_digest"]]) {
    const after = summarizeDeliveryQuality(Array.from({ length: 5 }, (_, i) => {
      const profile = row().executionProfile;
      return row({ id: `after-${field}-${i}`, revisionId: `after-${field}-rev-${i}`, score: 90, executionProfile: {
        ...profile, skills: [{ key: "research", versionId: "v2", versionBasis: "pinned", contentFingerprint: "sha-v2", exposure: "selected", usage: "unknown" }],
        nativeRuntimeContext: { ...profile.nativeRuntimeContext, aggregateDigest: "aggregate-v2", skills: [{ key: "research", versionId: "v2", bundleDigest: "sha-v2" }], [field]: value },
      } });
    }));
    assert.notEqual(before[0].key, after[0].key, `${field} changes form separate cohorts`);
    const comparison = compareDeliveryQuality(quality(before), quality(after), { changedSkillKeys: ["research"] });
    assert.ok(comparison.length > 0);
    assert.ok(comparison.every(result => result.outcome === "inconclusive"));
    assert.ok(comparison.some(result => result.confounders.includes(expected)));
  }
});

test("unknown model, changed other skill, ambiguous target versions, and incomplete instructions stay inconclusive", () => {
  const before = summarizeDeliveryQuality(Array.from({ length: 5 }, (_, i) => row({ id: `b-${i}`, revisionId: `b-${i}` })));
  const unknownModel = summarizeDeliveryQuality(Array.from({ length: 5 }, (_, i) => row({ id: `a-${i}`, revisionId: `a-${i}`, executionProfile: { ...row().executionProfile, modelCoverage: "configured_only" } })));
  const modelResult = compareDeliveryQuality(quality(before), quality(unknownModel), { changedSkillKeys: ["research"] })[0];
  assert.equal(modelResult.outcome, "inconclusive");
  assert.ok(modelResult.confounders.includes("model_effective_coverage"));

  const otherSkill = summarizeDeliveryQuality(Array.from({ length: 5 }, (_, i) => row({ id: `o-${i}`, revisionId: `o-${i}`, executionProfile: { ...row().executionProfile, skills: [{ key: "different", versionId: "x", versionBasis: "pinned" }] } })));
  const confounded = compareDeliveryQuality(quality(before), quality(otherSkill), { changedSkillKeys: ["research"] });
  assert.ok(confounded.every(result => result.outcome === "inconclusive"));
  assert.ok(confounded.some(result => result.confounders.includes("other_skill_versions")));

  const multipleVersions = summarizeDeliveryQuality([
    ...Array.from({ length: 5 }, (_, i) => row({ id: `m1-${i}`, revisionId: `m1-${i}`, deliveredAt: "2026-10-09T00:00:00.000Z" })),
    ...Array.from({ length: 5 }, (_, i) => row({ id: `m2-${i}`, revisionId: `m2-${i}`, deliveredAt: "2026-10-09T00:00:00.000Z", executionProfile: { ...row().executionProfile, skills: [{ key: "research", versionId: "v3", versionBasis: "pinned" }] } })),
  ]);
  const ambiguous = compareDeliveryQuality(quality(before), quality(multipleVersions), { changedSkillKeys: ["research"] });
  assert.ok(ambiguous.every(result => result.outcome === "inconclusive"));
  assert.ok(ambiguous.some(result => result.reason === "multiple_skill_versions_in_window"));

  const partialInstructions = summarizeDeliveryQuality(Array.from({ length: 5 }, (_, i) => row({ id: `p-${i}`, revisionId: `p-${i}`, executionProfile: { ...row().executionProfile, instructionCoverage: "partial" } })));
  assert.equal(compareDeliveryQuality(quality(before), quality(partialInstructions), { changedSkillKeys: ["research"] })[0].outcome, "inconclusive");
});

test("truncated result suppresses aggregates and skill-test reads use their separate eligibility state", async () => {
  const [cohort] = summarizeDeliveryQuality([row()], { truncated: true });
  assert.equal(cohort.score, null);
  assert.equal(cohort.assessedDeliveries, null);
  assert.equal(cohort.reviewCount, null);
  assert.equal(cohort.distribution, null);

  const calls = [];
  const ctx = { db: { query: async (sql, params) => { calls.push({ sql, params }); return []; } } };
  await readDeliveryQuality(ctx, "company-1", { start: "2026-10-01", end: "2026-10-09", environment: "skill_test" });
  assert.equal(calls[0].params[5], "controlled_test");
  assert.match(calls[0].sql, /supersedes_id/);
  assert.match(calls[0].sql, /controlled_test_ref/);
  assert.match(calls[1].sql, /run_execution_profiles/);
});

test("quality counts include board-confirmed agents even when their revisions lack a publisher or origin profile", async () => {
  const boardConfirmedAgent = "board-confirmed-agent";
  const evaluation = row({ id: "board-review", agentId: boardConfirmedAgent, revisionId: "board-revision", workProductId: "board-work-product" });
  const ctx = { db: { query: async (sql) => {
    if (sql.includes("FROM public.delivery_evaluations e JOIN public.delivery_revisions")) return [evaluation];
    if (sql.includes("FROM public.delivery_revisions r JOIN public.run_execution_profiles")) return [];
    if (sql.includes("FROM public.delivery_evaluations e WHERE e.company_id")) return [{ agentId: boardConfirmedAgent, count: 1 }];
    throw new Error("Unexpected quality query");
  } } };
  const result = await readDeliveryQuality(ctx, "company-1", { start: "2026-10-01", end: "2026-10-09" });
  assert.deepEqual(result.coverage.eligibleByAgent, [{ agentId: boardConfirmedAgent, trackedExactRevisions: 0, assessedDeliveries: 1 }]);
  assert.equal(result.cohorts[0].assessedDeliveries, 1);
  assert.match(result.samples[0].feedbackHref, /revisionId=board-revision.*evaluationId=board-review/);
  assert.match(result.coverage.notes.join(" "), /may exist outside this denominator/i);
});

test("pairs controlled skill-test grades only when input, template, comparison profile and rubric match", () => {
  const controlled = (id, version, score, overrides = {}) => {
    const { actualVersion = version, ...refOverrides } = overrides;
    return row({ id, revisionId: `revision-${id}`, score, executionProfile: { ...row().executionProfile, modelCoverage: "configured_only", skills: [{ key: "research", versionId: actualVersion, versionBasis: "pinned", contentFingerprint: `sha-${actualVersion}`, exposure: "selected", usage: "unknown" }], nativeRuntimeContext: { ...row().executionProfile.nativeRuntimeContext, aggregateDigest: `aggregate-${actualVersion}`, skills: [{ key: "research", versionId: actualVersion, bundleDigest: `sha-${actualVersion}` }] } }, controlledTestRef: {
    testRunId: `test-run-${id}`, inputDigest: "input-sha256", templateDigest: "template-sha256", skillKey: "research", skillVersionId: version,
    skillRevisionNumber: Number(version.slice(-1)), agentProfileDigest: "profile-without-target-skill", ...refOverrides,
  } });
  };
  const pairs = pairControlledSkillTests([
    controlled("v1", "version-1", 70), controlled("v2", "version-2", 85),
    controlled("different-input", "version-3", 99, { inputDigest: "different-input-sha256" }),
    controlled("different-profile", "version-4", 90, { agentProfileDigest: "different-profile-sha256" }),
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].reason, "execution_context_coverage_incomplete");
  assert.equal(pairs[0].delta, undefined);
  assert.equal(pairs[0].generalizesToProduction, false);

  const effective = [controlled("v1", "version-1", 70), controlled("v2", "version-2", 85)].map(evaluation => ({
    ...evaluation, executionProfile: { ...evaluation.executionProfile, modelCoverage: "effective_known" },
  }));
  const exactPair = pairControlledSkillTests(effective)[0];
  assert.equal(exactPair.baselineTestRunId, "test-run-v1");
  assert.equal(exactPair.currentTestRunId, "test-run-v2");
  assert.equal(exactPair.delta, 15);
  assert.equal(exactPair.generalizesToProduction, false);
  assert.deepEqual(exactPair.currentActualSkillVersionIds, ["version-2"]);

  const mismatched = pairControlledSkillTests([
    controlled("expected-v1", "version-1", 70), controlled("expected-v2-actual-v1", "version-2", 95, { actualVersion: "version-1" }),
  ])[0];
  assert.equal(mismatched.outcome, "inconclusive");
  assert.equal(mismatched.reason, "test_target_exposure_mismatch");
  assert.equal(mismatched.currentExpectedSkillVersionId, "version-2");
  assert.deepEqual(mismatched.currentActualSkillVersionIds, ["version-1"]);
  assert.equal(mismatched.currentSamples[0].expectedSkillVersionId, "version-2");
  assert.equal(mismatched.currentSamples[0].actualSkillVersionId, "version-1");
  assert.equal(pairControlledSkillTests([controlled("v1", "version-1", 70), controlled("v2", "version-2", 85)], { truncated: true }).length, 0);
});
