import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readJson, writeJson } from "./io.mjs";
import { importJudgments } from "./judgments.mjs";
import { digest, requireValue } from "./score.mjs";

/** A separate one-PR directory per trial prevents the upstream loader merging repetitions. */
export async function exportJudgeInput(trialRoot, snapshotRoot, output) {
  const trial = await readJson(join(trialRoot, "trial.json"));
  requireValue(trial.status === "completed", "Only completed reviews need model adjudication");
  const candidate = await readJson(join(trialRoot, "candidate.json"));
  requireValue(digest(candidate) === trial.candidateDigest, "Candidate changed before judging");
  const { reference, referenceText, gold } = await readJson(join(snapshotRoot, "reference.json"));
  const snapshot = await readJson(join(snapshotRoot, "snapshot.json"));
  requireValue(digest(snapshot) === trial.snapshotDigest && digest(gold) === trial.goldDigest && digest(reference) === snapshot.referenceDigest, "Reference changed before judging");
  const root = resolve(output);
  await mkdir(root, { recursive: false });
  await mkdir(join(root, "golden"));
  await writeFile(join(root, "golden", `${reference.pr_key}.json`), referenceText, { flag: "wx" });
  await writeJson(join(root, "candidate.json"), { pr: candidate.pr, findings: candidate.findings.map((item) => ({ ...item, producer: "candidate" })) });
  const metadata = await readJson(join(snapshotRoot, "pr/pr.json"));
  await writeJson(join(root, "manifest.json"), [metadata]);
  return {
    candidateDigest: trial.candidateDigest, goldDigest: trial.goldDigest,
    args: ["--candidate", join(root, "candidate.json"), "--golden", join(root, "golden"), "--manifest", join(root, "manifest.json"), "--snapshot-dir", resolve(snapshotRoot, "repo"), "--output", join(root, "results.json"), "--concurrency", "1"],
    instruction: "Run the pinned ReviewBench judge with these arguments, one frozen provider/model, a model-only network, and a separate call/token cap. Never pass --ingest.",
  };
}

export async function importJudgeFiles({ trialRoot, snapshotRoot, judgeRoot, judgeRevision, evidence }) {
  const candidate = await readJson(join(trialRoot, "candidate.json"));
  const reference = await readJson(join(snapshotRoot, "reference.json"));
  const result = await readJson(join(judgeRoot, "results.json"));
  const details = await readJson(join(judgeRoot, "results.details.json"));
  requireValue(result.pr_count === 1 && Array.isArray(details) && details.length === 1, "Judge must evaluate exactly this one trial");
  return importJudgments({ candidate, ...reference, details: details[0], evalConfig: result.eval_config, judgeRevision, evidence });
}
