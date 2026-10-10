export type QualitySkill = { key: string; versionId: string | null; versionBasis?: "pinned" | "catalog" | "unknown"; contentFingerprint?: string | null; exposure?: "selected" | "unknown"; usage?: "unknown" | string };
export type QualityCohort = {
  key: string; agentId: string; rubric: string; contributionRole: string; reviewerType: string;
  role: string | null; reportsTo: string | null; score: number | null; assessedDeliveries: number | null; reviewCount: number | null; reviewerCount: number | null;
  model: string | null; configuredModel: string | null; modelCoverage: string; adapterType: string | null; configRevisionId: string | null; instructionFingerprint: string | null;
  instructionCoverage: string; skillsContentCoverage: string; runtimeContextCoverage: string; promptDigest: string | null; instructionBundleDigest: string | null; mcpDigest: string | null;
  skills: QualitySkill[]; reviewerIds: string[]; distribution: { below50: number; from50to79: number; atLeast80: number } | null;
  hypotheses: Array<{ kind: string; status: string; occurrences: number }>;
  samples: Array<{ revisionId: string; evaluationId: string; workProductId: string; score: number; deliveredAt: string; feedbackHref: string }>;
};
export type Quality = {
  policy: string; companyId: string; environment: string; start: string; end: string; cohorts: QualityCohort[];
  coverage: { evaluationsReturned: number; limit: number; truncated: boolean; denominator: string; historicalCoverage: string;
    eligibleByAgent: Array<{ agentId: string; trackedExactRevisions: number; assessedDeliveries: number }>; notes?: string[] };
  samples: Array<{ id: string; companyId: string; issueId: string; revisionId: string; workProductId: string; agentId: string; rubric: string; score: number; deliveredAt: string | null; reviewerType: string; reviewerId: string; feedbackHref: string; controlledTestRef?: Record<string, unknown> | null; profileAvailable?: boolean }>;
  controlledPairs: Array<{
    agentId: string; rubric: string; contributionRole?: string; reviewerType: string; reviewerId: string; model: string | null; modelCoverage: string; role?: string | null;
    runtimeContextCoverage: string; promptDigest: string | null; instructionBundleDigest: string | null; mcpDigest: string | null;
    skillKey: string; baselineSkillVersionId: string; currentSkillVersionId: string;
    baselineExpectedSkillVersionId: string; currentExpectedSkillVersionId: string; baselineActualSkillVersionIds: Array<string | null>; currentActualSkillVersionIds: Array<string | null>;
    baselineSkillRevisionNumber: number | null; currentSkillRevisionNumber: number | null;
    baselineTestRunId: string | null; currentTestRunId: string | null; inputDigest: string; templateDigest: string; agentProfileDigest: string;
    baselineScore: number | null; currentScore: number | null; delta?: number; outcome: string; reason?: string; generalizesToProduction: false;
    baselineSamples: Array<{ evaluationId: string; revisionId: string; workProductId: string; testRunId: string; expectedSkillVersionId: string; actualSkillVersionId: string | null; actualSkillContentFingerprint: string | null; skillRevisionNumber: number | null; score: number; feedbackHref: string }>;
    currentSamples: Array<{ evaluationId: string; revisionId: string; workProductId: string; testRunId: string; expectedSkillVersionId: string; actualSkillVersionId: string | null; actualSkillContentFingerprint: string | null; skillRevisionNumber: number | null; score: number; feedbackHref: string }>;
  }>;
  notes: string[];
};
export function readDeliveryQuality(ctx: unknown, companyId: string, options: { start: string; end: string; agentId?: string | null; agentIds?: string[] | null; environment?: string }): Promise<Quality>;
export function summarizeDeliveryQuality(rows: unknown[], options?: { truncated?: boolean }): QualityCohort[];
export function compareDeliveryQuality(before: Quality, after: Quality, options?: { changedSkillKeys?: string[] }): Array<{
  agentId: string; rubric: string; contributionRole: string; reviewerType: string; reviewerIds: string[]; role: string | null; model: string | null; modelCoverage: string;
  runtimeContextCoverage: string; promptDigest: string | null; instructionBundleDigest: string | null; mcpDigest: string | null;
  skills: QualitySkill[]; baselineSkills: QualitySkill[]; currentSkills: QualitySkill[]; baselineScore: number | null; currentScore: number | null;
  baselineSample: number | null; currentSample: number | null; delta: number | null; outcome: string; reason: string; confounders: string[];
  baselineSamples: QualityCohort["samples"]; currentSamples: QualityCohort["samples"]; causality: string;
}>;
