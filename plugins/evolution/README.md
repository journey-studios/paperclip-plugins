# Org Tracker

Journey Studios Change Intelligence plugin for Paperclip.

It keeps operational change metadata in a plugin-owned PostgreSQL namespace and references Paperclip core records instead of duplicating runs, costs, issues, goals, or agents.

## MVP

- Change Sets with hypothesis, status, causality level, and validation window
- Automatic agent-change capture using agent config revisions
- Automatic skill-change capture via audited skill activities
- Backfill of recent agent and skill revisions
- Before/after snapshots
- Links and evidence references
- Baseline/current run and cost metrics for affected agents
- Conclusions with confidence
- Evolution timeline and detail UI

In the detail view, compare the before and after snapshots and check for the partial-history notice. Candidate runs are suggestions: attach only comparable runs and choose their verdict deliberately. Run success and before/after metrics describe observations; they do not establish that a change caused an improvement.

Metrics show sample counts for both windows. Run metrics count runs, while cost and token metrics count cost events. Interpret zero or small samples as inconclusive. See [the model and evidence guide](./EVOLUTION.md) for the status and causality meanings.

## Core extension

Requires the Journey runtime read-only plugin database extension for activity_log, agent_config_revisions, company_skills, and company_skill_versions.

It also forwards skill mutation audit actions as the existing activity.logged plugin event.

## Continuous evidence and assessment (v0.2)

- `agent.run.finished`, `agent.run.failed`, and `agent.run.cancelled` events associate terminal run IDs with **existing affected-agent Change Sets**, only for runs that start after the change and before the seven-day validation cutoff. The originating run never becomes its own evidence.
- Run evidence is idempotent on delivery retry, marked `neutral` (success is not proof of improvement), and never overwrites manually curated verdicts. Canonical Issue/Project/Goal links remain references to Paperclip core data.
- The plugin's `refresh-assessments` job reconciles recent sets hourly (at minute 11); a manual **Refresh evidence & assessment** button handles on-demand refresh. The hourly bounded recovery checks at most 50 companies, 30 active agent Change Sets per company, and 150 terminal runs per Change Set. The bounded rescan may not recover every missed run if downtime exceeds those limits; newer event deliveries remain incremental.
- Assessments are stored separately from manual conclusions and never change the Change Set's approval status or causality level. Success rate and average duration are checked with at least 10 runs in each window and at least 24 hours of observation. A success-rate delta of at least 10 percentage points, a duration change of at least 20% faster / 25% slower, and no contradictory signal can yield `improved` / `regressed`; otherwise the result is `inconclusive`. Overlapping changes force `inconclusive`. Total spend and token deltas are informational, not a causal signal. Confidence is at most `moderate`.

### Agent tools — native Paperclip Tool Gateway

The Org Tracker directly declares and registers three plugin tools via `agent.tools.register` (no sidecar MCP server, bridge, or core change):

- `org_tracker_list_changes` — read the recent Change Sets with status and latest advisory assessment (bounded to 50).
- `org_tracker_change_summary` — read one Change Set's affected entities, aggregate metrics and evidence counts, latest manual conclusion, and advisory result, without raw configuration snapshots.
- `org_tracker_evaluate_change` — reconcile a bounded set of run evidence, recompute metrics, and store the advisory assessment. **This tool mutates only the plugin's namespace.**

The host prepends the plugin ID to tool names and enforces its existing Tool Gateway permissions, routing and exposure. All queries and writes derive `companyId` **exclusively** from the host-authenticated tool run context. A caller-provided company ID is ignored. Tools will only be callable by agents whose Tool Gateway profiles allow them; publishing a manifest does not bypass authorization or make the tools automatically available in ChatGPT's own connector.

## Canonical delivery quality (v0.3)

The quality flow is shared with the core and Agent Observatory: an authorized reviewer records feedback for an exact work-product revision in the core delivery-evaluations API; the Observatory presents rubric and contribution cohorts with samples and coverage; Org Tracker compares eligible production cohorts around a Change Set. Org Tracker does not author grades. Its detail panel and read-only MCP tool `orgTrackerDeliveryQuality` (native Paperclip tool `org_tracker_delivery_quality`, route `/mcp`) use the same canonical records as the Observatory. Sample links resolve both the exact `revisionId` and `evaluationId`.

The host must provide `delivery_revisions`, `delivery_evaluations` (including `controlled_test_ref`), and immutable `run_execution_profiles`, as well as the core read API for exact historical feedback. The public `compat/paperclip-delivery-quality-read.patch` only extends the SQL read allowlist; it does **not** create or migrate these tables. Apply the matching private host/runtime migration before enabling the plugin. With an older schema, quality is reported as unavailable with a host-schema reason; it is not converted into a zero score.

Only final eligible production evaluations enter production cohorts. Formative, self-reviewed, unattributed, superseded, and `controlled_test` evaluations are excluded. Multiple reviews are averaged into one grade per delivery before delivery-level cohort means are calculated. Cohorts remain separated by agent, rubric, contribution role, reviewer population, and execution profile. Coverage is partial: exact revisions count toward the tracked denominator only when linked to a captured origin/publisher profile, while board-confirmed evaluations may exist outside it. Missing scores stay null; a capped query suppresses aggregate results.

Skill-only Change Sets discover affected agents from historical run profiles and before/after change snapshots, including removal and rollback; current installation alone is not evidence of exposure. A temporal skill comparison requires the target skill's selected version and content fingerprint to differ, and requires reviewer population, effective model, instruction bundle, other skills, and remaining context to be comparable. Missing version/content proof, ambiguous versions, or insufficient evidence yields `inconclusive`. The `selected` profile field records exposure only; invocation and semantic use remain unknown. Verified native context (`runtimeContextCoverage=native_verified`) may include aggregate, prompt, instruction-bundle, skill-bundle, and MCP digests; raw instructions/configuration are not exposed. Configured model is not proof of effective model. For adapters without runtime proof, effective model remains unknown even when a configured model is shown.

Org Tracker keeps delivery quality separate from run reliability and cost. `reliabilityUp` is a run-success signal; success or faster duration never becomes a delivery grade. Quality deltas around a Change Set are observational associations, and the 10-point threshold is a display heuristic, not statistical significance or proof of causality. Controlled Skills Studio pairs use matching input/template/profile digests and monotonic skill revision numbers; a pair describes only its exact test input and is excluded from production aggregation. No comparison claims that a skill was used merely because it was installed or selected.

### Delivery-quality validation commands

From the plugins monorepo, run `node --test shared/delivery-quality.test.js tests/bootstrap-contract.test.mjs tests/compatibility-stack.test.mjs`, `pnpm --filter @journeystudios/paperclip-evolution typecheck`, `pnpm --filter @journeystudios/paperclip-evolution exec vitest run --config vitest.config.ts`, and `pnpm --filter @journeystudios/paperclip-evolution build`. The worker test suite includes a synthetic PGlite skill-only Change Set with historical profiles, exact grades, exposure hashes, and per-delivery links.
