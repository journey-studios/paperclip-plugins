# Automatic PR Review Orchestrator

Event-driven GitHub pull request reviews inside Paperclip, backed by a **durable Postgres queue**. Creates one Paperclip Issue per repository/PR/head SHA, then wakes an existing code reviewer (such as **Thermo — Nuclear Reviewer**) on demand. The plugin does **not** run an agent on a schedule and **does not publish GitHub reviews itself**: the central JOU-490 GitHub review publisher is the sole authority.

## Current release (0.1.0)

- Ingress: signed GitHub `pull_request` webhooks (`opened`, `ready_for_review`, `reopened`, `synchronize`, `converted_to_draft`, `closed`).
- Strict GitHub `X-Hub-Signature-256` validation on exact raw request bytes, constant-time comparison; max 512 KiB; model titles and diffs are treated as untrusted.
- Company-specific, allowlisted `repository -> projectId, reviewerAgentId` routes, configured with a Paperclip `secret_ref`. An overlap between companies fails closed.
- Per-SHA unique record and Paperclip Issue; one active review **per agent** enforced by a Postgres partial unique index and conditional atomic claim. No in-memory queue lock.
- `agent.run.finished/failed/cancelled`, `issue.updated` and a lightweight 5-minute reconciliation job reclaim capacity and dispatch subsequent Issues; bounded wake retries and observable failed jobs.
- Out-of-order events supersede only older pending SHAs by the GitHub `updated_at`; in-flight reviewers must check current head before submitting findings. Draft/closed events do not kill in-flight work.
- Success means review execution produced a handoff / Issue advanced, **not** that GitHub accepted an `APPROVE` or `REQUEST_CHANGES`. Completed jobs enter `awaiting_publication`; the JOU-490 publisher must provide the actual GitHub review receipt.

**Scope:** A first event-driven, capacity=1 reviewer. No automatic merge/deploy, no hidden GitHub token, no general-purpose source executor. Additional parallel capacity should use a distinct reviewer-agent pool after JOU-39 (native runnable scheduler) is proven.

## Installation and configuration

Build with pnpm in this monorepo, verify the package, and install through the existing Paperclip plugin installation flow. No core patch is needed for declared SDK capabilities, but the running host must implement plugin webhooks, company-scoped config replay, Issues and wakeup APIs.

Set plugin config **for each company** in Paperclip:

```json
{
  "enabled": true,
  "reviewerAgentId": "REPLACE_WITH_PAPERCLIP_REVIEWER_AGENT_UUID",
  "githubWebhookSecretRef": {
    "type": "secret_ref",
    "secretId": "REPLACE_WITH_PAPERCLIP_SECRET_UUID",
    "version": "latest"
  },
  "repositories": [
    {
      "fullName": "wallynm/tesselapp",
      "projectId": "REPLACE_WITH_PAPERCLIP_PROJECT_UUID"
    }
  ],
  "maxAttempts": 2,
  "ignoreDrafts": true
}
```

Import the shared webhook secret using Paperclip's secret provider; **do not** store plaintext secrets in the config, repository, database, Issue comments, or logs. The GitHub repository webhook must use that exact secret, `Content type: application/json`, and the Paperclip host endpoint:

```
POST /api/plugins/journeystudios.pr-review-orchestrator/webhooks/github
```

Enable GitHub **Pull requests** events. A single endpoint can accept multiple allowlisted repositories, but a repo may be mapped to only one company. Initial activation is **disabled by default**. Configure and verify a staging endpoint first; do not point production PRs at staging or vice versa.

## Review Issue / queue lifecycle

```
Webhook -> authenticate HMAC -> allowlist -> queue insert (repo,PR,SHA unique)
        -> claim one reviewer slot -> create/reuse Paperclip Issue
        -> issues.requestWakeup(idempotencyKey for repo,PR,SHA)
        -> agent reviews pinned SHA -> Issue/handoff -> JOU-490 publisher
        -> release slot -> next PR
```

Statuses: `queued`, `dispatching`, `running`, `awaiting_publication`, `failed`, `superseded`, `closed`. Each SHA keeps its own history. A late old webhook may not displace a newer pending revision. The plugin never approves, merges, deploys or self-reviews on GitHub.

**Failure recovery:** A crash after claiming a slot is reconciled using the Paperclip Issue state; recovery never blindly wakes a running Issue. Transient wake failures retry with a bounded backoff and reuse the Issue. After max attempts, the job is `failed` for operator triage, not silently discarded. Reconciliation every five minutes executes only database/Issue operations (no LLM). The Postgres partial unique constraint blocks simultaneous reviewer execution even under concurrent webhook deliveries.

**Publication gate:** `awaiting_publication` is **not** equivalent to a GitHub review receipt. JOU-490 should reconcile Paperclip verdict → GitHub review with a distinct GitHub App/bot identity, record review ID + exact SHA, reject stale heads and prevent auto-merge while blocking findings exist. Do not ship an alternate publisher in this plugin.

## Development and validation

```sh
pnpm install --frozen-lockfile
pnpm --filter @journey-studios/paperclip-pr-review-orchestrator typecheck
pnpm --filter @journey-studios/paperclip-pr-review-orchestrator test
pnpm --filter @journey-studios/paperclip-pr-review-orchestrator build
```

Tests `test/*.spec.js` run Node assertions and PostgreSQL-compatible [PGlite](https://github.com/electric-sql/pglite) to verify HMAC, cross-company routing, three PRs queued, concurrent claims, SHA supersession and recovery. The full repository's `pnpm check` requires bootstrapping the pinned Paperclip SDK first.

### Required production evidence before enabling

1. Install plugin in test Paperclip host, configure secret and one allowlisted repository, inspect plugin health.
2. Deliver an actual GitHub signed PR webhook, verify Paperclip Issue identity and exact SHA.
3. Open three test PRs: observe at most one reviewer run, queued successors, and no duplicate runs on redelivery.
4. Push a new SHA while a review is active; old verdict must not be published as current.
5. Simulate webhook replay, crash during dispatch, failed wakeup and restart; ensure no duplicate charges/runs or stuck slots.
6. Verify JOU-490 posts an **actual** GitHub `REQUEST_CHANGES` / `APPROVE` through a different reviewer identity and stores the GitHub review ID.
7. Verify rollback: `enabled=false` immediately stops admitting new webhook work; disable/uninstall plugin only after resolving in-flight reviews.

**Dependencies:** JOU-39 (native agent scheduler, not yet marked fully validated), JOU-38 (recovery reliability) and JOU-490 (GitHub review publisher). These are independent gates, not prerequisites to authoring/testing this standalone plugin.
