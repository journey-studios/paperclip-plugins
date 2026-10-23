import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildPlan } from "./experiment.mjs";
import { compareTreatments } from "./compare.mjs";
import { importReviewBenchGold, normalizeReview } from "./normalize.mjs";
import { digest, scoreTrial } from "./score.mjs";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const pr = { repo: "https://github.com/o/r", pr_number: 1, base: otherSha, head: sha };
const gold = [{ id: "critical", severity: "high" }, { id: "ordinary", severity: "low" }];
const provenance = (truth, findings) => ({ goldDigest: digest(truth), findingsDigest: digest(findings), judgeRevision: "frozen-judge-v1" });
function scored(findings, judgments, overrides = {}) {
  return scoreTrial({ gold, findings, judgments, provenance: provenance(gold, findings), ...overrides });
}
const match = (findingId, goldId) => ({ findingId, goldId, kind: "match", evidence: "Same causal defect confirmed at the frozen head" });
const study = { schemaVersion: 1, seed: "test", repetitions: 3, split: "holdout", layers: ["triage", "thermo"], treatments: [{ id: "base" }, { id: "a" }, { id: "b" }], baseline: "base", primaryCandidate: "a" };
for (const treatment of study.treatments) treatment.pins = Object.fromEntries(study.layers.map((layer) => [layer, { reviewerRevision: sha, effectiveModel: "pinned-model-v1", configDigest: digest(treatment.id) }]));
const corpus = { schemaVersion: 1, source: { revision: sha }, cases: Array.from({ length: 10 }, (_, i) => ({ id: `pr-${i}`, repo: `https://github.com/o/r${i}`, base: otherSha, head: sha, split: "holdout" })) };

function fixtureResults(plan) {
  return plan.jobs.map((job) => {
    let findings = [{ id: "f1" }];
    let judgments = [match("f1", "critical")];
    if (job.treatment === "a") {
      findings = [{ id: "f1" }, { id: "f2" }];
      judgments = [match("f1", "critical"), match("f2", "ordinary")];
    }
    return { jobId: job.id, experimentDigest: plan.experimentDigest, base: job.base, head: job.head, executionMode: "live", coverage: "complete", reviewerRevision: sha, effectiveModel: "pinned-model-v1", configDigest: digest(job.treatment), durationMs: 100, costUsd: null, costBasis: "unknown", score: scored(findings, judgments) };
  });
}

test("a novel finding absent from gold remains unresolved until explicitly adjudicated", () => {
  const findings = [{ id: "known" }, { id: "new" }];
  const result = scored(findings, [match("known", "critical")]);
  assert.equal(result.knownRecall, 0.5);
  assert.equal(result.falsePositives, 0);
  assert.equal(result.unresolved, 1);
  assert.equal(result.fullyAdjudicated, false);
  const accepted = scored(findings, [match("known", "critical"), { findingId: "new", kind: "novel_valid", evidence: "Reproduced against frozen code" }]);
  assert.equal(accepted.novel, 1);
  assert.equal(accepted.adjudicatedPrecision, 1);
  assert.equal(accepted.knownRecall, 0.5);
});

test("false positives need explicit evidence; duplicate prose cannot inflate recall", () => {
  const findings = [{ id: "f1" }, { id: "f2" }, { id: "f3" }];
  assert.throws(() => scored(findings, [match("f1", "critical"), match("f2", "critical")]), /duplicate credit/);
  const result = scored(findings, [match("f1", "critical"), { findingId: "f2", kind: "duplicate", duplicateOf: "f1", evidence: "Same defect restated" }, { findingId: "f3", kind: "false_positive", evidence: "The caller already validates the input" }]);
  assert.equal(result.knownFound, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.falsePositives, 1);
  assert.equal(result.adjudicatedPrecision, 0.5);
  assert.throws(() => scored(findings, [{ findingId: "f2", kind: "duplicate", duplicateOf: "f3", evidence: "Not confirmed" }]), /confirmed valid/);
});

test("empty reviews, no-gold controls, failures and invalid outputs do not get a perfect score", () => {
  assert.equal(scored([], []).knownRecall, 0);
  assert.equal(scored([], []).adjudicatedPrecision, null);
  assert.equal(scored([], [], { status: "failed" }).knownMissed, 2);
  assert.equal(scored([], [], { status: "invalid" }).knownRecall, 0);
  assert.equal(scored([], [], { gold: [], provenance: provenance([], []) }).knownRecall, null);
  assert.throws(() => scored([{ id: "x" }], [], { status: "failed" }), /cannot contribute/);
});

test("scoring rejects changed inputs, missing evidence and forged matches", () => {
  assert.throws(() => scored([], [], { provenance: { ...provenance(gold, []), goldDigest: "wrong" } }), /Gold digest/);
  assert.throws(() => scored([{ id: "x" }], [match("x", "missing")]), /unknown gold/);
  assert.throws(() => scored([{ id: "x" }], [{ findingId: "x", kind: "false_positive" }]), /evidence/);
  assert.throws(() => scored([{ id: "x" }, { id: "x" }], []), /duplicate id/);
});

test("the planned schedule is reproducible, paired and complete for every repetition", () => {
  const plan = buildPlan(study, corpus);
  assert.equal(plan.jobs.length, 180);
  assert.deepEqual(plan, buildPlan(study, corpus));
  assert.notDeepEqual(plan.jobs, buildPlan({ ...study, seed: "different" }, corpus).jobs);
  assert.equal(new Set(plan.jobs.map((job) => job.id)).size, 180);
  assert.throws(() => buildPlan({ ...study, repetitions: 1 }, corpus), /three repetitions/);
  assert.throws(() => buildPlan({ ...study, layers: ["triage", "triage"] }, corpus), /Duplicate layers/);
  assert.throws(() => buildPlan(study, { ...corpus, cases: [corpus.cases[0], { ...corpus.cases[0], id: "other", split: "development" }] }), /cannot cross/);
  assert.throws(() => buildPlan(study, { ...corpus, cases: [{ ...corpus.cases[0], head: "main" }] }), /pin base and head/);
});

test("only the preselected candidate on a complete holdout can establish improvement", () => {
  const plan = buildPlan(study, corpus);
  const report = compareTreatments(plan, fixtureResults(plan));
  for (const result of report.comparisons) {
    if (result.treatment === "a") {
      assert.equal(result.qualityImprovementEstablished, true);
      assert.equal(result.pairedRecall95.delta, 0.5);
      assert.equal(result.pairedRecall95.lower, 0.5);
      assert.equal(result.candidate.costUsd, null);
      assert.equal(result.candidate.costKnown, false);
    } else {
      assert.equal(result.qualityImprovementEstablished, false);
    }
  }
  const dev = buildPlan({ ...study, split: "development" }, { ...corpus, cases: corpus.cases.map((item) => ({ ...item, split: "development" })) });
  assert.ok(compareTreatments(dev, fixtureResults(dev)).comparisons.every((row) => !row.qualityImprovementEstablished));
});

test("failures, omitted trials, changed gold, model drift and unknown cost cannot disappear", () => {
  const plan = buildPlan(study, corpus);
  const results = fixtureResults(plan);
  assert.throws(() => compareTreatments(plan, results.slice(1)), /Incomplete experiment/);
  const badHead = structuredClone(results);
  badHead[0].head = otherSha;
  assert.throws(() => compareTreatments(plan, badHead), /wrong commit/);
  const badBase = structuredClone(results);
  badBase[0].base = sha;
  assert.throws(() => compareTreatments(plan, badBase), /wrong diff base/);
  const changedGold = structuredClone(results);
  changedGold[0].score.goldDigest = "changed";
  assert.throws(() => compareTreatments(plan, changedGold), /Gold changed/);
  const drift = structuredClone(results);
  drift[0].effectiveModel = "another-model";
  assert.throws(() => compareTreatments(plan, drift), /drifted/);
  const unpriced = structuredClone(results);
  unpriced[0].costUsd = 0;
  assert.throws(() => compareTreatments(plan, unpriced), /reported as free/);
  const broken = structuredClone(results);
  broken[0].score.knownRecall = Number.NaN;
  assert.throws(() => compareTreatments(plan, broken), /Inconsistent recall/);
  const failed = structuredClone(results);
  const failedRow = failed.find((row) => plan.jobs.find((job) => job.id === row.jobId).treatment === "a");
  failedRow.score = scored([], [], { status: "failed" });
  const comparison = compareTreatments(plan, failed).comparisons.find((row) => row.layer === "triage" && row.treatment === "a");
  assert.ok(comparison.candidate.successRate < 1);
  assert.equal(comparison.qualityImprovementEstablished, false);
});

test("unresolved findings and fixture runs cannot establish a quality win", () => {
  const plan = buildPlan(study, corpus);
  const results = fixtureResults(plan).map((row) => ({ ...row, executionMode: "fixture" }));
  assert.ok(compareTreatments(plan, results).comparisons.every((row) => !row.qualityImprovementEstablished));
  const unknown = fixtureResults(plan);
  const target = unknown.find((row) => plan.jobs.find((job) => job.id === row.jobId).treatment === "a");
  target.score = scored([{ id: "f1" }, { id: "f2" }, { id: "new" }], [match("f1", "critical"), match("f2", "ordinary")]);
  assert.equal(compareTreatments(plan, unknown).comparisons.find((row) => row.layer === "triage" && row.treatment === "a").qualityImprovementEstablished, false);
});

test("normalization preserves findings and refuses wrong heads, invalid output and unlocalized security", () => {
  const triage = normalizeReview({ layer: "triage", pr, agent: "baseline", review: { security_concerns: "No", key_issues: [{ file: "a.ts", start_line: 2, header: "Race", content: "Concurrent writes lose data" }] } });
  assert.equal(triage.findings[0].start_line, 2);
  const block = `<!-- paperclip-review-verdict\n${JSON.stringify({ v: 1, repo: "o/r", number: 1, headSha: sha, outcome: "request_changes", findings: [{ severity: "major", path: "a.ts", line: 2, message: "Concurrent writes lose data" }] })}\n-->`;
  assert.equal(normalizeReview({ layer: "thermo", pr, agent: "baseline", review: block }).findings.length, 1);
  assert.throws(() => normalizeReview({ layer: "thermo", pr: { ...pr, head: otherSha }, agent: "base", review: block }), /another PR or head/);
  assert.throws(() => normalizeReview({ layer: "triage", pr, agent: "base", review: {} }), /Missing triage/);
  assert.throws(() => normalizeReview({ layer: "triage", pr, agent: "base", review: { key_issues: [], security_concerns: "Potential credential exposure" } }), /must not be dropped/);
});

test("imported labels keep their actual provenance and reject a different snapshot", () => {
  const raw = { pr, findings: [{ file: "a.ts", start_line: 2, message: "Bug", tp_fp: "tp", source: { alignment: "generated" }, producer: "llm_review:reference" }, { tp_fp: "fp" }] };
  const result = importReviewBenchGold(raw, pr);
  assert.equal(result.length, 1);
  assert.equal(result[0].source.alignment, "generated");
  assert.throws(() => importReviewBenchGold(raw, { ...pr, head: otherSha }), /another PR or commit/);
});

test("the real pilot is a smoke corpus, never enough to declare a winner", async () => {
  const source = JSON.parse(await readFile(new URL("./corpus.json", import.meta.url), "utf8"));
  const config = JSON.parse(await readFile(new URL("./study.json", import.meta.url), "utf8"));
  assert.equal(source.cases.length, 12);
  assert.equal(new Set(source.cases.map((item) => item.repo)).size, 12);
  assert.ok(source.cases.every((item) => item.goldenBlob && item.linesChanged <= 10000));
  assert.equal(buildPlan(config, source).jobs.length, 108);
  assert.equal(buildPlan(config, source).ready, false);
  assert.throws(() => compareTreatments(buildPlan(config, source), []), /Pin every treatment/);
});
