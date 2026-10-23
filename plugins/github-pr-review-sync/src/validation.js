const STATES = new Set(["pass", "fail", "partial"]);

/** Optional v1 extension: old or malformed evidence still permits a comment, never an approval. */
export function parseValidation(raw) {
  if (!raw || typeof raw !== "object" || !/^[0-9a-f]{40}$/.test(raw.headSha)) return null;
  if (!["complete", "partial"].includes(raw.coverage)) return null;
  const tests = raw.tests;
  if (!tests || !STATES.has(tests.status) || !["ci", "static", "not_run"].includes(tests.source)) return null;
  if (!Array.isArray(tests.checks) || tests.checks.length > 30) return null;
  if (tests.checks.some((name) => typeof name !== "string" || !name || name.length > 200)) return null;
  return { headSha: raw.headSha, coverage: raw.coverage, tests: { status: tests.status, source: tests.source, checks: [...new Set(tests.checks)] } };
}

/** A model's PASS is a claim; successful check names are read from GitHub for this exact commit. */
export function assessValidation(verdict, evidence) {
  const validation = verdict.validation;
  let ci = "PARTIAL";
  if (evidence?.headSha === verdict.headSha && STATES.has(evidence.status)) ci = evidence.status.toUpperCase();
  const successful = new Set(evidence?.successfulChecks ?? []);
  const verifiedTests = validation?.headSha === verdict.headSha &&
    validation.tests.status === "pass" && validation.tests.source === "ci" &&
    validation.tests.checks.length > 0 && validation.tests.checks.every((name) => successful.has(name));
  const complete = validation?.headSha === verdict.headSha && validation.coverage === "complete";
  let testsLabel = "PARTIAL (no verified successful test execution at this commit)";
  if (verifiedTests && ci === "PASS") testsLabel = "PASS (referenced CI checks succeeded)";
  let coverageLabel = "PARTIAL or not reported";
  if (complete) coverageLabel = "complete, reported by reviewer";
  return {
    canApprove: ci === "PASS" && verifiedTests && complete,
    lines: [
      `CI at reviewed commit: ${ci} (checked independently by the publisher).`,
      `Test execution: ${testsLabel}.`,
      `Code review coverage: ${coverageLabel}.`,
    ],
  };
}
