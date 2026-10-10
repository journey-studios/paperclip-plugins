// Both plugins read the same immutable core records and use one selection policy.
const CAP = 5000;
const mean = values => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 100) / 100 : null;

function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") { try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null; } catch { return null; } }
  return null;
}

function otherSkillsCovered(cohort, targetKeys) {
  return cohort.skills.every(skill => targetKeys.includes(skill.key) ||
    (Boolean(skill.versionId) && skill.versionBasis !== "unknown" && Boolean(skill.contentFingerprint)));
}

function nativeContext(profile) {
  const context = asObject(profile?.nativeRuntimeContext) ?? {};
  return {
    runtimeContextCoverage: profile?.runtimeContextCoverage ?? "unknown",
    promptDigest: context.promptDigest ?? null,
    instructionBundleDigest: context.instructionBundleDigest ?? null,
    mcpDigest: context.mcpDigest ?? null,
  };
}

function hasVerifiedNativeContext(context) {
  return context.runtimeContextCoverage === "native_verified" && Boolean(context.promptDigest && context.instructionBundleDigest && context.mcpDigest);
}

function nativeSkillDigest(profile, skill) {
  const context = asObject(profile?.nativeRuntimeContext);
  return context?.skills?.find(item => item.key === skill.key && item.versionId === skill.versionId)?.bundleDigest ?? null;
}

export function pairControlledSkillTests(rows, { truncated = false } = {}) {
  if (truncated) return [];
  const tests = new Map();
  for (const row of rows) {
    const ref = asObject(row.controlledTestRef);
    if (!ref || !["testRunId", "inputDigest", "templateDigest", "skillKey", "skillVersionId", "agentProfileDigest"].every(key => typeof ref[key] === "string" && ref[key])) continue;
    const profile = asObject(row.executionProfile) ?? {};
    const context = nativeContext(profile);
    const targetSkill = profile.skills?.find(skill => skill.key === ref.skillKey);
    const targetSkillMatches = Boolean(targetSkill && targetSkill.exposure === "selected" && targetSkill.versionId === ref.skillVersionId);
    const actualSkillContentFingerprint = targetSkill?.contentFingerprint ?? (targetSkill ? nativeSkillDigest(profile, targetSkill) : null);
    const targetContentKnown = Boolean(targetSkillMatches && targetSkill.versionBasis && targetSkill.versionBasis !== "unknown" && actualSkillContentFingerprint);
    const key = JSON.stringify([row.agentId, row.rubric, row.contributionRole, row.reviewerType, row.reviewerId, profile.role ?? null, profile.reportsTo ?? null,
      profile.effectiveModel ?? null, profile.configuredModel ?? null, profile.modelCoverage ?? "unknown", profile.adapterType ?? null,
      profile.instructionCoverage ?? "unknown", profile.skillsContentCoverage ?? "unknown", context.runtimeContextCoverage, context.promptDigest, context.instructionBundleDigest, context.mcpDigest,
      ref.inputDigest, ref.templateDigest, ref.agentProfileDigest, ref.skillKey]);
    const group = tests.get(key) ?? { agentId: row.agentId, rubric: row.rubric, contributionRole: row.contributionRole, reviewerType: row.reviewerType, reviewerId: row.reviewerId,
      model: profile.effectiveModel ?? null, modelCoverage: profile.modelCoverage ?? "unknown", instructionCoverage: profile.instructionCoverage ?? "unknown",
      skillsContentCoverage: profile.skillsContentCoverage ?? "unknown", role: profile.role ?? null,
      ...context, skillKey: ref.skillKey, inputDigest: ref.inputDigest, templateDigest: ref.templateDigest, agentProfileDigest: ref.agentProfileDigest, versions: new Map() };
    const versionRuns = group.versions.get(ref.skillVersionId) ?? new Map();
    const run = versionRuns.get(ref.testRunId) ?? { scores: [], samples: [], targetSkillKnown: true, targetSkillMismatch: false, actualSkillVersions: new Set() };
    run.targetSkillKnown &&= targetContentKnown;
    run.targetSkillMismatch ||= !targetSkillMatches;
    run.actualSkillVersions.add(targetSkill?.versionId ?? null);
    run.scores.push(Number(row.score));
    run.samples.push({ evaluationId: row.id, revisionId: row.revisionId, workProductId: row.workProductId, testRunId: ref.testRunId, expectedSkillVersionId: ref.skillVersionId, actualSkillVersionId: targetSkill?.versionId ?? null, actualSkillContentFingerprint, skillRevisionNumber: Number.isInteger(ref.skillRevisionNumber) ? ref.skillRevisionNumber : null, score: Number(row.score),
      feedbackHref: `/api/companies/${row.companyId}/work-products/${row.workProductId}/evaluations?revisionId=${encodeURIComponent(row.revisionId)}&evaluationId=${encodeURIComponent(row.id)}` });
    versionRuns.set(ref.testRunId, run); group.versions.set(ref.skillVersionId, versionRuns); tests.set(key, group);
  }
  const result = [];
  for (const group of tests.values()) {
    const versions = [...group.versions.entries()];
    for (let i = 0; i < versions.length; i += 1) for (let j = i + 1; j < versions.length; j += 1) {
      const [versionA, runsA] = versions[i]; const [versionB, runsB] = versions[j];
      const runA = runsA.size === 1 ? [...runsA.values()][0] : null; const runB = runsB.size === 1 ? [...runsB.values()][0] : null;
      const referenceA = runA?.samples[0]; const referenceB = runB?.samples[0];
      const orderKnown = Number.isInteger(referenceA?.skillRevisionNumber) && Number.isInteger(referenceB?.skillRevisionNumber) && referenceA.skillRevisionNumber !== referenceB.skillRevisionNumber;
      const [baselineVersion, currentVersion, baseline, current] = orderKnown && referenceA.skillRevisionNumber > referenceB.skillRevisionNumber ? [versionB, versionA, runB, runA] : [versionA, versionB, runA, runB];
      const contextReady = group.modelCoverage === "effective_known" && group.model && group.instructionCoverage === "bundle" && group.skillsContentCoverage === "complete" && hasVerifiedNativeContext(group) && runA?.targetSkillKnown && runB?.targetSkillKnown;
      const targetExposureMismatch = Boolean(runA?.targetSkillMismatch || runB?.targetSkillMismatch);
      const actualVersions = run => run ? [...run.actualSkillVersions].sort() : [];
      if (!baseline || !current || !orderKnown || !contextReady) {
        result.push({ agentId: group.agentId, rubric: group.rubric, reviewerType: group.reviewerType, reviewerId: group.reviewerId, model: group.model, modelCoverage: group.modelCoverage,
          runtimeContextCoverage: group.runtimeContextCoverage, promptDigest: group.promptDigest, instructionBundleDigest: group.instructionBundleDigest, mcpDigest: group.mcpDigest,
          skillKey: group.skillKey, baselineSkillVersionId: baselineVersion, currentSkillVersionId: currentVersion,
          baselineExpectedSkillVersionId: baselineVersion, currentExpectedSkillVersionId: currentVersion,
          baselineActualSkillVersionIds: actualVersions(baseline), currentActualSkillVersionIds: actualVersions(current),
          baselineSkillRevisionNumber: baseline?.samples[0]?.skillRevisionNumber ?? null, currentSkillRevisionNumber: current?.samples[0]?.skillRevisionNumber ?? null,
          baselineTestRunId: baseline?.samples[0]?.testRunId ?? null, currentTestRunId: current?.samples[0]?.testRunId ?? null,
          baselineScore: baseline ? mean(baseline.scores) : null, currentScore: current ? mean(current.scores) : null,
          inputDigest: group.inputDigest, templateDigest: group.templateDigest, agentProfileDigest: group.agentProfileDigest, outcome: "inconclusive", reason: "multiple_test_runs_for_same_input_and_version",
          generalizesToProduction: false, baselineSamples: baseline?.samples ?? [], currentSamples: current?.samples ?? [],
          ...(!orderKnown ? { reason: "skill_version_order_unknown" } : {}), ...(targetExposureMismatch ? { reason: "test_target_exposure_mismatch" } : {}), ...(!contextReady && !targetExposureMismatch ? { reason: "execution_context_coverage_incomplete" } : {}) });
        continue;
      }
      const baselineScore = mean(baseline.scores); const currentScore = mean(current.scores); const delta = currentScore - baselineScore;
      result.push({ agentId: group.agentId, rubric: group.rubric, contributionRole: group.contributionRole, reviewerType: group.reviewerType, model: group.model,
        modelCoverage: group.modelCoverage, role: group.role, skillKey: group.skillKey, baselineSkillVersionId: baselineVersion, currentSkillVersionId: currentVersion,
        baselineExpectedSkillVersionId: baselineVersion, currentExpectedSkillVersionId: currentVersion,
        baselineActualSkillVersionIds: actualVersions(baseline), currentActualSkillVersionIds: actualVersions(current),
        runtimeContextCoverage: group.runtimeContextCoverage, promptDigest: group.promptDigest, instructionBundleDigest: group.instructionBundleDigest, mcpDigest: group.mcpDigest,
        baselineSkillRevisionNumber: baseline.samples[0].skillRevisionNumber, currentSkillRevisionNumber: current.samples[0].skillRevisionNumber,
        inputDigest: group.inputDigest, templateDigest: group.templateDigest, agentProfileDigest: group.agentProfileDigest,
        baselineTestRunId: baseline.samples[0]?.testRunId ?? null, currentTestRunId: current.samples[0]?.testRunId ?? null,
        baselineScore, currentScore, delta,
        outcome: delta > 0 ? "higher_on_this_controlled_input" : delta < 0 ? "lower_on_this_controlled_input" : "equal_on_this_controlled_input",
        generalizesToProduction: false, baselineSamples: baseline.samples, currentSamples: current.samples });
    }
  }
  return result.slice(0, 100);
}

export function summarizeDeliveryQuality(rows, { truncated = false } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const profile = asObject(row.executionProfile) ?? row.executionProfile;
    const context = nativeContext(profile);
    const skills = (profile?.skills ?? []).map(s => ({ key: s.key, versionId: s.versionId ?? null, versionBasis: s.versionBasis ?? "unknown", contentFingerprint: s.contentFingerprint ?? nativeSkillDigest(profile, s) ?? null, exposure: s.exposure ?? "selected", usage: s.usage ?? "unknown" })).sort((a, b) => a.key.localeCompare(b.key));
    const key = JSON.stringify([row.agentId, row.rubric, row.contributionRole, row.reviewerType, profile?.role ?? null, profile?.reportsTo ?? null,
      profile?.effectiveModel ?? profile?.configuredModel ?? null, profile?.configuredModel ?? null, profile?.modelCoverage ?? "historical_unknown", profile?.adapterType ?? null, profile?.configRevisionId ?? null, profile?.instructionFingerprint ?? null, profile?.instructionCoverage ?? "historical_unknown", profile?.skillsContentCoverage ?? "historical_unknown",
      context.runtimeContextCoverage, context.promptDigest, context.instructionBundleDigest, context.mcpDigest, skills.map(s => [s.key, s.versionId, s.versionBasis, s.contentFingerprint])]);
    if (!groups.has(key)) groups.set(key, { key, agentId: row.agentId, rubric: row.rubric, contributionRole: row.contributionRole, reviewerType: row.reviewerType,
      role: profile?.role ?? null, reportsTo: profile?.reportsTo ?? null, model: profile?.effectiveModel ?? profile?.configuredModel ?? null, configuredModel: profile?.configuredModel ?? null, modelCoverage: profile?.modelCoverage ?? "historical_unknown",
      adapterType: profile?.adapterType ?? null, configRevisionId: profile?.configRevisionId ?? null,
      instructionFingerprint: profile?.instructionFingerprint ?? null, instructionCoverage: profile?.instructionCoverage ?? "historical_unknown",
      skillsContentCoverage: profile?.skillsContentCoverage ?? "historical_unknown", ...context, skills, deliveries: new Map(), evaluations: [] });
    const group = groups.get(key);
    const grades = group.deliveries.get(row.revisionId) ?? [];
    grades.push(Number(row.score)); group.deliveries.set(row.revisionId, grades); group.evaluations.push(row);
  }
  return [...groups.values()].map(({ deliveries, evaluations, ...group }) => {
    const values = [...deliveries.values()].map(mean);
    return { ...group, score: truncated ? null : mean(values), assessedDeliveries: truncated ? null : deliveries.size,
      reviewCount: truncated ? null : evaluations.length, distribution: truncated ? null : { below50: values.filter(v => v < 50).length, from50to79: values.filter(v => v >= 50 && v < 80).length, atLeast80: values.filter(v => v >= 80).length },
      hypotheses: truncated ? [] : [...new Set(evaluations.flatMap(e => e.hypotheses ?? []))].map(h => ({ kind: h, status: "hypothesis", occurrences: new Set(evaluations.filter(e => e.hypotheses?.includes(h)).map(e => e.revisionId)).size })),
      reviewerCount: truncated ? null : new Set(evaluations.map(e => `${e.reviewerType}:${e.reviewerId}`)).size,
      reviewerIds: [...new Set(evaluations.map(e => `${e.reviewerType}:${e.reviewerId}`))].sort(),
      samples: [...new Map(evaluations.map(e => [e.revisionId, e])).values()].slice(0, 10).map(e => ({ revisionId: e.revisionId, evaluationId: e.id,
        workProductId: e.workProductId, score: Number(e.score), deliveredAt: e.deliveredAt,
        feedbackHref: `/api/companies/${e.companyId}/work-products/${e.workProductId}/evaluations?revisionId=${encodeURIComponent(e.revisionId)}&evaluationId=${encodeURIComponent(e.id)}` })),
    };
  });
}

export async function readDeliveryQuality(ctx, companyId, { start, end, agentId = null, agentIds = null, environment = "production" }) {
  const eligibleState = environment === "skill_test" ? "controlled_test" : "yes";
  const query = (sql, params) => ctx.db.query(sql, params);
  // Narrow to affected agents before applying the 5,001-row safety cap.
  const ids = agentIds == null ? null : [...new Set(agentIds)];
  const validId = id => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(id);
  if (ids?.some(id => !validId(id))) throw Error("Invalid affected agent ID");
  // Bind scalars, not a JS array (the plugin bridge expands arrays).
  const agentFilter = column => ids == null ? "" : ids.length
    ? " AND " + column + " IN (" + ids.map((_, i) => "$" + (i + 7) + "::uuid").join(", ") + ")"
    : " AND FALSE";
  const params = [companyId, start, end, environment, agentId, eligibleState, ...(ids ?? [])];
  const rows = await query(`SELECT e.id, e.company_id AS "companyId", e.issue_id AS "issueId", e.revision_id AS "revisionId", r.work_product_id AS "workProductId",
      e.evaluated_agent_id AS "agentId", e.contribution_role AS "contributionRole", e.rubric, e.score,
      e.execution_profile AS "executionProfile", e.controlled_test_ref AS "controlledTestRef", e.hypotheses, e.delivered_at AS "deliveredAt", e.reviewer_type AS "reviewerType", e.reviewer_id AS "reviewerId"
    FROM public.delivery_evaluations e JOIN public.delivery_revisions r ON r.company_id = e.company_id AND r.id = e.revision_id
    WHERE e.company_id = $1 AND e.delivered_at >= $2 AND e.delivered_at < $3 AND e.environment = $4
      AND ($5::uuid IS NULL OR e.evaluated_agent_id = $5) AND e.eligible = $6 AND e.state = 'final'
      AND NOT EXISTS (SELECT 1 FROM public.delivery_evaluations next WHERE next.company_id = e.company_id AND next.supersedes_id = e.id)
    ${agentFilter("e.evaluated_agent_id")} ORDER BY e.delivered_at DESC, e.id DESC LIMIT 5001`, params);
  const truncated = rows.length > CAP;
  const selected = rows.slice(0, CAP);
  const [eligible, assessed] = await Promise.all([
    query(`SELECT p.agent_id AS "agentId", COUNT(DISTINCT r.id)::int AS count
      FROM public.delivery_revisions r JOIN public.run_execution_profiles p ON p.company_id = r.company_id
        AND (p.run_id = r.publisher_run_id OR p.run_id = r.origin_run_id)
      WHERE r.company_id = $1 AND r.delivered_at >= $2 AND r.delivered_at < $3 AND r.environment = $4 AND r.precise <> 'unknown'
        AND ($5::uuid IS NULL OR p.agent_id = $5) ${agentFilter("p.agent_id")} GROUP BY p.agent_id`, params),
    query(`SELECT e.evaluated_agent_id AS "agentId", COUNT(DISTINCT e.revision_id)::int AS count
      FROM public.delivery_evaluations e WHERE e.company_id = $1 AND e.delivered_at >= $2 AND e.delivered_at < $3 AND e.environment = $4
        AND e.eligible = $6 AND e.state = 'final' AND e.evaluated_agent_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.delivery_evaluations next WHERE next.company_id = e.company_id AND next.supersedes_id = e.id)
        AND ($5::uuid IS NULL OR e.evaluated_agent_id = $5) ${agentFilter("e.evaluated_agent_id")} GROUP BY e.evaluated_agent_id`, params),
  ]);
  const assessedByAgent = new Map(assessed.map(row => [row.agentId, Number(row.count ?? 0)]));
  const trackedByAgent = new Map(eligible.map(row => [row.agentId, Number(row.count ?? 0)]));
  const eligibleByAgent = [...new Set([...trackedByAgent.keys(), ...assessedByAgent.keys()])].map(agentId => ({ agentId,
    trackedExactRevisions: trackedByAgent.get(agentId) ?? 0, assessedDeliveries: assessedByAgent.get(agentId) ?? 0 }));
  return { policy: "delivery-quality.v1", companyId, environment, start, end,
    cohorts: summarizeDeliveryQuality(selected, { truncated }),
    coverage: { evaluationsReturned: selected.length, limit: CAP, truncated, denominator: "tracked_profiled_exact_revisions_partial", historicalCoverage: "partial", eligibleByAgent,
      notes: ["Tracked exact revisions count only records linked to a captured origin/publisher execution profile; board-confirmed attribution may exist outside this denominator. Counts are not a complete coverage percentage."] },
    controlledPairs: environment === "skill_test" ? pairControlledSkillTests(selected, { truncated }) : [],
    samples: selected.slice(0, 50).map(({ executionProfile, ...e }) => ({ ...e,
      feedbackHref: `/api/companies/${companyId}/work-products/${e.workProductId}/evaluations?revisionId=${encodeURIComponent(e.revisionId)}&evaluationId=${encodeURIComponent(e.id)}`, profileAvailable: Boolean(executionProfile) })),
    notes: ["One delivery revision contributes one mean grade per comparable cohort; superseded, self, formative and unattributed reviews are excluded.",
    "Coverage denominator is a partial count of exact revisions linked to captured execution profiles. Board-confirmed attribution and historical deliveries may fall outside it; do not interpret counts as a complete percentage.",
    "Skills are selected exposure; invocation and semantic compliance remain unknown. Diagnostic tags are hypotheses.",
    ...(environment === "skill_test" ? ["Controlled pairs require the same input, template and comparison profile digests with only the skill version varying. Each pair describes its tested input and does not generalize to production."] : []),
    "Different rubrics, contributions and execution contexts stay separate. Configured model is not proof of effective model; absent effective-model coverage blocks comparison. Temporal changes are associations, not causal proof."],
  };
}

export function compareDeliveryQuality(before, after, { changedSkillKeys = [] } = {}) {
  const comparisonKey = c => JSON.stringify([c.agentId, c.rubric, c.contributionRole, c.reviewerType, c.reviewerIds, c.role, c.reportsTo, c.model, c.configuredModel, c.modelCoverage, c.adapterType, c.configRevisionId, c.instructionFingerprint, c.instructionCoverage, c.skillsContentCoverage, c.runtimeContextCoverage, c.promptDigest, c.instructionBundleDigest, c.mcpDigest,
    c.skills.filter(s => !changedSkillKeys.includes(s.key)).map(s => [s.key, s.versionId, s.versionBasis, s.contentFingerprint]).sort()]);
  const regroup = data => ({ ...data, cohorts: data.cohorts.map(c => ({ ...c, key: comparisonKey(c) })) });
  before = regroup(before); after = regroup(after);
  const baseKey = c => JSON.stringify([c.agentId, c.rubric, c.contributionRole, c.reviewerType]);
  const confoundersFor = (a, b) => {
    if (!a || !b) return [];
    const changed = [];
    for (const [name, left, right] of [["reviewer_cohort", JSON.stringify(a.reviewerIds), JSON.stringify(b.reviewerIds)], ["role", a.role, b.role], ["reports_to", a.reportsTo, b.reportsTo], ["model", a.model, b.model], ["configured_model", a.configuredModel, b.configuredModel], ["model_effective_coverage", a.modelCoverage, b.modelCoverage], ["adapter", a.adapterType, b.adapterType],
      ["agent_configuration_revision", a.configRevisionId, b.configRevisionId], ["instruction_fingerprint", a.instructionFingerprint, b.instructionFingerprint], ["instruction_coverage", a.instructionCoverage, b.instructionCoverage], ["skills_content_coverage", a.skillsContentCoverage, b.skillsContentCoverage],
      ["runtime_context_coverage", a.runtimeContextCoverage, b.runtimeContextCoverage], ["prompt_digest", a.promptDigest, b.promptDigest], ["instruction_bundle_digest", a.instructionBundleDigest, b.instructionBundleDigest], ["mcp_digest", a.mcpDigest, b.mcpDigest]]) {
      if (left !== right) changed.push(name);
    }
    const skills = new Map(a.skills.filter(s => !changedSkillKeys.includes(s.key)).map(s => [s.key, [s.versionId, s.versionBasis, s.contentFingerprint]]));
    const afterSkills = new Map(b.skills.filter(s => !changedSkillKeys.includes(s.key)).map(s => [s.key, [s.versionId, s.versionBasis, s.contentFingerprint]]));
    if (JSON.stringify([...skills].sort()) !== JSON.stringify([...afterSkills].sort())) changed.push("other_skill_versions");
    if ([...a.skills, ...b.skills].some(skill => !changedSkillKeys.includes(skill.key) && skill.versionBasis === "unknown")) changed.push("other_skill_version_basis_unknown");
    if (!otherSkillsCovered(a, changedSkillKeys) || !otherSkillsCovered(b, changedSkillKeys)) changed.push("other_skill_content_unknown");
    if ([...a.skills, ...b.skills].some(skill => changedSkillKeys.includes(skill.key) && (!skill.versionId || skill.versionBasis === "unknown" || !skill.contentFingerprint))) changed.push("target_skill_content_unknown");
    return changed;
  };
  const targetSkillSignature = (cohort) => JSON.stringify(cohort.skills
    .filter(skill => changedSkillKeys.includes(skill.key))
    .map(skill => [skill.key, skill.versionId, skill.versionBasis, skill.contentFingerprint, skill.exposure])
    .sort((left, right) => left[0].localeCompare(right[0])));
  const keys = new Set([...before.cohorts, ...after.cohorts].map(c => c.key));
  return [...keys].map(key => {
    const a = before.cohorts.find(c => c.key === key); const b = after.cohorts.find(c => c.key === key);
    const cohort = b ?? a;
    const counterparts = (a ? after : before).cohorts.filter(c => baseKey(c) === baseKey(cohort));
    const confounders = a && b ? confoundersFor(a, b) : counterparts.flatMap(c => confoundersFor(a ?? c, b ?? c));
    const ambiguous = before.cohorts.filter(c => c.key === key).length > 1 || after.cohorts.filter(c => c.key === key).length > 1;
    const targetSkillNotVaried = Boolean(a && b && changedSkillKeys.length && targetSkillSignature(a) === targetSkillSignature(b));
    const missing = ambiguous || !a || !b || confounders.length > 0 || targetSkillNotVaried || a.modelCoverage !== "effective_known" || b.modelCoverage !== "effective_known" || !hasVerifiedNativeContext(a) || !hasVerifiedNativeContext(b) || !otherSkillsCovered(a, changedSkillKeys) || !otherSkillsCovered(b, changedSkillKeys) || a.assessedDeliveries == null || b.assessedDeliveries == null || a.assessedDeliveries < 5 || b.assessedDeliveries < 5 || a.score == null || b.score == null || a.instructionCoverage !== "bundle" || b.instructionCoverage !== "bundle";
    const delta = missing ? null : b.score - a.score;
    return { agentId: cohort.agentId, rubric: cohort.rubric, contributionRole: cohort.contributionRole, reviewerType: cohort.reviewerType, reviewerIds: cohort.reviewerIds, role: cohort.role, model: cohort.model, modelCoverage: cohort.modelCoverage,
      runtimeContextCoverage: cohort.runtimeContextCoverage, promptDigest: cohort.promptDigest, instructionBundleDigest: cohort.instructionBundleDigest, mcpDigest: cohort.mcpDigest, skills: cohort.skills,
      baselineSkills: a?.skills ?? [], currentSkills: b?.skills ?? [],
      baselineScore: a?.score ?? null, currentScore: b?.score ?? null, baselineSample: a?.assessedDeliveries ?? 0, currentSample: b?.assessedDeliveries ?? 0, delta,
      outcome: missing ? "inconclusive" : delta >= 10 ? "improved" : delta <= -10 ? "regressed" : "within_threshold",
      reason: ambiguous ? "multiple_skill_versions_in_window" : (!a || !b) ? "no_comparable_cohort_in_other_window" : targetSkillNotVaried ? "changed_skill_exposure_not_varied" : confounders.length ? "other_execution_context_changed" : (a?.modelCoverage !== "effective_known" || b?.modelCoverage !== "effective_known") ? "effective_model_unknown" : !hasVerifiedNativeContext(a ?? {}) || !hasVerifiedNativeContext(b ?? {}) ? "native_runtime_context_unverified" : (a?.instructionCoverage !== "bundle" || b?.instructionCoverage !== "bundle") ? "instruction_bundle_coverage_incomplete" : missing ? "insufficient_comparable_delivery_evidence" : Math.abs(delta) < 10 ? "absolute_change_below_10_point_observational_threshold_v1" : "observational_threshold_crossed_association_only",
      confounders, baselineSamples: a?.samples ?? [], currentSamples: b?.samples ?? [], causality: "association",
    };
  });
}
