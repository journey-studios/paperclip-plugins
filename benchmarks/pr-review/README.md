# PR review benchmark

Measure changes to the review system against frozen pull requests, repeated runs and an auditable reference set.
The tools include frozen corpus preparation, a paired experiment planner, isolated PR-Agent/OpenCode replay,
ReviewBench judging integration, scoring and comparison. A separate canary exercises the real engines with a
fake model. Neither passing tests nor passing that canary proves an improvement to the reviewer. The first
paid comparison still requires fixed models, treatment configurations and a budget. See [REPLAY.md](REPLAY.md)
for executable preparation, freezing, canary, review and judging instructions.

## Corpus and reference labels

`corpus.json` pins [ReviewBench](https://github.com/review-bench/ReviewBench) at
`53e4b5ebe9a81e1dd83183215331e17068a5adc5`. The upstream corpus has 219 PRs and public reference findings.
This pilot selects 12 TypeScript/JavaScript PRs from distinct repositories: four small, four medium and four
large changes (capped at 10,000 changed lines). Selection used only language, size, repository identity and a
fixed ordering seed, not reviewer performance or gold findings. Every case fixes base/head commits and the
reference file's Git blob. The pinned files contain 119 positive reference findings, including two high-severity
findings. Each size band contributes two development and two holdout PRs; repositories cannot
cross the split.

The six PRs in each split validate the pipeline and reveal failures. They are insufficient to declare a winner:
the comparison refuses to establish improvement with fewer than ten independent held-out PRs. That minimum
is an operational floor, not a power calculation. Expand the corpus before a decision; the required sample
size depends on the observed variance and the smallest useful improvement.

Read public reference files from a separate checkout at the pinned revision. `importReviewBenchGold` checks
the exact PR identity and keeps upstream `tp` labels, their producer, evidence and source metadata. Model-generated
labels stay model-generated; neither consensus nor an upstream dataset name makes every label human-certified.
Do not mount reference labels, scoring outputs, future fix commits or PR discussions in reviewer containers.
Only the evaluator sees them. A reviewer must receive identical frozen code and repository rules in every
replica. Both head and base must be reachable and the diff must come from their frozen merge base.

The public corpus measures general review quality. Tessel-specific conventions need a separately reported
local corpus. Add historical pre-fix heads with reproducible defects and corrected controls, while keeping each
pre-fix/corrected pair and related PRs in the same split. Public labels can also have training contamination;
private, recent PRs are the stronger later check of transfer to our code.

## Treatments and repetitions

`study.json` defines the experiment and `plan` emits a reproducibly shuffled, paired schedule. The default
development plan has **6 PRs × 3 treatments × 3 repetitions × 2 layers = 108 review trials**. Repetitions start
fresh sessions. The holdout is a separate plan; do not use it to tune a configuration.

- **Baseline:** snapshot the deployed reviewer and its input construction.
- **Candidate A:** change one thing, such as context coverage or one prompt/instruction revision.
- **Candidate B:** test one alternative while holding other variables fixed.

The two layers (`triage`, `thermo`) are scored separately. A combined pipeline is a separate future treatment;
its time and cost include both stages and its known issues must be deduplicated before scoring. Deterministic
risk-radar reminders are not confirmed bugs and do not enter findings as if they were model detections.

Freeze source/image revision, full instruction and skill contents, configuration digest, model version,
reasoning effort, context/output limits, timeout, retry policy, tool permissions and cache policy before a run.
Set each treatment's `pins.triage` / `pins.thermo` to `{reviewerRevision, effectiveModel, configDigest}`. The revision
must be a full commit or image digest and `configDigest` a SHA-256 of the actual frozen configuration. The example
intentionally leaves these unset: `plan` returns `ready: false` and lists `unconfigured`; comparisons refuse
to run until these identities have been selected. Collected trial identities must match the predeclared pins.
`antigravity-pool` alone does not identify a fixed model: record the resolved model or the result is not suitable
for comparison. Retries consume time and money; record their total, including failures. Do not reuse production
Paperclip sessions or let a treatment see another treatment's output.

Preselect `primaryCandidate` before opening the holdout. Other comparisons remain exploratory, avoiding a
claim based on whichever of several candidates happened to win. Changing a study or corpus changes its digest;
old results cannot be mixed into the new experiment. The CLI also fingerprints the measurement source itself.
Decision thresholds live in `study.policy` and are included in that fingerprint.

## Reference issues for our own PRs

The quoted multi-model method is useful for bootstrapping labels, with additional validation:

1. Freeze the PR before the fix and collect independent reviews from two strong model families, initially two
   fresh runs each. Hide existing comments and future fixes. Keep each proposal's model, effort and run identity.
2. Deduplicate by underlying cause, not by wording or nearby line number. Verify each candidate against the
   frozen code, an existing correction or a targeted regression reproduction.
3. Mark labels as provisional, verified or disputed with evidence. Agreement between models is a signal;
   a defect and its severity need evidence. Use a judge independent of the treatment and blind to its name.
4. Ask for human attention only on disagreements, consequential security claims and a small random audit sample.
   A new valid finding enters the **next** reference revision; the current comparison retains one fixed denominator.

The benchmark does not currently generate reference labels for private PRs. Its scoring contract accepts
evidence-backed judgments. This avoids pretending an exact-text or line-distance heuristic measures semantic correctness.
[ReviewBench's judge](https://github.com/review-bench/ReviewBench/blob/main/docs/JUDGING.md) can match findings and
validate new issues. The importer preserves its detailed judgments; `prepare-judge` adds export of the existing
classifier rationale without changing prompts or judgments. Missing evidence and ambiguous many-to-many
matches stay unresolved instead of inflating recall or becoming automatically false positives.
Judge calls have their own cost and must be budgeted separately from reference generation and reviewer calls.

## Scoring contract

`scoreTrial` receives `gold`, `findings`, `judgments`, a review status, and provenance containing the SHA-256
digests of the exact gold/findings plus a frozen judge revision. Hashes use the exported `digest()` on the actual
JSON value (array order is significant). Each finding has a stable id. Judgments have a `findingId`, one kind
below and non-empty `evidence`:

| Kind | Meaning |
| --- | --- |
| `match` + `goldId` | The finding describes one known defect; one-to-one credit |
| `novel_valid` | A new defect verified against code; improves adjudicated precision, not the current recall denominator |
| `false_positive` | An explicitly refuted claim, with evidence |
| `duplicate` + `duplicateOf` | Another comment about an already confirmed finding; no extra recall credit |
| `unresolved` | Not enough evidence; prevents declaring an improvement |

An unjudged finding is automatically unresolved, **never automatically a false positive**. A failed or invalid
review is an explicit trial with no findings and misses every reference defect. An empty review has null
precision and zero recall when gold exists; a no-gold control has null recall, not 100%.

The report includes micro known-issue recall (weighted by issue count), macro recall (equal weight per PR),
adjudicated precision, confirmed false positives per PR, novel findings,
duplicate noise, completion rate, severe-issue recall, within-PR recall variation, latency p50/p95 and cost.
Severe means upstream `high`/`critical` or our `blocker`/`major`. Grounded precision is only overlap with the known
set; it is not the false-positive rate when reference labels are incomplete. Duplicate comments are reported
as noise separately from false claims.

Every trial records `jobId`, `experimentDigest`, `base`, `head`, `executionMode` (`live` or `fixture`), `coverage`
(`complete`, `partial`, `unknown`), `reviewerRevision`, `effectiveModel`, `configDigest`, `durationMs`, `costUsd`,
`costBasis` and its `score`. Cost basis is `provider`, `estimated`, `subscription` or `unknown`. Unpriced
subscription/gateway usage has **null cost**, not zero. Keep provider cost, rate-based estimates and judge/reference
costs separate. Token/cache counts and raw usage belong in sanitized sidecars; they are not evidence of free inference.

All planned slots must exist, even failures. Wrong heads, duplicate trials, changed gold/judge or model/config
drift reject the comparison. The primary quality rule requires a held-out paired recall gain of at least five
percentage points, a PR-cluster bootstrap 95% interval above zero, no precision loss beyond two points, no severe
recall/completion regression, no unresolved findings and no additional duplicate noise. It also requires measured
coverage and at least ten independent PRs. Precision/severity checks are guardrails on observed values, not
separate statistical non-inferiority proofs. These are proposed decision thresholds; freeze a different policy
before collection if a smaller gain or lower review cost is the actual objective.

The paired delta uses macro recall. Bootstrap resamples PRs after averaging their repetitions; it does not treat repeated calls on one PR as independent
samples. Fixture trials cannot establish reviewer quality. An improvement in quality is not automatically an
improvement in cost or speed: inspect the accompanying measurements and the cost basis.

## Commands (Node 24.11+, Python 3 for gateway tests, Docker for replay)

```sh
pnpm test:review-bench
pnpm --silent review-bench plan > .review-bench-plan.json
# Optional: supply a frozen study and corpus explicitly.
pnpm --silent review-bench plan study.json corpus.json > plan.json
pnpm --silent review-bench normalize raw-review.json > normalized-findings.json
pnpm --silent review-bench gold reference-bundle.json > gold.json
pnpm --silent review-bench score trial-with-evaluation.json > scored-trial.json
pnpm --silent review-bench compare plan.json scored-trials.json > comparison.json
```

`normalize` accepts `{layer, pr, agent, review}`. `pr` follows
[ReviewBench's input](https://github.com/review-bench/ReviewBench/blob/main/docs/JUDGING_INPUT.md):
`{repo: "https://github.com/owner/repo", pr_number, base, head}`. For triage, `review` is the service's parsed
result; for Thermo it is the verdict comment text. Missing output, wrong identity, unusable finding locations
or an unlocalized security concern fail instead of being converted into a successful empty review. ReviewBench
can judge each repetition's normalized output, but **run each treatment/repetition in its own directory**:
its judging loader merges multiple files for the same PR.

`gold` accepts `{reference: <upstream gold file>, pr: <expected identity>}`. `score` accepts trial metadata plus
`evaluation: {gold, findings, judgments, status, provenance}`. `compare` accepts a plan and an array of scored
trials. These commands only read the named files and write JSON to stdout.

Store actual run data in ignored `.review-bench/` or an external artifact store. Reviewer containers must have
no GitHub/board write credentials, no gold mount and no path to PR discussions through direct network, search
or hosted connectors. A fresh container with a model-host-only network is the intended execution boundary.
The deployed triage service currently reads the live PR and default-branch rules: calling it on a historical
PR number is **not** a frozen baseline. A replay adapter must supply the pinned patches/rules to the same
reviewer engine first. Likewise, Thermo replay must retain its real instructions/tools while replacing
publication with a local output file. The replay adapters implement these operational changes; measure their
latency separately from production queueing, publication and warm sessions. Read-only tools and a model-only
network are fixed replay conditions, rather than claims of exact production environment parity.

## Validation and first measured run

Tests cover missing/new findings, false-positive evidence, duplicate credit, empty/failed reviews, immutable
inputs, reference provenance, schedule pairing, missing trials, wrong commits, model/gold drift, unpriced
usage, fixture leakage into claims, adapter failures and the real corpus schedule. A synthetic comparison can
validate the machinery; it is never a model leaderboard or evidence that a change helped.

Before the first paid run: pin effective models/configs, select the judge and set separate ceilings for reference
generation, reviewing and judging. The adapters enforce call/token bounds; dollar ceilings require known pricing
and billing reconciliation. Start with one PR through
every treatment, verify isolation/coverage/usage, then execute the development pilot. Expand and freeze the
holdout after choosing one candidate. The fixture canary uses the actual engines with a deterministic fake backend;
it performs no provider inference and cannot establish a quality improvement.

References: [ReviewBench](https://github.com/review-bench/ReviewBench),
[offline evaluation limits](https://github.com/review-bench/ReviewBench/blob/main/docs/OFFLINE_EVAL.md),
[semantic matching and paired findings in BC-Bench](https://microsoft.github.io/BC-Bench/code-review.html).
