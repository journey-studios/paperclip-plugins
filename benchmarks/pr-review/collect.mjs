import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateResults } from "./experiment.mjs";
import { readJson } from "./io.mjs";
import { digest, requireValue, scoreTrial } from "./score.mjs";
import { measurementFingerprint } from "./fingerprint.mjs";

/** Every scheduled slot is required, including failures. Scoring never drops inconvenient trials. */
export async function collect(plan, runs, snapshots, evaluations) {
  requireValue(plan.measurementDigest === await measurementFingerprint(), "Use the measurement source frozen in this experiment");
  const judge = await readJson(join(evaluations, "judge.json"));
  requireValue(typeof judge.judgeRevision === "string" && judge.judgeRevision.length > 0, "Missing frozen judge identity");
  const results = [];
  for (const job of plan.jobs) {
    const root = join(runs, ...job.id.split("/"));
    const trial = await readJson(join(root, "trial.json"));
    const snapshot = await readJson(join(snapshots, job.caseId, "snapshot.json"));
    const reference = await readJson(join(snapshots, job.caseId, "reference.json"));
    requireValue(digest(snapshot) === trial.snapshotDigest && snapshot.corpusDigest === plan.corpusDigest, "Snapshot provenance changed");
    requireValue(digest(reference.reference) === snapshot.referenceDigest && digest(reference.gold) === trial.goldDigest, "Reference labels changed");
    let journal = "";
    if (trial.usage?.attempts > 0) {
      journal = await readFile(join(root, "gateway/requests.jsonl"), "utf8");
    }
    requireValue(digest(journal) === trial.gatewayJournalDigest, "Usage journal changed");
    let evaluation = { gold: reference.gold, findings: [], judgments: [], provenance: { goldDigest: digest(reference.gold), findingsDigest: digest([]), judgeRevision: judge.judgeRevision } };
    if (trial.status === "completed") {
      const candidate = await readJson(join(root, "candidate.json"));
      requireValue(digest(candidate) === trial.candidateDigest, "Candidate findings changed after execution");
      if (candidate.findings.length > 0) {
        evaluation = await readJson(join(evaluations, ...job.id.split("/"), "evaluation.json"));
        requireValue(evaluation.provenance?.judgeRevision === judge.judgeRevision, "Judge configuration changed");
        requireValue(digest(evaluation.gold) === trial.goldDigest, "Judge used different labels");
        const compared = evaluation.findings.map(({ id: _id, ...item }) => item);
        requireValue(digest(compared) === digest(candidate.findings), "Judge used different candidate findings");
      }
    }
    results.push({ ...trial, score: scoreTrial({ ...evaluation, status: trial.status }) });
  }
  validateResults(plan, results);
  return results;
}
