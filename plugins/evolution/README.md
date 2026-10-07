# Evolution

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
