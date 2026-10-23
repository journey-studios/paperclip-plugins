import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collect } from "./collect.mjs";
import { compareTreatments } from "./compare.mjs";
import { buildPlan } from "./experiment.mjs";
import { measurementFingerprint } from "./fingerprint.mjs";
import { command, readJson, writeJson } from "./io.mjs";
import { identifiedFindings } from "./judgments.mjs";
import { runPlan } from "./run.mjs";
import { adapterDir, configureStudy } from "./runtime.mjs";
import { digest, requireValue } from "./score.mjs";

/** Eighteen isolated real-engine trials against a fake model; never a quality or cost leaderboard. */
export async function canary(options, snapshots, output) {
  const corpus = await readJson(fileURLToPath(new URL("./corpus.json", import.meta.url)));
  const selected = corpus.cases.find((item) => item.id === options.caseId && item.split === "development");
  requireValue(selected, "Choose one development PR for the canary");
  const root = resolve(output);
  await mkdir(root, { recursive: false });
  const snapshot = await readJson(join(snapshots, selected.id, "snapshot.json"));
  await writeJson(join(root, "fixture.json"), { repo: selected.repo.slice("https://github.com/".length), number: selected.number, head: selected.head, file: snapshot.changedPaths[0] });
  await chmod(join(root, "fixture.json"), 0o644);
  const id = `rb-fixture-${randomUUID()}`;
  const backend = `${id}-backend`;
  const gateway = { image: options.triageImage, network: id, upstream: "http://fixture-backend:8081/v1", requestModel: "fixture-model", effectiveModel: "fixture-model", maxRequests: 3, maxOutputTokens: 4096, maxInputBytes: 2_000_000, timeoutSeconds: 15, costBasis: "unknown" };
  const profiles = {};
  for (const [index, treatment] of ["baseline", "candidate-a", "candidate-b"].entries()) {
    profiles[`triage/${treatment}`] = { image: options.triageImage, user: "10001:10001", timeoutSeconds: 120, gateway, reviewer: { requestModel: "fixture-model", settings: { "CONFIG.MAX_MODEL_TOKENS": [32000, 64000, 128000][index], "CONFIG.CUSTOM_MODEL_MAX_TOKENS": 200000, "CONFIG.AI_TIMEOUT": 30 } } };
    profiles[`thermo/${treatment}`] = { image: options.thermoImage, user: "1000:1000", timeoutSeconds: 120, gateway, reviewer: { requestModel: "fixture-model", instructions: options.instructions, deliveryInstructions: "Return one paperclip-review-verdict JSON block with v=1, repo, number, headSha, outcome, findings; each finding needs severity, path, line and message.", cliVersion: options.cliVersion, modelLimit: { context: 200000, output: 4096 } } };
  }
  const study = await configureStudy({ schemaVersion: 1, id: "fixture-replay-only", seed: "fixture-replay-only", repetitions: 3, split: "development", layers: ["triage", "thermo"], caseIds: [selected.id], treatments: ["baseline", "candidate-a", "candidate-b"].map((id) => ({ id })), baseline: "baseline", primaryCandidate: "candidate-a", measurementDigest: await measurementFingerprint() }, { profiles });
  const plan = buildPlan(study, corpus);
  const previousKey = process.env.RB_GATEWAY_KEY;
  try {
    await command("docker", ["network", "create", "--internal", id]);
    await command("docker", ["run", "--detach", "--pull", "never", "--name", backend, "--network", id, "--network-alias", "fixture-backend", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--memory", "128m", "--pids-limit", "64", "--user", "10001:10001", "--mount", `type=bind,src=${root},dst=/fixtures,readonly`, "--mount", `type=bind,src=${adapterDir},dst=/bench,readonly`, "--entrypoint", "python", options.triageImage, "/bench/fixture-model.py"]);
    process.env.RB_GATEWAY_KEY = "fixture-only-no-provider-credential";
    const run = await runPlan(plan, { executionMode: "fixture", maxTrials: 18, profiles }, snapshots, join(root, "runs"));
    const judgeRevision = digest("synthetic-judge-no-adjudication");
    const evaluations = join(root, "evaluations");
    await mkdir(evaluations);
    await writeJson(join(evaluations, "judge.json"), { judgeRevision });
    for (const job of plan.jobs) {
      const trialRoot = join(root, "runs", ...job.id.split("/"));
      const trial = await readJson(join(trialRoot, "trial.json"));
      if (trial.status !== "completed") continue;
      const candidate = await readJson(join(trialRoot, "candidate.json"));
      const { gold } = await readJson(join(snapshots, selected.id, "reference.json"));
      const findings = identifiedFindings(candidate);
      const dir = join(evaluations, ...job.id.split("/"));
      await mkdir(dir, { recursive: true });
      await writeJson(join(dir, "evaluation.json"), { gold, findings, judgments: findings.map(({ id }) => ({ findingId: id, kind: "unresolved", evidence: "Synthetic model output validates plumbing; no semantic adjudication was performed" })), provenance: { goldDigest: digest(gold), findingsDigest: digest(findings), judgeRevision } });
    }
    const scored = await collect(plan, join(root, "runs"), snapshots, evaluations);
    const comparison = compareTreatments(plan, scored);
    await writeJson(join(root, "scored.json"), scored);
    await writeJson(join(root, "comparison.json"), comparison);
    const passed = run.recorded === 18 && run.statuses.every((item) => item.status === "completed") && comparison.comparisons.every((item) => !item.qualityImprovementEstablished);
    const report = { mode: "fixture", passed, ...run, comparisonFile: join(root, "comparison.json"), warning: "Synthetic backend; no reviewer-quality or real inference-cost claim" };
    await writeJson(join(root, "canary.json"), report);
    requireValue(passed, `Canary failed; inspect ${join(root, "canary.json")}`);
    return report;
  } finally {
    if (previousKey === undefined) delete process.env.RB_GATEWAY_KEY;
    else process.env.RB_GATEWAY_KEY = previousKey;
    await command("docker", ["rm", "--force", backend]).catch(() => {});
    await command("docker", ["network", "rm", id]).catch(() => {});
  }
}
