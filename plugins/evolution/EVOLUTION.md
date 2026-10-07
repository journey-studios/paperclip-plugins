# Evolution — Change Intelligence

Journey Studios plugin that connects operational changes to later evidence.

## Model

Change Set -> Change Items -> Snapshots -> Evidence -> Metrics -> Conclusion

Evolution does not replace Paperclip Audit. Audit remains the immutable technical event log. Evolution groups those events into intentional changes and tracks whether the change appears to help.

## Persistence

Evolution owns a PostgreSQL plugin namespace in the existing Paperclip database:

- change_sets
- change_items
- change_snapshots
- change_links
- change_evidence
- change_metrics
- change_conclusions

Core runs, costs, issues, goals, agents and Audit rows are referenced rather than duplicated.

Large files such as screenshots and videos remain in Paperclip artifacts/storage; change_evidence stores their reference IDs and interpretation.

## Capture

The plugin records:

- agent configuration revisions with exact before/after JSON;
- relevant agent Audit events such as instructions, skill assignment, permissions, rollback and budget changes;
- skill versions and skill mutation Audit events;
- the originating Audit ID when available.

Historical instruction-file contents may be partial because Paperclip did not previously version every instruction file mutation. New audited changes remain traceable, and config revisions are exact.

## Change Sets

Automatic Change Sets are grouped by originating run when possible, otherwise by actor and a bounded time window.

Use Merge into… to consolidate automatic sets into a conceptual change such as Research system improvements — October 2026.

## Evidence and causality

Status:
draft, applied, validating, proven, regressed, inconclusive, reverted.

Causality level is separate:
observed, associated, validated.

Do not promote causality merely because a metric changed after a deployment.

## Metrics

The MVP computes seven-day before/after windows for affected agents:

- run success rate;
- average run duration;
- cost;
- input tokens;
- cached input tokens;
- output tokens.

Runs can be explicitly attached as positive, neutral or negative evidence.

## Deployment

Evolution is bundled into the Journey custom paperclip:agy image and auto-provisioned by Paperclip's bundled-plugin lifecycle on self-hosted startup. Do not install it by bypassing Board authorization.

The deploy script creates a PostgreSQL dump and rollback image before promoting the candidate.
