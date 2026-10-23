# GitHub PR review sync (JOU-490)

Central dispatcher plugin: when a Paperclip issue with a linked pull request receives a native agent review decision (`executionState.lastDecisionOutcome`), publish a **formal** GitHub review (`APPROVE`, `REQUEST_CHANGES`, or `COMMENT`) using a dedicated GitHub App/bot identity (not the PR author).

## Configuration

Per company instance:

- `reviewBotTokenRef` — Paperclip secret reference for `GITHUB_REVIEW_BOT_TOKEN` (or equivalent App installation token).
- `publicOrigin` — optional public Paperclip base URL for issue deep links in review bodies.

Runtime may also read `GITHUB_REVIEW_BOT_TOKEN` from the worker environment when no secret ref is configured.

## Behavior

- Listens to `issue.updated`, reads `executionState.lastDecisionId` / `lastDecisionOutcome`.
- Resolves linked PRs from issue description, comments, and work-product artifacts.
- Idempotent receipts keyed by company, issue, decision, PR, head SHA, and GitHub event.
- Fail-closed on missing token, missing PR link, or self-review (bot login === PR author).
- The verdict block must be valid JSON, with one tolerated slip: raw control characters (U+0000 through U+001F)
  inside a string literal, typically the line breaks of a multi-line `summary`, are escaped before parsing. Line
  breaks, carriage returns and tabs are kept in the published text; the other control characters are removed by
  `sanitize` before publication. Any other broken JSON or invalid field is rejected with a comment on the issue.
- Persists receipt rows in plugin namespace `github_pr_review_sync`.
- Intake verdicts remain publishable after the reviewer marks its Paperclip issue `done`, including bounded
  retries after transient GitHub failures. Explicit cancellation, a closed PR and a changed PR head still stop
  publication. Native review decisions cannot bypass the intake verdict contract.

## Approval evidence for intake verdicts

The v1 verdict accepts an optional extension (old producers remain compatible):

```json
{"validation":{"headSha":"<reviewed 40-character SHA>","tests":{"status":"pass","source":"ci","checks":["unit-tests"]},"coverage":"complete"}}
```

Tests have status `pass`, `fail` or `partial` and source `ci`, `static` or `not_run`; code review coverage is
`complete` or `partial`. An approval requires a matching validation SHA, complete reported code review coverage,
and named successful test checks. The publisher independently reads check runs and commit statuses at that
SHA, including pagination. Missing, pending, skipped, neutral, unreadable or truncated CI cannot establish PASS.
Infrastructure annotations that say a check never started are PARTIAL, not a code finding.

Without this evidence an approval request is published as COMMENT with the missing execution evidence explicit.
Static analysis never establishes a passing test run. Proven blocker/major findings still request changes within
the repository's authority. The public body separates publisher-verified execution from the reviewer's assessment.
The verdict's receipt key is independent of changing CI, so replaying the same comment cannot silently upgrade
an earlier COMMENT to APPROVE. A new verdict comment is required for a new assessment.

The GitHub App needs read access to Checks and commit statuses to prove CI; missing permissions retain the
review as a comment. This gate does not change permissions or execute repository code.

## Tests

```sh
pnpm --filter @journey-studios/github-pr-review-sync test
```

## GitHub App

Set `githubApp: { appId, privateKeyRef }` to publish as a GitHub App with per-repository installation tokens. If it is set, a failure to get a token fails closed; `reviewBotTokenRef` is not used as a fallback.
