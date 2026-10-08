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
