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

## Core extension

Requires the Journey runtime read-only plugin database extension for activity_log, agent_config_revisions, company_skills, and company_skill_versions.

It also forwards skill mutation audit actions as the existing activity.logged plugin event.

## Merge recovery

Merges preserve their selected destination and can be retried there after concurrent captures finish. Migration `002_safe_merge.sql` prevents parent deletion from cascading into captured changes and keeps old capture contexts pointing at the destination, including after later merges. The SDK provides individual database statements, so a failed merge may already have transferred some rows; retry completes the remaining transfers.

The test suite covers redaction, company ownership, missing metrics and merge recovery. CI also runs the migrations and concurrent-capture regressions against a dedicated PostgreSQL 16 service.
