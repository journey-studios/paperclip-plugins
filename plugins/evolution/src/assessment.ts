/** Observational guardrails only. Never infer causation or set `proven` here. */
export type AssessmentOutcome = "improved" | "regressed" | "inconclusive";
export type AssessmentMetric = {
  metricKey: string;
  baselineValue: number | null;
  currentValue: number | null;
  baselineSampleSize: number | null;
  currentSampleSize: number | null;
};
export type ObservationalAssessment = {
  outcome: AssessmentOutcome;
  confidence: "low" | "moderate";
  reasonCode: string;
  summary: string;
  baselineRunCount: number;
  currentRunCount: number;
  signals: { successRateDeltaPoints: number | null; durationChangePercent: number | null; overlappingChanges: number };
};

const MIN_RUNS = 10;
const MIN_HOURS = 24;

export function assessChangeMetrics(
  rows: AssessmentMetric[],
  appliedAt: string,
  evaluatedAt: string,
  overlappingChanges: number,
): ObservationalAssessment {
  const metrics = new Map(rows.map((row) => [row.metricKey, row]));
  const rate = metrics.get("run_success_rate");
  const duration = metrics.get("avg_run_duration");
  const baselineRunCount = Number(rate?.baselineSampleSize ?? 0);
  const currentRunCount = Number(rate?.currentSampleSize ?? 0);
  const hours = (Date.parse(evaluatedAt) - Date.parse(appliedAt)) / 3_600_000;
  const rateDelta = rate?.baselineValue == null || rate.currentValue == null
    ? null : rate.currentValue - rate.baselineValue;
  const durationChange = duration?.baselineValue != null && duration.baselineValue > 0 && duration.currentValue != null
    ? 100 * (duration.currentValue - duration.baselineValue) / duration.baselineValue : null;
  const signals = {
    successRateDeltaPoints: rateDelta,
    durationChangePercent: durationChange,
    overlappingChanges,
  };
  const result = (outcome: AssessmentOutcome, reasonCode: string, summary: string, confidence: "low" | "moderate" = "low"): ObservationalAssessment => ({
    outcome, confidence, reasonCode, summary, baselineRunCount, currentRunCount, signals,
  });
  if (overlappingChanges > 0) {
    return result("inconclusive", "overlapping_changes", "Other recorded agent changes overlap the observation window; attribution is not reliable.");
  }
  if (!Number.isFinite(hours) || hours < MIN_HOURS || baselineRunCount < MIN_RUNS || currentRunCount < MIN_RUNS || rateDelta == null) {
    return result("inconclusive", "insufficient_observation", "At least 24 hours and 10 runs in each window are required for an observational comparison.");
  }
  // Compare per-run success and mean duration, not total spend across unequal windows.
  const reliabilityUp = rateDelta >= 10;
  const reliabilityDown = rateDelta <= -10;
  const durationSampled = (duration?.baselineSampleSize ?? 0) >= MIN_RUNS && (duration?.currentSampleSize ?? 0) >= MIN_RUNS;
  const speedUp = durationSampled && durationChange != null && durationChange <= -20 && rateDelta >= -3;
  const speedDown = durationSampled && durationChange != null && durationChange >= 25;
  const positive = reliabilityUp || speedUp;
  const negative = reliabilityDown || speedDown;
  if (positive && negative) {
    return result("inconclusive", "mixed_signals", "Observed improvements and regressions conflict; a controlled evaluation is needed.");
  }
  const confidence: "low" | "moderate" = baselineRunCount >= 30 && currentRunCount >= 30 && hours >= 72
    ? "moderate" : "low";
  if (positive) {
    return result("improved", "positive_observation", "The measured run success rate or duration improved; this is an association, not causal proof.", confidence);
  }
  if (negative) {
    return result("regressed", "negative_observation", "The measured run success rate or duration regressed; this is an association, not causal proof.", confidence);
  }
  return result("inconclusive", "no_clear_signal", "No consistent material change was detected at the configured observational thresholds.", confidence);
}
