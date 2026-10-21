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
- Persists receipt rows in plugin namespace `github_pr_review_sync`.

## Tests

```sh
pnpm --filter @journey-studios/github-pr-review-sync test
```

## GitHub App

Set `githubApp: { appId, privateKeyRef }` to publish as a GitHub App with per-repository installation tokens. If it is set, a failure to get a token fails closed; `reviewBotTokenRef` is not used as a fallback.
