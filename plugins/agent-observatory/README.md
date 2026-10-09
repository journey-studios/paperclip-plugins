# Agent Observatory

Agent Observatory is a read-only Paperclip plugin that summarizes heartbeat runs and reported cost events, highlights heuristic signals, and exposes a safe run trace. The UI is registered at `/observatory`; its scoped API lives under `/api/plugins/:pluginId/api/`.

The agent table is horizontally scrollable in narrow layouts and its scroll region accepts keyboard focus. Long agent IDs remain available as hover titles instead of stretching table columns.

The plugin registers company-scoped GET routes for `overview`, `agents`, `agent`, `failures`, `anomalies`, `trace`, and `tools`, plus the read-only agent tools `observatory_overview` and `observatory_trace`. API routes use board authorization. Native agent tools use the current run's company scope.

Every core-table query binds the authorized company ID and uses the `public` schema. Queries select only status, lifecycle timestamps, safe error codes, identifiers, and reported costs. The plugin never returns run context snapshots, result payloads, adapter configuration, raw error text, stdout, or stderr.

## Coverage and cost

Summary and per-agent counters are SQL aggregates over the complete requested window (1–168 hours, default 24). Agent rows paginate at 100 maximum. Failure lists and heuristic anomaly detection examine at most the newest 1,000 runs; each response reports that limit and whether the window contains more runs. Heuristics are labeled `suspected` and include only compact evidence.

Only `cost_events` with `cost_status = 'reported'` contribute known cents. Missing or unpriced cost for a settled run remains unknown. Reported cents are the recorded charge; this plugin does not infer a subscription plan price or treat a zero charge as zero usage. Raw event streams and logs are not available through this plugin.

No plugin-owned tables or migrations are created. The declared namespace exists to satisfy Paperclip's plugin database lifecycle contract.

## Canonical delivery quality

Human feedback is recorded against an exact work-product revision by the core delivery-evaluations API. The Observatory reads those immutable evaluations and execution-profile snapshots; it does not write or reconstruct grades. The UI provides a **Qualidade de entregas** view and a per-agent detail with rubric/contribution cohorts, reviewer count, samples, and partial coverage. Every sample links to `GET /api/companies/:companyId/work-products/:workProductId/evaluations?revisionId=...&evaluationId=...`, resolving the exact reviewed revision and evaluation. The same read is available through plugin `GET /quality` and read-only MCP tool `paperclipDeliveryQuality` (native Paperclip tool: `observatory_delivery_quality`); `environment=production|skill_test` keeps production grades separate from Skills Studio tests.

Each delivery contributes one mean grade per comparable cohort after averaging multiple reviewers on that delivery. Cohorts keep rubric, evaluated agent, contribution role, reviewer type, and captured execution context separate. Final, eligible production feedback is aggregated; formative, self-review, unattributed, superseded, and controlled-test grades are excluded from production. Missing grades remain missing. Coverage counts are partial: the tracked-revision denominator includes only exact revisions linked to an origin or publisher run profile, and board-confirmed attribution may be outside that denominator. Query truncation suppresses aggregate scores rather than presenting a capped sample as the full cohort.

The plugins require a host schema with `delivery_revisions`, `delivery_evaluations` (including `controlled_test_ref`), and `run_execution_profiles`, plus the core API that resolves a feedback link to the requested historical revision/evaluation. The public compatibility patch only adds these names to the plugin read allowlist; it does **not** install or migrate database tables. Install the matching private runtime/core migration before enabling these plugin versions. Older hosts return an explicit schema-unavailable response.

Profiles contain only safe fingerprints and selected-skill references, not raw instructions or configuration. Verified native runtime context (`runtimeContextCoverage=native_verified`) can expose aggregate, prompt, instruction-bundle, skill-bundle, and MCP digests without revealing their contents. A skill marked `selected` was exposed in the run profile; it does not prove invocation or semantic use (`usage` remains `unknown`). Configured model is not effective-model evidence. Adapters without runtime proof report effective model as unknown, and comparisons requiring model identity stay inconclusive. Skill-version comparisons also require known target bytes, complete comparable context, unchanged reviewer population, and adequate samples. Org Tracker results are temporal associations, not causal findings; controlled Skills Studio pairs apply only to their exact input and never flow into production scores.

## Development

From the plugins monorepo, run `node --test shared/delivery-quality.test.js`, `pnpm --filter @journey-studios/agent-observatory test`, `pnpm --filter @journey-studios/agent-observatory typecheck`, and `pnpm --filter @journey-studios/agent-observatory build`. The root `pnpm test` includes the shared delivery-quality contract tests.

## Isolation boundary

This package has its own worker, API routes, UI bundle, and lifecycle. It makes no Paperclip core patch and declares no core write capability. Paperclip plugins are trusted extensions: the worker is not a hostile-code sandbox and UI runs in the host origin. The administrative MCP wrapper is a separate process with fixed company scope; it does not grant board access to agent tools.

The installed SDK binds arrays as SQL tuples. Cost lookups therefore use scalar UUID placeholders and skip empty ID lists; do not pass a JavaScript array to `ANY($n::uuid[])` through `ctx.db.query`.


## Monthly cost report (reported ledger values only)

The Observatory owns `getMonthlyCosts()` and reuses it for plugin-contributed Telegram `custos [AAAA-MM]`, native agent tool `observatory_monthly_costs`, MCP tool `paperclipMonthlyCosts`, and a board-authenticated scoped API route `/monthly-costs`.

The report shows month-to-date (São Paulo timezone) **USD amounts recorded in Paperclip**, first aggregated by execution provider/API (Gemini/Google, DeepSeek, Cursor, etc.), independent of any shared biller and then by agent reporting group. Unpriced usage is shown separately and is **not** silently counted as free. Provider quotas, wallet balances, subscription invoices and missing events are outside this ledger.

**Telegram ingress is pending:** provider registration/dispatch is implemented but the existing native Telegram parser does not yet forward arbitrary slash commands. See [Telegram Command API v1](../../docs/telegram-command-api-v1.md). No Paperclip core changes are part of this feature.
