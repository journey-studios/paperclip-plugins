import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { command } from "./io.mjs";
import { importJudgments } from "./judgments.mjs";
import { freezeProfile } from "./runtime.mjs";
import { usageReceipt } from "./run.mjs";
import { digest, scoreTrial } from "./score.mjs";
import { collect } from "./collect.mjs";
import { buildPlan } from "./experiment.mjs";
import { measurementFingerprint } from "./fingerprint.mjs";
import { writeJson } from "./io.mjs";
import { exportJudgeInput, importJudgeFiles } from "./judge-input.mjs";
import { importReviewBenchGold } from "./normalize.mjs";

const pr = { repo: "https://github.com/o/r", pr_number: 1, base: "a".repeat(40), head: "b".repeat(40) };
const finding = (message) => ({ file: "a.ts", start_line: 1, end_line: 1, message, producer: "fixture" });
const reference = { pr, pr_key: "o_r_1-bbbbbbbb", findings: [{ ...finding("known"), severity: "high", tp_fp: "tp", tp_fp_justification: "Reference evidence" }] };
const referenceText = JSON.stringify(reference);
const evalConfig = { matcher_model: "judge-v1", matcher_prompt_hash: "matcher-v1", classifier_model: "judge-v1", classifier_prompt_hash: "classifier-v1", golden_hash: createHash("sha256").update(referenceText).digest("hex") };

function judged(findings, rows, overrides = {}) {
  return importJudgments({ candidate: { pr, findings }, reference, referenceText, details: { pr_key: reference.pr_key, candidate_findings: findings.map((item, index) => ({ ...item, ...rows[index] })) }, evalConfig, judgeRevision: "source-and-overlay-v1", ...overrides });
}

test("the semantic judge importer preserves duplicates and missing rationales without guessing false positives", () => {
  const input = [finding("known"), finding("same cause"), finding("new issue"), finding("refuted")];
  const result = judged(input, [{ status: "matched_tp", matched_golden_index: 0, covered_golden_indices: [0] }, { status: "novel_tp", covered_golden_indices: [0] }, { status: "novel_tp", covered_golden_indices: [] }, { status: "novel_fp", covered_golden_indices: [], tp_fp_justification: "Caller guards the input before this function" }]);
  assert.deepEqual(result.judgments.map((item) => item.kind), ["match", "duplicate", "unresolved", "false_positive"]);
  const score = scoreTrial(result);
  assert.equal(score.knownFound, 1);
  assert.equal(score.duplicates, 1);
  assert.equal(score.unresolved, 1);
  assert.equal(score.falsePositives, 1);
});

test("judge identity stays fixed across PR label hashes but changes with prompts/models", () => {
  const result = judged([finding("new")], [{ status: "novel_tp", tp_fp_justification: "Confirmed against the frozen implementation" }]);
  assert.equal(result.judgments[0].kind, "novel_valid");
  assert.throws(() => judged([finding("new")], [{ status: "novel_tp" }], { evalConfig: { ...evalConfig, golden_hash: "another-pr" } }), /different reference bytes/);
  const changedPrompt = judged([finding("new")], [{ status: "novel_tp" }], { evalConfig: { ...evalConfig, matcher_prompt_hash: "changed" } });
  assert.notEqual(result.provenance.judgeRevision, changedPrompt.provenance.judgeRevision);
  assert.throws(() => judged([finding("known")], [{ matched_golden_index: 99 }]), /Invalid matched index/);
  assert.throws(() => judged([finding("known")], [{}], { details: { pr_key: reference.pr_key, candidate_findings: [] } }), /omitted findings/);
  assert.throws(() => judged([], [], { evalConfig: { ...evalConfig, excluded_producers: ["model"] } }), /denominator/);
});

test("missing usage and failed requests cannot become a zero-dollar successful measurement", () => {
  const events = [{ event: "started" }, { event: "finished", usage: { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 70 } }, { event: "started" }, { event: "failed" }];
  const receipt = usageReceipt(events, "subscription");
  assert.equal(receipt.costUsd, null);
  assert.equal(receipt.usage.usageComplete, false);
  assert.equal(receipt.usage.attempts, 2);
  assert.equal(receipt.usage.promptTokens, 100);
});

test("runtime freezing detects instruction changes, model pools and mutable images", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-runtime-"));
  try {
    const instructions = join(dir, "AGENTS.md");
    await writeFile(instructions, "Review instructions v1");
    const profile = { image: `sha256:${"a".repeat(64)}`, user: "1000:1000", timeoutSeconds: 60, gateway: { image: `sha256:${"b".repeat(64)}`, network: "models", upstream: "http://model-gateway:20128/v1", requestModel: "route/model-v1", effectiveModel: "model-v1", maxRequests: 3, maxOutputTokens: 1000, maxInputBytes: 100000, timeoutSeconds: 60, costBasis: "unknown" }, reviewer: { requestModel: "route/model-v1", instructions: [instructions], deliveryInstructions: "Return verdict locally", cliVersion: "1.18.33", modelLimit: { context: 32000, output: 1000 } } };
    const first = await freezeProfile(profile, "thermo");
    await writeFile(instructions, "Review instructions v2");
    const second = await freezeProfile(profile, "thermo");
    assert.notEqual(first.pins.configDigest, second.pins.configDigest);
    assert.equal(first.frozen.reviewer.instructions[0], "Review instructions v1");
    await assert.rejects(() => freezeProfile({ ...profile, image: "latest" }, "thermo"), /immutable/);
    await assert.rejects(() => freezeProfile({ ...profile, gateway: { ...profile.gateway, requestModel: "antigravity-pool" } }, "thermo"), /fixed model/);
    const pooled = { ...profile, gateway: { ...profile.gateway, requestModel: "antigravity-pool", routingSnapshot: { name: "antigravity-pool", models: [{ provider: "agy", model: "model-v1" }] } }, reviewer: { ...profile.reviewer, requestModel: "antigravity-pool" } };
    assert.equal((await freezeProfile(pooled, "thermo")).pins.effectiveModel, "model-v1");
    const reported = { ...pooled, gateway: { ...pooled.gateway, effectiveModel: "reported-model-v1", routingSnapshot: { ...pooled.gateway.routingSnapshot, responseModel: "reported-model-v1", responseModelEvidence: "Frozen calibration journal with exact response metadata" } } };
    assert.equal((await freezeProfile(reported, "thermo")).pins.effectiveModel, "reported-model-v1");
    await assert.rejects(() => freezeProfile({ ...reported, gateway: { ...reported.gateway, routingSnapshot: { ...reported.gateway.routingSnapshot, responseModelEvidence: "" } } }, "thermo"), /calibration evidence/);
    await assert.rejects(() => freezeProfile({ ...pooled, gateway: { ...pooled.gateway, routingSnapshot: { ...pooled.gateway.routingSnapshot, models: [{ provider: "agy", model: "model-v2" }] } } }, "thermo"), /single-model pool/);
    await assert.rejects(() => freezeProfile({ ...pooled, gateway: { ...pooled.gateway, routingSnapshot: { ...pooled.gateway.routingSnapshot, models: [...pooled.gateway.routingSnapshot.models, { provider: "agy", model: "model-v2" }] } } }, "thermo"), /single-model pool/);
    await assert.rejects(() => freezeProfile({ ...profile, gateway: { ...profile.gateway, upstream: "http://user:key@host/v1" } }, "thermo"), /without credentials/);
    assert.notEqual(digest(first.frozen), digest(second.frozen));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("model gateway enforces isolation policies and attempt limits with a fake backend", async () => {
  const output = await command("python3", [fileURLToPath(new URL("./adapters/gateway.spec.py", import.meta.url))]);
  assert.equal(output, "");
});

test("collection requires every slot and unchanged findings, usage, reference and measurement source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-collect-"));
  try {
    const corpus = { schemaVersion: 1, source: { revision: pr.base }, cases: [{ id: "case", repo: pr.repo, number: 1, base: pr.base, head: pr.head, split: "development" }] };
    const pins = { reviewerRevision: pr.head, effectiveModel: "fixed-model", configDigest: digest("fixed-config") };
    const study = { schemaVersion: 1, seed: "collection", repetitions: 3, split: "development", layers: ["triage"], baseline: "baseline", primaryCandidate: "a", treatments: ["baseline", "a", "b"].map((id) => ({ id, pins: { triage: pins } })), measurementDigest: await measurementFingerprint() };
    const plan = buildPlan(study, corpus);
    const gold = [{ id: "known", severity: "low" }];
    const snapshots = join(dir, "snapshots");
    const evaluations = join(dir, "evaluations");
    const runs = join(dir, "runs");
    const snapshot = { corpusDigest: plan.corpusDigest, goldDigest: digest(gold), referenceDigest: digest(reference) };
    await mkdir(join(snapshots, "case"), { recursive: true });
    await mkdir(evaluations);
    await writeJson(join(snapshots, "case/snapshot.json"), snapshot);
    await writeJson(join(snapshots, "case/reference.json"), { reference, gold });
    await writeJson(join(evaluations, "judge.json"), { judgeRevision: "fixed-judge" });
    for (const job of plan.jobs) {
      const path = join(runs, ...job.id.split("/"));
      await mkdir(path, { recursive: true });
      await writeJson(join(path, "trial.json"), { jobId: job.id, experimentDigest: plan.experimentDigest, base: job.base, head: job.head, executionMode: "fixture", coverage: "partial", ...pins, durationMs: 12, costUsd: null, costBasis: "unknown", status: "failed", snapshotDigest: digest(snapshot), goldDigest: digest(gold), gatewayJournalDigest: digest(""), candidateDigest: digest(null), usage: { attempts: 0 } });
    }
    const scored = await collect(plan, runs, snapshots, evaluations);
    assert.equal(scored.length, 9);
    assert.ok(scored.every((row) => row.score.knownRecall === 0 && row.score.status === "failed"));
    await assert.rejects(() => collect({ ...plan, measurementDigest: "outdated" }, runs, snapshots, evaluations), /measurement source/);
    const path = join(runs, ...plan.jobs[0].id.split("/"));
    const receipt = JSON.parse(await readFile(join(path, "trial.json"), "utf8"));
    const candidate = { pr, findings: [finding("original review")] };
    await writeFile(join(path, "trial.json"), JSON.stringify({ ...receipt, status: "completed", candidateDigest: digest(candidate) }));
    await writeJson(join(path, "candidate.json"), { ...candidate, findings: [finding("tampered review")] });
    await assert.rejects(() => collect(plan, runs, snapshots, evaluations), /Candidate findings changed/);
    await rm(join(path, "trial.json"));
    await assert.rejects(() => collect(plan, runs, snapshots, evaluations), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("judge file exchange hides treatment names and binds detailed output to the original trial", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-judge-files-"));
  try {
    const trialRoot = join(dir, "trial");
    const snapshotRoot = join(dir, "snapshot");
    const judgeRoot = join(dir, "judge");
    await mkdir(trialRoot);
    await mkdir(join(snapshotRoot, "pr"), { recursive: true });
    const gold = importReviewBenchGold(reference, pr);
    const snapshot = { referenceDigest: digest(reference) };
    const candidate = { pr, agent: "secret-treatment-name", findings: [{ ...finding("new finding"), producer: "secret-treatment-name" }] };
    await writeJson(join(trialRoot, "trial.json"), { status: "completed", candidateDigest: digest(candidate), snapshotDigest: digest(snapshot), goldDigest: digest(gold) });
    await writeJson(join(trialRoot, "candidate.json"), candidate);
    await writeJson(join(snapshotRoot, "snapshot.json"), snapshot);
    await writeJson(join(snapshotRoot, "reference.json"), { reference, referenceText, gold });
    await writeJson(join(snapshotRoot, "pr/pr.json"), pr);
    const exported = await exportJudgeInput(trialRoot, snapshotRoot, judgeRoot);
    assert.ok(exported.args.includes("--snapshot-dir"));
    assert.ok(!await readFile(join(judgeRoot, "candidate.json"), "utf8").then((text) => text.includes("secret-treatment-name")));
    assert.equal(await readFile(join(judgeRoot, "golden", `${reference.pr_key}.json`), "utf8"), referenceText);
    await writeJson(join(judgeRoot, "results.json"), { pr_count: 1, eval_config: evalConfig });
    await writeJson(join(judgeRoot, "results.details.json"), [{ pr_key: reference.pr_key, candidate_findings: [{ ...finding("new finding"), status: "novel_fp", covered_golden_indices: [], tp_fp_justification: "Synthetic judge response validates the file exchange only" }] }]);
    const evaluation = await importJudgeFiles({ trialRoot, snapshotRoot, judgeRoot, judgeRevision: "fixture-judge" });
    assert.equal(evaluation.judgments[0].kind, "false_positive");
    assert.equal(evaluation.findings[0].producer, "secret-treatment-name");
    await writeFile(join(judgeRoot, "results.json"), JSON.stringify({ pr_count: 0, eval_config: evalConfig }));
    await assert.rejects(() => importJudgeFiles({ trialRoot, snapshotRoot, judgeRoot, judgeRevision: "fixture-judge" }), /exactly this one trial/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
