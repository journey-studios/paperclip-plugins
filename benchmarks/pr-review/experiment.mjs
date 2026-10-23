import { digest, requireValue, validateScore } from "./score.mjs";

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-zA-Z0-9_.-]+$/;

export function randomFor(seed) {
  let state = Number.parseInt(digest(seed).slice(0, 8), 16);
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function shuffle(items, random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Plan only: no provider calls, GitHub writes, credentials, or execution of PR code. */
export function buildPlan(study, corpus) {
  requireValue(study.schemaVersion === 1 && corpus.schemaVersion === 1, "Unsupported schema version");
  requireValue(SHA.test(corpus.source?.revision), "Corpus source must be pinned to a commit");
  requireValue(Number.isInteger(study.repetitions) && study.repetitions >= 2, "Use at least two repetitions");
  requireValue(typeof study.seed === "string" && study.seed.length > 0, "Missing randomization seed");
  requireValue(Array.isArray(study.layers) && study.layers.length > 0, "Missing layers");
  requireValue(new Set(study.layers).size === study.layers.length, "Duplicate layers");
  requireValue(study.layers.every((layer) => ["triage", "thermo"].includes(layer)), "Unknown review layer");
  requireValue(study.treatments?.length >= 2 && study.treatments.length <= 3, "Compare two or three treatments");
  const treatmentIds = study.treatments.map((item) => item.id);
  requireValue(treatmentIds.every((id) => typeof id === "string" && ID.test(id)), "Invalid treatment id");
  requireValue(new Set(treatmentIds).size === treatmentIds.length, "Duplicate treatments");
  requireValue(treatmentIds.includes(study.baseline), "Unknown baseline");
  requireValue(treatmentIds.includes(study.primaryCandidate) && study.primaryCandidate !== study.baseline, "Preselect one primary candidate before the holdout");
  const treatmentPins = {};
  const unconfigured = [];
  for (const treatment of study.treatments) {
    for (const layer of study.layers) {
      const pins = treatment.pins?.[layer];
      const key = `${layer}/${treatment.id}`;
      if (!pins?.reviewerRevision || !pins?.effectiveModel || !pins?.configDigest) {
        unconfigured.push(key);
        continue;
      }
      requireValue(SHA.test(pins.reviewerRevision) || /^sha256:[a-f0-9]{64}$/.test(pins.reviewerRevision), "Reviewer revision must be a commit or image digest");
      requireValue(typeof pins.effectiveModel === "string" && /^[a-f0-9]{64}$/.test(pins.configDigest), "Invalid model/configuration pin");
      treatmentPins[key] = { reviewerRevision: pins.reviewerRevision, effectiveModel: pins.effectiveModel, configDigest: pins.configDigest };
    }
  }
  const policy = { minRecallGain: 0.05, precisionMargin: 0.02, ...study.policy };
  requireValue(Number.isFinite(policy.minRecallGain) && policy.minRecallGain > 0 && policy.minRecallGain <= 1, "Invalid minimum recall gain");
  requireValue(Number.isFinite(policy.precisionMargin) && policy.precisionMargin >= 0 && policy.precisionMargin <= 1, "Invalid precision margin");
  requireValue(corpus.cases.length > 0, "Empty corpus");
  requireValue(new Set(corpus.cases.map((item) => item.id)).size === corpus.cases.length, "Duplicate cases");
  const repositorySplits = new Map();
  for (const item of corpus.cases) {
    requireValue(typeof item.id === "string" && ID.test(item.id), "Invalid case id");
    requireValue(SHA.test(item.base) && SHA.test(item.head), "A case must pin base and head");
    requireValue(["development", "holdout"].includes(item.split), "Unknown corpus split");
    const previous = repositorySplits.get(item.repo);
    requireValue(!previous || previous === item.split, "A repository cannot cross development and holdout");
    repositorySplits.set(item.repo, item.split);
  }
  requireValue(["development", "holdout"].includes(study.split), "Select development or holdout explicitly");
  if (study.caseIds !== undefined) {
    requireValue(Array.isArray(study.caseIds) && study.caseIds.length > 0 && new Set(study.caseIds).size === study.caseIds.length, "Invalid canary case selection");
    requireValue(study.caseIds.every((id) => corpus.cases.some((item) => item.id === id && item.split === study.split)), "Canary cases must belong to the selected split");
  }
  const selected = corpus.cases.filter((item) => item.split === study.split && (!study.caseIds || study.caseIds.includes(item.id)));
  requireValue(selected.length > 0, "Selected split is empty");
  const jobs = [];
  const random = randomFor(study.seed);
  for (let repetition = 1; repetition <= study.repetitions; repetition += 1) {
    for (const item of shuffle(selected, random)) {
      for (const layer of study.layers) {
        for (const treatment of shuffle(study.treatments, random)) {
          jobs.push({
            id: `${layer}/${item.id}/${repetition}/${treatment.id}`,
            caseId: item.id,
            layer,
            treatment: treatment.id,
            repetition,
            repo: item.repo,
            number: item.number,
            base: item.base,
            head: item.head,
          });
        }
      }
    }
  }
  return {
    schemaVersion: 1,
    studyDigest: digest(study),
    corpusDigest: digest(corpus),
    experimentDigest: digest({ study, corpus }),
    sourceRevision: corpus.source.revision,
    split: study.split,
    baseline: study.baseline,
    primaryCandidate: study.primaryCandidate,
    policy,
    measurementDigest: study.measurementDigest,
    treatmentPins,
    ready: unconfigured.length === 0,
    unconfigured,
    treatments: treatmentIds,
    repetitions: study.repetitions,
    jobs,
  };
}

/** Completion includes failed slots; silently omitting a timeout would inflate the winner's score. */
export function validateResults(plan, results) {
  requireValue(plan.ready === true, "Pin every treatment's reviewer, effective model and configuration before collection");
  requireValue(Array.isArray(results), "Results must be an array");
  const byId = new Map();
  const expected = new Map(plan.jobs.map((job) => [job.id, job]));
  for (const result of results) {
    const job = expected.get(result.jobId);
    requireValue(job && !byId.has(result.jobId), "Unexpected or duplicate trial");
    requireValue(result.experimentDigest === plan.experimentDigest, "Experiment digest mismatch");
    requireValue(result.head === job.head, "Trial evaluated the wrong commit");
    requireValue(result.base === job.base, "Trial used the wrong diff base");
    requireValue(["live", "fixture"].includes(result.executionMode), "Missing execution mode");
    requireValue(["complete", "partial", "unknown"].includes(result.coverage), "Missing coverage status");
    requireValue(result.score?.goldDigest && result.score?.judgeRevision, "Missing scoring provenance");
    requireValue(["completed", "failed", "invalid"].includes(result.score.status), "Missing review status");
    validateScore(result.score);
    requireValue(Number.isFinite(result.durationMs) && result.durationMs >= 0, "Missing wall-clock duration");
    requireValue(result.costUsd === null || (Number.isFinite(result.costUsd) && result.costUsd >= 0), "Unknown cost must be null");
    requireValue(["provider", "estimated", "unknown", "subscription"].includes(result.costBasis), "Missing cost evidence");
    if (["unknown", "subscription"].includes(result.costBasis)) requireValue(result.costUsd === null, "Unpriced usage cannot be reported as free");
    requireValue(typeof result.reviewerRevision === "string" && result.reviewerRevision.length > 0, "Missing reviewer revision");
    requireValue(typeof result.effectiveModel === "string" && result.effectiveModel.length > 0, "Missing effective model");
    requireValue(typeof result.configDigest === "string" && result.configDigest.length > 0, "Missing configuration digest");
    const expectedPins = plan.treatmentPins[`${job.layer}/${job.treatment}`];
    requireValue(expectedPins && digest(expectedPins) === digest({ reviewerRevision: result.reviewerRevision, effectiveModel: result.effectiveModel, configDigest: result.configDigest }), "Treatment or effective model drifted from frozen pins");
    byId.set(result.jobId, { ...result, ...job });
  }
  requireValue(byId.size === expected.size, `Incomplete experiment: ${byId.size}/${expected.size} trials`);
  const gold = new Map();
  const treatments = new Map();
  let judgeRevision;
  for (const result of byId.values()) {
    if (judgeRevision) requireValue(result.score.judgeRevision === judgeRevision, "Judge changed during experiment");
    judgeRevision = result.score.judgeRevision;
    const goldFingerprint = digest([result.score.goldDigest, result.score.goldCount, result.score.severeCount]);
    const priorGold = gold.get(result.caseId);
    if (priorGold) requireValue(priorGold === goldFingerprint, "Gold changed between treatments");
    gold.set(result.caseId, goldFingerprint);
    const key = `${result.layer}/${result.treatment}`;
    const fingerprint = digest([result.reviewerRevision, result.effectiveModel, result.configDigest]);
    const prior = treatments.get(key);
    if (prior) requireValue(prior === fingerprint, "Treatment or effective model drifted between trials");
    treatments.set(key, fingerprint);
  }
  return [...byId.values()];
}
