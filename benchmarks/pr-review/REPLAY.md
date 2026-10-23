# Frozen review replay

Use Node 24.11+, Python 3 for local gateway tests, and Docker on the execution host. These tools create no
Paperclip tasks or GitHub comments. Keep runtime configuration, instruction snapshots and results outside Git.

## Prepare and test without inference

Use a separate ReviewBench checkout at the corpus revision. Preparation reads committed Git blobs, checks their
pins, fetches only base/head ancestry from public mirrors, and computes the actual merge base. Git hooks and
credential helpers are disabled. Only the generated `repo/` and `pr/` directories enter reviewer containers;
`reference.json` remains evaluator-only. Modified code, metadata, patches or rules refuse execution.

```sh
pnpm --silent review-bench prepare benchmarks/pr-review/corpus.json /path/to/ReviewBench \
  .review-bench/snapshots konturio__disaster-ninja-fe__1082 > prepared.json
# Replace the case id with development or holdout to prepare a split.
pnpm --silent review-bench canary canary-options.json .review-bench/snapshots \
  .review-bench/canary-01 > canary-report.json
```

`canary-options.json` names `caseId`, immutable local `triageImage` and `thermoImage` ids (`sha256:...`), the exact
`cliVersion`, and `instructions` (paths to the actual Thermo AGENTS.md and required skill files). The canary runs
**18 fresh trials: one development PR × three treatments × three repetitions × two layers**. It starts an internal
fake backend with a fake credential, runs both real engines, collects/scores every slot and checks that the
comparison declares no quality winner. Backend/network cleanup runs on completion. An existing output directory
is never overwritten. Fabricated findings and token counts are explicitly fixtures, never quality/cost evidence.

PR-Agent needs tokenizer tables before its first request. If the deployed image normally downloads them on
startup, build a benchmark-only derivative with `adapters/Dockerfile.triage`. Verify the local base tag's image id
first, pass it as `REVIEWER_BASE_REVISION`, and pin the resulting image id in all treatments. The Dockerfile
adds the public tokenizer tables while retaining the reviewer engine/wrapper. Its build may fetch those tables;
the review containers retain their restricted network. No provider inference is involved in that build.

`study.caseIds` can select a development canary before the full pilot. Selection is part of the experiment hash.
When transferring snapshots from macOS, omit extended attributes/AppleDouble files; extra files fail integrity
checks. Prefer preparing snapshots on the execution host when possible.

## Freeze and run reviews

`execution.json` has `executionMode: "live"`, a positive `maxTrials` for this invocation, and `profiles` keyed by
`triage/baseline`, `thermo/baseline` and each candidate. A triage profile looks like:

```json
{
  "image": "sha256:<immutable reviewer image id>",
  "user": "10001:10001",
  "timeoutSeconds": 900,
  "gateway": {
    "image": "sha256:<immutable image with Python>",
    "network": "review-models",
    "upstream": "http://model-gateway:20128/v1",
    "requestModel": "fixed-provider-route",
    "effectiveModel": "expected-response-model-version",
    "maxRequests": 3,
    "maxOutputTokens": 8192,
    "maxInputBytes": 2000000,
    "timeoutSeconds": 600,
    "costBasis": "unknown"
  },
  "reviewer": {
    "requestModel": "fixed-provider-route",
    "settings": {
      "CONFIG.MAX_MODEL_TOKENS": 32000,
      "CONFIG.CUSTOM_MODEL_MAX_TOKENS": 200000
    }
  }
}
```

For Thermo, use the OpenCode image's unprivileged uid/gid and replace `reviewer.settings` with `instructions`
(Markdown paths), `cliVersion`, `modelLimit: {context, output}`, optional `variant`, and `deliveryInstructions`
requiring the usual verdict block in the final local response. Snapshot the real instruction/skill contents,
and make one declared change per candidate. `freeze` hashes contents and adapters, rather than machine-specific
instruction paths. Images must already exist locally; replay does not pull mutable tags.
`reviewer.modelMetadata` can preserve provider metadata such as DeepSeek's
`{reasoning: true, tool_call: true, interleaved: {field: "reasoning_content"}}`.
The auxiliary OpenCode model is pinned to the same route, so title calls consume the same recorded request budget.
Set `reviewer.maxSteps` below the gateway request cap to let OpenCode conclude with text before the proxy
denies another request. At least three requests beyond that step limit are reserved for final/auxiliary calls.
Set `gateway.normalizeStepLimitRole: true` for both treatments when using that limit: OpenCode's synthetic
`CRITICAL - MAXIMUM STEPS REACHED` notice is sent as a user instruction with `tool_choice: none`, instead of
an assistant message without `reasoning_content` that DeepSeek rejects. Actual model reasoning and tool
messages remain unchanged; the adapter never fabricates reasoning for a synthetic message.
Choose output limits that include reasoning tokens; an 8,192-token cap can truncate DeepSeek's reasoning
before it returns any review. Record such calibration calls separately and freeze a new experiment after a correction.

```sh
pnpm --silent review-bench freeze benchmarks/pr-review/study.json execution.json > frozen-study.json
pnpm --silent review-bench plan frozen-study.json benchmarks/pr-review/corpus.json > plan.json
pnpm --silent review-bench run plan.json execution.json .review-bench/snapshots .review-bench/run-01 > status.json
```

Supply `RB_GATEWAY_KEY` through an existing trusted environment wrapper. Never put its value in chat, shell
history, configuration JSON or Git. Only the gateway receives it; the reviewer gets a fake client credential.
Each trial has a new internal Docker network, a model-only proxy, read-only inputs, empty home/cache/session
storage, resource limits and a timeout. The proxy alone joins the configured model network. It permits only
the pinned chat-completion route, bounds requests/output tokens/input bytes, blocks hosted search/remote media,
and rejects a changed response model. Its separate usage journal cannot be edited by the reviewer.

All attempts, including failures, consume the request limit. Cost stays null for `unknown` or `subscription`
usage. These are call/token bounds, **not a dollar spending guarantee**; reconcile pricing/billing separately
before a paid pilot. Completed receipts resume without another call. Interrupted attempts without a final
receipt require reconciliation before retrying. A report shows recorded/pending slots; comparison requires the
entire paired schedule. A response cut off with `finish_reason: length` is an invalid trial.

The replay changes operational delivery: triage uses PR-Agent's local Git provider with frozen metadata/base
rules; Thermo runs the pinned OpenCode engine, captured instructions and read-only tools, returning a local
verdict. Paperclip tasks, publication, queue contention, warm caches and production network permissions are
outside this experiment. Report replay latency separately from production latency.

Coverage describes diff context made available, not proof that a model understood every line. Triage compares
the rendered diff with an uncapped rendering under the same ignore rules and records represented files.
Thermo records completed file reads; only a non-truncated diff read reaching EOF is complete. Missing/partial
reads and omitted files remain visible instead of being assumed covered.

## Judge and collect

```sh
pnpm --silent review-bench prepare-judge /path/to/ReviewBench > judge-source.json
pnpm --silent review-bench judge-export /path/to/trial /path/to/snapshot /new/judge-trial > judge-arguments.json
```

`prepare-judge` applies a small fingerprinted overlay to the pinned upstream checkout: export the classifier's
existing rationale in `results.details.json`. It changes neither prompts nor judgments. Without that rationale,
novel TP/FP findings remain unresolved. Ambiguous many-to-many matches require adjudication before one-to-one credit.

Install upstream dependencies in a separate environment beforehand. Run its judge (`pnpm exec tsx
scripts/eval/eval.ts`) with exported arguments plus fixed `--provider` / `--model`, a model-only network and a
separately budgeted proxy. Each export contains exactly one trial, exact reference bytes, frozen manifest and
checkout, and hides treatment names from the producer field. Never use `--ingest` during comparison: new valid
findings belong to the next reference revision. The local export/import commands do not invoke this external
judge or enforce its budget.

`judge-result` reads a JSON document with `trialRoot`, `snapshotRoot`, `judgeRoot`, `judgeRevision` (the frozen
source/overlay identity), and optional evidence overrides. It imports `results.json` / `results.details.json`,
checks exact reference bytes and finding order, and emits `evaluation.json`. Store it at
`evaluations/<job id>/evaluation.json`. Put its `provenance.judgeRevision` in `evaluations/judge.json` as
`{"judgeRevision":"..."}`. This identity hashes judge source/models/prompts; each PR retains its own reference hash.
Failed reviews and valid empty reviews require no judge inference.

```sh
pnpm --silent review-bench judge-result judge-files.json > evaluation.json
pnpm --silent review-bench collect plan.json .review-bench/run-01 .review-bench/snapshots evaluations > scored.json
pnpm --silent review-bench compare plan.json scored.json > comparison.json
```

Collection validates receipts, candidates, reference labels and usage journals, and refuses omitted trials or
changed measurement source. Store original judge outputs alongside imported evaluations so evidence remains auditable.
