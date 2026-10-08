# Org Tracker — Change Intelligence

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

Partial snapshots can indicate that a reading reflects current state rather than event-time state, or that content was omitted by snapshot safety limits. Only `historical_instruction_content_unavailable` means the prior instruction text was not recorded. Treat the Audit event as evidence that a mutation happened; do not infer missing before/after text.

### Snapshot privacy boundary

Evolution omits inline prompt bodies and local instruction paths, redacts secret-named configuration fields, and replaces every value inside `env`, `envVars`, and environment maps. It also scrubs common credential forms from retained strings, including bearer/API tokens, private-key blocks, credential-bearing URLs, and secret query parameters. General strings are capped at 4 KiB; `markdown` and `content` fields can use up to 24 KiB, subject to a 24 KiB total serialized snapshot cap. A `_evolutionSnapshotSafety.truncated` marker appears when a cap omits content.

This is a bounded redaction layer, not a general-purpose secret detector: an arbitrary credential written as ordinary prose may not match a known pattern. Keep credentials out of prompts, skills, and instructions. Treat snapshots as sensitive operational history and review any content that may contain unrecognized secrets before relying on it.

### Future trustworthy instruction diffs

The host's current `agent_config_revisions` stores configuration JSON, not instruction-file text. The instructions file write route updates the file, records a config revision, and emits activity, but the event does not contain the prior or resulting text. To capture trustworthy future diffs without putting bodies in Audit, the host should read the old text immediately before a managed-file write and the new text immediately after, apply the same bounded redaction, store each sanitized version once in company-scoped content-addressed artifact storage, then emit only content references, hashes, relative path, and the originating Audit/revision ID. Evolution would read those references through a narrow company-scoped plugin API. External files that Paperclip did not write should stay partial unless the host can safely capture both sides at their write boundary.

## Change Sets

Automatic Change Sets are grouped by originating run when possible, otherwise by actor and a bounded time window.

Actor/time groups are a convenience and can contain unrelated agents, skills, or changes. Select only the relevant timeline items and move them into a conceptual Change Set when curating a mixed group. The source Change Set remains, its other items and evidence/conclusions stay in place, and the target records a provenance link to the source with the moved item IDs. Metrics are recomputed for both sets.

Backfill keeps native versions and Audit activity as separate Change Items. A single skill edit can therefore appear as both a Native Skill version and a separate Audit activity; each row preserves its source provenance, and Change Item counts are captured records rather than distinct edits. Evolution does not heuristically merge or discard these records.

Use Merge into… only when the whole source set belongs in the target. Whole-set merge moves all change items, evidence, conclusions, and links, removes the source set, and recomputes target metrics.

## Evidence and causality

Status:
draft, applied, validating, proven, regressed, inconclusive, reverted.

Causality level is separate:
observed, associated, validated.

Do not promote causality merely because a metric changed after a deployment.

Observed records that a change preceded an outcome. Associated means relevant evidence has been linked to the change. Validated should be used only when a controlled comparison supports attribution. A causal claim does not follow from status, metric direction, or a successful run alone.

## Metrics

The MVP computes seven-day before/after windows for affected agents:

- run success rate;
- average run duration;
- cost;
- input tokens;
- cached input tokens;
- output tokens.

Run metrics count eligible runs; cost and token metrics count cost events. The UI shows both sample counts beside each comparison. Zero or small samples cannot support a reliable improvement claim, and these aggregate windows may include unrelated changes or workload differences. Report the observed values and their limits, then use comparable attached evidence and a controlled evaluation before claiming the change caused an outcome.

Runs can be explicitly attached as positive, neutral or negative evidence. Run links and run evidence are checked within the current company; Evolution also resolves and links the run's canonical Issue, Project, and Goal where available. These associations improve traceability, but do not establish that a change caused an improvement.

## Deployment

Evolution is bundled into the Journey custom paperclip:agy image and auto-provisioned by Paperclip's bundled-plugin lifecycle on self-hosted startup. Do not install it by bypassing Board authorization.

The deploy script creates a PostgreSQL dump and rollback image before promoting the candidate.

## Automated evidence and advisory assessments (v0.2)

Live terminal run events are joined to the affected agent's Change Sets using the run's canonical company, agent, status and started-at timestamp from Paperclip; the event payload alone is not trusted. The seven-day post-change window, explicit validation end, and origin-run exclusion bound association. Human-curated verdicts take precedence; auto observations remain neutral. The plugin keeps only a safe run ID and minimal non-sensitive status metadata. An hourly scheduled job reconciles eligible records lost during short outages; the refresh button can also do so.

The latest automatic observation resides in `change_assessments`, not `change_conclusions`. It does not update `change_sets.status` or `causality_level`. The following decision rules are **heuristics, not statistical causal inference**:

- Fewer than 10 baseline/after runs, less than 24 hours after the change, missing success-rate telemetry, or a later overlapping recorded agent change => **inconclusive**.
- Success-rate delta >= +10 percentage points or mean duration improvement >= 20%, without a conflicting signal => **improved**; delta <= -10 points or mean duration increase >= 25%, without a conflicting signal => **regressed**.
- Conflicting signals or smaller changes => **inconclusive**. Relative duration is ignored if either window has fewer than 10 recorded runs; a speed win is ignored when the success rate decreases by more than three points.
- Confidence is `low` unless both windows have at least 30 runs and the after-change observation spans >= 72 hours; then it is at most `moderate`. This is observation strength, **never** validated causal confidence.

Run metrics use eligible runs as samples and cost/token metrics use reported cost events. Current and baseline periods can have different lengths; aggregate total cost and token deltas are informational and not ranked as improvements. Qualitative work quality, task difficulty, unrelated configuration edits, external model changes, skill-only edits without an affected agent record, and representative controlled A/B testing remain outside automatic attribution. A manually established `validated` causality level is separate and never inferred by the automation.

Tool Gateway authorizes native plugin tools per agent/company. Tools derive company scope from trusted execution context, never tool arguments. The summary excludes before/after JSON and redacts common credential patterns in free text, but you should still avoid placing secrets in Change Set titles, conclusions, or other free text. The evaluation tool writes plugin-only evidence, metrics and assessments and should be governed as a write-capable agent tool.
