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
- **Existing PRs are not reviewed.** The first reconcile of a repository only records the PRs that are
  already open (a later push or a newly opened PR is reviewed normally). Set
  `reviewExistingPullRequests: true` on the repository to review them too.
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

## GitHub App

Instead of static tokens, set `githubApp: { appId, privateKeyRef }` (the key is a Paperclip secret holding the PEM). The plugin then mints a short-lived installation token per repository and never falls back to `githubTokenRefs` if the App cannot. The App needs Pull requests (read/write), Contents (read) and Metadata (read), and the `pull_request` event pointed at this plugin's webhook.

## What the reviewer receives

The review issue is self-contained, so the reviewing agent needs no GitHub credentials:

- the pull request's **diff** (bounded: 6000 characters per file, about 48000 in total; binary or very large files are
  listed as having no textual diff), fenced so nothing in it can close the fence, with HTML comment delimiters neutralized;
- the **CI evidence** at the head commit (check runs and commit statuses). If checks are still running, the plugin adds
  one comment to the issue with their final result (waiting up to 45 minutes); nothing is added to a finished issue or
  for a head that is no longer under review. If the CI cannot be read, the package says so and asks for a PARTIAL gate.

Reading checks needs the GitHub App permissions **Checks: Read-only** and **Commit statuses: Read-only**. Without them
the package states that CI is unavailable and the review proceeds.

## Quick triage (optional)

A repository can also get a fast, advisory comment from a second reviewer (PR-Agent, served by `services/pr-triage`).
It is a first-pass signal only: it never blocks a merge and never produces a verdict; the review issue and its
verdict stay the only gate.

- Company-wide: `triageService: { url, tokenRef }` (the service's base URL and the secret holding its bearer token).
- Per repository: `triage: true`. It needs a GitHub App (`githubApp`): the service is handed a read-only,
  single-repository installation token, which a static token cannot provide, so static-token setups are refused.
- One comment per pull request, found by a hidden marker (and only if a bot wrote it), updated on every new head.
  An answer about a head that is no longer current is dropped. If the service is down the review issue is created
  as usual and the triage is retried (up to three attempts, thirty minutes).
- The repository's own rules live in `.pr_agent.toml` on its default branch (a pull request cannot change the
  rules it is checked against): reviewer guidance for PR-Agent and a deterministic risk radar of path rules. See
  `services/pr-triage/README.md` for the format. A rules file that cannot be applied is named on the comment.
- When the triage has radar hits or model findings and the review issue for that same head is still open, they are
  added to the issue as one "Triage hypotheses" comment: the reviewer verifies each point before reporting it, so a
  diff-only false positive is dismissed before anything is published.

## Worktree of the PR (optional)

The reviewer agent has no checkout of the repository. With a worktree it can read whole files and related code,
not only the diff.

- Company-wide: `workspaceService: { url, tokenRef }` (the `services/review-workspaces` service).
- Per repository: `worktree: true`. Like triage it needs a GitHub App: the service gets a read-only,
  single-repository installation token per request.
- Each new head asks for a worktree at that exact commit (`refs/pull/N/head`, so forks work). The issue (or the
  new-head comment) names its path and the marker file the reviewer waits for. A failed request never stops the
  review: the package says to review from the diff.

## Delivery commands

Every package ends with a "Commands" section: the exact calls to read the issue's comments, post the verdict and mark
the issue done. Without it reviewers spent most of each run reverse-engineering the contract (listing other issues,
grepping plugin bundles and the server for the markers).

## Operations

- `killSwitch` (per company or per repository) pauses reviews; queued PRs resume when it is switched off.
- Deliveries are recorded by the host in `plugin_webhook_deliveries`; reconcile results are logged by the job.
- Tokens and the webhook secret are resolved per call and never cached or logged.

## Tests

```
node --test        # Node >= 24.11
```
