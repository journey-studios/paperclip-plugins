import { createHash } from "node:crypto";

export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const severe = new Set(["blocker", "major", "high", "critical"]);

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function ratio(numerator, denominator) {
  if (denominator === 0) return null;
  return numerator / denominator;
}

function indexed(items, name) {
  requireValue(Array.isArray(items), `${name} must be an array`);
  const result = new Map();
  for (const item of items) {
    requireValue(typeof item.id === "string" && item.id.length > 0, `${name}: missing id`);
    requireValue(!result.has(item.id), `${name}: duplicate id ${item.id}`);
    result.set(item.id, item);
  }
  return result;
}

/** Matching is an explicit, auditable input; line proximity cannot establish the same defect. */
export function scoreTrial({ gold, findings, judgments, status = "completed", provenance }) {
  requireValue(["completed", "failed", "invalid"].includes(status), "Invalid trial status");
  requireValue(provenance?.goldDigest === digest(gold), "Gold digest mismatch");
  requireValue(provenance?.findingsDigest === digest(findings), "Findings digest mismatch");
  requireValue(typeof provenance?.judgeRevision === "string" && provenance.judgeRevision.length > 0, "Missing judge revision");
  const goldById = indexed(gold, "gold");
  for (const item of gold) {
    requireValue(["blocker", "major", "minor", "nit", "critical", "high", "medium", "low"].includes(item.severity), "Gold needs a known severity");
  }
  const findingById = indexed(findings, "findings");
  requireValue(Array.isArray(judgments), "judgments must be an array");
  if (status !== "completed") {
    requireValue(findings.length === 0 && judgments.length === 0, "Failed reviews cannot contribute findings");
  }

  const seenFindings = new Set();
  const covered = new Set();
  let falsePositives = 0;
  let novel = 0;
  let duplicates = 0;
  let unresolved = 0;
  for (const judgment of judgments) {
    requireValue(findingById.has(judgment.findingId), "Judgment refers to an unknown finding");
    requireValue(!seenFindings.has(judgment.findingId), "A finding may be judged only once");
    requireValue(typeof judgment.evidence === "string" && judgment.evidence.trim().length > 0, "Every judgment needs evidence");
    seenFindings.add(judgment.findingId);
    if (judgment.kind === "match") {
      requireValue(goldById.has(judgment.goldId), "Match refers to an unknown gold issue");
      requireValue(!covered.has(judgment.goldId), "One gold issue cannot earn duplicate credit");
      covered.add(judgment.goldId);
      continue;
    }
    if (judgment.kind === "novel_valid") {
      novel += 1;
      continue;
    }
    if (judgment.kind === "false_positive") {
      falsePositives += 1;
      continue;
    }
    if (judgment.kind === "duplicate") {
      requireValue(findingById.has(judgment.duplicateOf) && judgment.duplicateOf !== judgment.findingId, "Duplicate needs another finding");
      const original = judgments.find((j) => j.findingId === judgment.duplicateOf);
      requireValue(original && ["match", "novel_valid"].includes(original.kind), "Duplicate must refer to a confirmed valid finding");
      duplicates += 1;
      continue;
    }
    requireValue(judgment.kind === "unresolved", "Unknown judgment kind");
    unresolved += 1;
  }
  unresolved += findings.length - seenFindings.size;
  const severeGold = gold.filter((item) => severe.has(item.severity));
  const severeMatched = severeGold.filter((item) => covered.has(item.id)).length;
  const confirmed = covered.size + novel;
  return {
    status,
    goldCount: gold.length,
    knownFound: covered.size,
    knownMissed: gold.length - covered.size,
    knownRecall: ratio(covered.size, gold.length),
    groundedPrecision: ratio(covered.size, findings.length),
    adjudicatedPrecision: ratio(confirmed, confirmed + falsePositives),
    severeCount: severeGold.length,
    severeFound: severeMatched,
    severeRecall: ratio(severeMatched, severeGold.length),
    falsePositives,
    novel,
    duplicates,
    unresolved,
    findingCount: findings.length,
    fullyAdjudicated: unresolved === 0,
    // A larger denominator discovered by one treatment must not change another treatment's recall.
    goldDigest: provenance.goldDigest,
    judgeRevision: provenance.judgeRevision,
  };
}

export function validateScore(score) {
  for (const key of ["goldCount", "knownFound", "knownMissed", "severeCount", "severeFound", "falsePositives", "novel", "duplicates", "unresolved", "findingCount"]) {
    requireValue(Number.isInteger(score[key]) && score[key] >= 0, `Invalid score count: ${key}`);
  }
  requireValue(score.knownFound + score.knownMissed === score.goldCount, "Inconsistent gold counts");
  requireValue(score.severeFound <= score.severeCount && score.severeCount <= score.goldCount && score.severeFound <= score.knownFound, "Inconsistent severe counts");
  requireValue(score.knownFound + score.falsePositives + score.novel + score.duplicates + score.unresolved === score.findingCount, "Inconsistent finding counts");
  requireValue(score.knownRecall === ratio(score.knownFound, score.goldCount), "Inconsistent recall");
  requireValue(score.severeRecall === ratio(score.severeFound, score.severeCount), "Inconsistent severe recall");
  const confirmed = score.knownFound + score.novel;
  requireValue(score.adjudicatedPrecision === ratio(confirmed, confirmed + score.falsePositives), "Inconsistent precision");
  if (score.status !== "completed") requireValue(score.findingCount === 0, "Failed trial has findings");
}
