# GitHub PR intake

Listens to GitHub pull requests and routes each one to a Paperclip review agent. It is the
"intake" half of the review pipeline; `github-pr-review-sync` publishes the verdict back to GitHub.

```
GitHub webhook (pull_request) ─► signature check ─► dedupe ─► queue ─► debounce
        ▲                                                         │
        └── reconcile job (every minute) recovers missed events ──┘
                                                                  ▼
            review issue (assigned to the reviewer) ─► wake ─► verdict comment
```

## Behaviour

- **Events:** `opened`, `reopened`, `ready_for_review` and `synchronize` request a review. `closed` and
  `converted_to_draft` cancel the open review. Drafts are skipped.
- **One request per head SHA.** The current head is fetched from GitHub before every review, so a stale
  webhook can never review an old commit. Replayed deliveries (`X-GitHub-Delivery`) are ignored.
- **Pushes are debounced** (`debounceSeconds`, default 60, capped at 10 minutes) and land on the same
  issue as a new round, up to `maxRoundsPerPr` (default 3).
- **Capacity:** at most `maxConcurrentReviews` review issues are open at once; the rest wait.
- **Reconcile** lists open PRs every minute (conditional requests, so an unchanged repository is free) and
  enqueues any PR whose head was never reviewed, so a missed webhook costs at most a minute.
- **Safe defaults:** `authority` defaults to `comment`; bots are skipped; `skip-review` label skips a PR.

## Routing

`repositories[].rules` are evaluated in order, first match wins, and a rule matches only when **all** of
its criteria match (`paths` globs, `labels`, `authors`, `baseBranches`). A rule without criteria never
matches. Anything unmatched goes to `defaultReviewerAgentId`.

## Verdict contract (shared with `github-pr-review-sync`)

Every review issue starts with a machine-readable header and tells the reviewer to answer with one
comment containing:

```
<!-- paperclip-review-verdict
{"v":1,"repo":"owner/repo","number":1,"headSha":"<reviewed sha>",
 "outcome":"approve|request_changes|comment","summary":"...",
 "findings":[{"severity":"blocker|major|minor|nit","path":"file","line":1,"message":"..."}]}
-->
```

The header (`paperclip-pr-intake`) carries the repository's `authority`, which caps the outcome the
publisher may use. The pull request itself is passed as untrusted data, never as instructions.

## Setup

1. Create secrets in Paperclip for the webhook secret and for one GitHub token per repository owner
   (read access to pull requests; the bot account that publishes reviews needs access to the repository).
2. Configure the plugin **per company** (the host stores plugin configuration per company, so a repository
   belongs to the company whose configuration lists it). Example; ids are placeholders:

   ```json
   {
     "webhookSecretRef": { "type": "secret_ref", "secretId": "…" },
     "githubTokenRefs": { "journey-studios": { "type": "secret_ref", "secretId": "…" } },
     "maxConcurrentReviews": 3,
     "repositories": [
       {
         "fullName": "journey-studios/example",
         "defaultReviewerAgentId": "…",
         "authority": "comment",
         "rules": [{ "reviewerAgentId": "…", "paths": ["packages/billing/**"] }]
       }
     ]
   }
   ```

   A webhook does not say which company it is for, so the plugin reads every company's configuration and
   accepts a delivery only for the repositories of the company whose webhook secret signed it.

3. Add a GitHub webhook (content type `application/json`, event `pull_request`, same secret) pointing to
   `https://<paperclip-host>/api/plugins/journey-studios.github-pr-intake/webhooks/github`.

## Operations

- `killSwitch` (per company or per repository) pauses reviews; queued PRs resume when it is switched off.
- Deliveries are recorded by the host in `plugin_webhook_deliveries`; reconcile results are logged by the job.
- Tokens and the webhook secret are resolved per call and never cached or logged.

## Tests

```
node --test        # Node >= 24.11
```
