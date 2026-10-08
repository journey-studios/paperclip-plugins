import { describe, expect, it } from "vitest";
import { assessChangeMetrics, type AssessmentMetric } from "../src/assessment.js";

const applied = "2026-10-01T00:00:00Z";
const evaluated = "2026-10-05T00:00:00Z";
function metrics(successBefore: number, successAfter: number, durationBefore = 100, durationAfter = 100, runs = 40): AssessmentMetric[] {
  return [
    { metricKey: "run_success_rate", baselineValue: successBefore, currentValue: successAfter, baselineSampleSize: runs, currentSampleSize: runs },
    { metricKey: "avg_run_duration", baselineValue: durationBefore, currentValue: durationAfter, baselineSampleSize: runs, currentSampleSize: runs },
  ];
}
describe("Org Tracker advisory evaluator", () => {
  it("finds an observed quality improvement without claiming validated causality", () => {
    expect(assessChangeMetrics(metrics(70, 90), applied, evaluated, 0)).toMatchObject({
      outcome: "improved", reasonCode: "positive_observation", confidence: "moderate",
    });
  });
  it("detects a quality regression", () => {
    expect(assessChangeMetrics(metrics(90, 60), applied, evaluated, 0).outcome).toBe("regressed");
  });
  it("does not treat conflicting speed and quality as improvement", () => {
    expect(assessChangeMetrics(metrics(70, 95, 100, 150), applied, evaluated, 0).reasonCode).toBe("mixed_signals");
  });
  it("requires enough observations and time", () => {
    expect(assessChangeMetrics(metrics(70, 95, 100, 50, 9), applied, evaluated, 0).reasonCode).toBe("insufficient_observation");
    expect(assessChangeMetrics(metrics(70, 95), applied, "2026-10-01T03:00:00Z", 0).outcome).toBe("inconclusive");
  });
  it("treats other agent changes during the evaluation window as confounders", () => {
    expect(assessChangeMetrics(metrics(70, 95), applied, evaluated, 1).reasonCode).toBe("overlapping_changes");
  });
  it("does not infer a win from lower total cost without quality evidence", () => {
    expect(assessChangeMetrics(metrics(75, 78), applied, evaluated, 0).outcome).toBe("inconclusive");
  });
});
