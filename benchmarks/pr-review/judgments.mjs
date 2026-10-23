import { digest, requireValue } from "./score.mjs";
import { importReviewBenchGold } from "./normalize.mjs";
import { judgeFingerprint } from "./judge-overlay.mjs";
import { createHash } from "node:crypto";

const identity = ({ file, start_line, end_line, message }) => digest([file, start_line, end_line, message]);

export function identifiedFindings(candidate) {
  return candidate.findings.map((item, index) => ({ ...item, id: digest([index, identity(item)]) }));
}

/** Upstream details omit the judge's rationale: never invent evidence for novel/false findings. */
export function importJudgments({ candidate, reference, referenceText, details, evalConfig, judgeRevision, evidence = {} }) {
  requireValue(digest(candidate.pr) === digest(reference.pr), "Candidate/reference snapshot mismatch");
  requireValue(details.pr_key === reference.pr_key, "Judge details belong to another PR");
  requireValue(typeof judgeRevision === "string" && judgeRevision.length > 0, "Missing judge revision");
  for (const key of ["classifier_model", "classifier_prompt_hash", "matcher_model", "matcher_prompt_hash", "golden_hash"]) {
    requireValue(typeof evalConfig?.[key] === "string" && evalConfig[key].length > 0, `Missing judge fingerprint: ${key}`);
  }
  requireValue(!evalConfig.excluded_producers?.length, "Producer exclusions would change this experiment's reference denominator");
  requireValue(typeof referenceText === "string" && digest(JSON.parse(referenceText)) === digest(reference), "Missing exact reference text");
  requireValue(createHash("sha256").update(referenceText).digest("hex") === evalConfig.golden_hash, "Judge used different reference bytes");
  const gold = importReviewBenchGold(reference, candidate.pr);
  const findings = identifiedFindings(candidate);
  requireValue(details.candidate_findings?.length === findings.length, "Judge omitted findings");
  const claimed = new Map();
  const judgments = findings.map((finding, index) => {
    const item = details.candidate_findings[index];
    requireValue(identity(item) === identity(finding), "Judge candidate order/content mismatch");
    const result = { findingId: finding.id, kind: "unresolved", evidence: "Upstream details omit supporting rationale; evidence review pending" };
    const coverage = item.covered_golden_indices ?? [];
    requireValue(coverage.every((i) => Number.isInteger(i) && i >= 0 && i < reference.findings.length), "Invalid golden index");
    // The upstream matcher allows one comment to cover multiple defects; this scorer gives one-to-one credit.
    if (coverage.length > 1) {
      return { ...result, evidence: "Matcher returned multiple reference defects; split/adjudicate before one-to-one scoring" };
    }
    const matched = item.matched_golden_index ?? coverage[0];
    if (matched !== undefined) {
      requireValue(Number.isInteger(matched) && matched >= 0 && matched < reference.findings.length, "Invalid matched index");
      const raw = reference.findings[matched];
      if (raw.tp_fp === "tp") {
        const label = importReviewBenchGold({ pr: reference.pr, findings: [raw] }, candidate.pr)[0];
        const prior = claimed.get(label.id);
        if (prior) {
          return { findingId: finding.id, kind: "duplicate", duplicateOf: prior, evidence: `Semantic matcher assigned the same reference defect ${label.id}` };
        }
        claimed.set(label.id, finding.id);
        return { findingId: finding.id, kind: "match", goldId: label.id, evidence: `Pinned semantic matcher correspondence to reference ${label.id}` };
      }
    }
    const proof = evidence[finding.id];
    if (proof) {
      requireValue(["novel_valid", "false_positive", "unresolved", "duplicate"].includes(proof.kind) && typeof proof.evidence === "string" && proof.evidence.trim(), "Invalid adjudication evidence");
      return { ...proof, findingId: finding.id };
    }
    if (typeof item.tp_fp_justification === "string" && item.tp_fp_justification.trim() && ["novel_tp", "novel_fp"].includes(item.status)) {
      let kind = "false_positive";
      if (item.status === "novel_tp") {
        kind = "novel_valid";
      }
      return { findingId: finding.id, kind, evidence: item.tp_fp_justification };
    }
    return result;
  });
  return {
    gold, findings, judgments,
    provenance: { goldDigest: digest(gold), findingsDigest: digest(findings), judgeRevision: judgeFingerprint(judgeRevision, evalConfig) },
  };
}
