import { randomFor, validateResults } from "./experiment.mjs";
import { ratio, requireValue } from "./score.mjs";

function mean(items) {
  if (items.length === 0) return null;
  return items.reduce((sum, value) => sum + value, 0) / items.length;
}
function percentile(items, fraction) {
  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summary(rows) {
  const sum = (key) => rows.reduce((total, row) => total + row.score[key], 0);
  const completeCosts = rows.every((row) => row.costUsd !== null);
  let costUsd = null;
  if (completeCosts) costUsd = rows.reduce((total, row) => total + row.costUsd, 0);
  const confirmed = sum("knownFound") + sum("novel");
  const perCase = new Map();
  for (const row of rows) {
    if (row.score.knownRecall === null) continue;
    const values = perCase.get(row.caseId) ?? [];
    values.push(row.score.knownRecall);
    perCase.set(row.caseId, values);
  }
  const deviations = [...perCase.values()].map((values) => {
    const average = mean(values);
    return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
  });
  let withinPrRecallStdDev = null;
  if (deviations.length > 0) withinPrRecallStdDev = mean(deviations);
  return {
    trials: rows.length,
    successRate: rows.filter((row) => row.score.status === "completed").length / rows.length,
    knownRecall: ratio(sum("knownFound"), sum("goldCount")),
    macroKnownRecall: mean([...perCase.values()].map((values) => mean(values))),
    severeRecall: ratio(sum("severeFound"), sum("severeCount")),
    adjudicatedPrecision: ratio(confirmed, confirmed + sum("falsePositives")),
    falsePositivesPerPr: sum("falsePositives") / rows.length,
    duplicatesPerPr: sum("duplicates") / rows.length,
    unresolved: sum("unresolved"),
    p50Ms: percentile(rows.map((row) => row.durationMs), 0.5),
    p95Ms: percentile(rows.map((row) => row.durationMs), 0.95),
    costUsd,
    costKnown: completeCosts,
    costBasis: [...new Set(rows.map((row) => row.costBasis))],
    withinPrRecallStdDev,
    coverage: Object.fromEntries(["complete", "partial", "unknown"].map((status) => [status, rows.filter((row) => row.coverage === status).length])),
  };
}

/** Repetitions share a PR: resample PR clusters, not individual calls, to avoid pseudoreplication. */
export function pairedRecallInterval(baseline, candidate, seed, samples = 5000) {
  const byCase = (rows) => {
    const result = new Map();
    for (const row of rows) {
      if (row.score.knownRecall === null) continue;
      const list = result.get(row.caseId) ?? [];
      list.push(row.score.knownRecall);
      result.set(row.caseId, list);
    }
    return result;
  };
  const base = byCase(baseline);
  const next = byCase(candidate);
  const deltas = [...base].map(([id, values]) => mean(next.get(id)) - mean(values));
  if (deltas.length < 2) return { delta: deltas[0] ?? null, lower: null, upper: null, cases: deltas.length };
  const random = randomFor(seed);
  const means = [];
  for (let i = 0; i < samples; i += 1) {
    let total = 0;
    for (let j = 0; j < deltas.length; j += 1) total += deltas[Math.floor(random() * deltas.length)];
    means.push(total / deltas.length);
  }
  return { delta: mean(deltas), lower: percentile(means, 0.025), upper: percentile(means, 0.975), cases: deltas.length };
}

export function compareTreatments(plan, results) {
  const { minRecallGain, precisionMargin } = plan.policy ?? {};
  const seed = plan.experimentDigest;
  requireValue(Number.isFinite(minRecallGain) && minRecallGain > 0 && minRecallGain <= 1, "Invalid minimum recall gain");
  requireValue(Number.isFinite(precisionMargin) && precisionMargin >= 0 && precisionMargin <= 1, "Invalid precision margin");
  const rows = validateResults(plan, results);
  const comparisons = [];
  for (const layer of new Set(rows.map((row) => row.layer))) {
    const baselineRows = rows.filter((row) => row.layer === layer && row.treatment === plan.baseline);
    const baseline = summary(baselineRows);
    for (const treatment of plan.treatments) {
      if (treatment === plan.baseline) continue;
      const candidateRows = rows.filter((row) => row.layer === layer && row.treatment === treatment);
      const candidate = summary(candidateRows);
      const recall = pairedRecallInterval(baselineRows, candidateRows, `${seed}/${layer}/${treatment}`);
      const reasons = [];
      if ([...baselineRows, ...candidateRows].some((row) => row.executionMode !== "live")) reasons.push("Fixture trials validate the benchmark, not reviewer quality");
      if (baseline.coverage.unknown + candidate.coverage.unknown > 0) reasons.push("Review coverage was not measured");
      if (treatment !== plan.primaryCandidate) reasons.push("Exploratory treatment; primary candidate must be chosen before the holdout");
      if (plan.split !== "holdout") reasons.push("Development results cannot establish a held-out improvement");
      if (recall.cases < 10) reasons.push("Pilot has fewer than ten independent PRs; collect more held-out cases");
      if (baseline.unresolved + candidate.unresolved > 0) reasons.push("Unresolved findings remain");
      if (recall.lower === null || recall.lower <= 0 || recall.delta < minRecallGain) reasons.push("Recall improvement is not established");
      if (baseline.adjudicatedPrecision === null || candidate.adjudicatedPrecision === null || candidate.adjudicatedPrecision < baseline.adjudicatedPrecision - precisionMargin) reasons.push("Precision non-regression is not established");
      if (baseline.severeRecall !== null && (candidate.severeRecall === null || candidate.severeRecall < baseline.severeRecall)) reasons.push("Severe-issue recall regressed");
      if (candidate.successRate < baseline.successRate) reasons.push("Completion rate regressed");
      if (candidate.duplicatesPerPr > baseline.duplicatesPerPr) reasons.push("Duplicate-comment noise increased");
      comparisons.push({ layer, treatment, baseline, candidate, pairedRecall95: recall, qualityImprovementEstablished: reasons.length === 0, reasons });
    }
  }
  return { experimentDigest: plan.experimentDigest, policy: plan.policy, comparisons };
}
