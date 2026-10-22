# review-workspaces

Prepares a git worktree of a pull request at its exact head commit, so the reviewer agent can read whole files
(not only the diff) without holding GitHub credentials. The `github-pr-intake` plugin requests one per review
and points the review issue at it.

## API

| Call | Purpose |
|---|---|
| `POST /v1/workspaces` `{repo, number, head_sha, token}` | Queues the worktree (202 with `path`, `marker`, `status`). Idempotent per `repo#number@sha`; a failed attempt is retried. |
| `GET /healthz` | Liveness, unauthenticated. |

Every call except `/healthz` needs `Authorization: Bearer $REVIEW_WORKSPACES_TOKEN`. The `token` is a short-lived,
read-only installation token for that one repository (minted by the plugin from its GitHub App). It is used only in
the environment of the git commands (`http.extraHeader` via `GIT_CONFIG_*`): never in argv, a URL or on disk.

## Layout

Under `WORKSPACES_ROOT` (default `/paperclip/review-worktrees`):

- `.mirrors/<owner>/<repo>.git`: one bare, shallow mirror per repository (`FETCH_DEPTH`, default 200).
- `<owner>__<repo>/<number>-<sha12>`: detached worktree at the head commit (`refs/pull/N/head`, so forks work).
- `<owner>__<repo>/<number>-<sha12>.ready`: written when the job ends, `ok` or `error: …`. The reviewer waits for it.

Worktrees are removed after `WORKSPACE_TTL_HOURS` (default 24) and beyond the newest `MAX_WORKTREES` (default 40);
there is nothing to call for cleanup.

The volume must be mounted at the same path here and in the Paperclip app container (a worktree's `.git` file names
its mirror by absolute path), and the service runs as uid 1000, the agents' uid. See `compose.example.yml`.

## Run

```
docker build -t review-workspaces:local services/review-workspaces
docker run --rm -v "$PWD:/t" -w /t -e PYTHONPATH=/t --entrypoint python review-workspaces:local -m unittest -v test_app
```
