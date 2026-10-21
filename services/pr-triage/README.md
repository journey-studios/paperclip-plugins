# pr-triage

PR-Agent (MIT) behind a small authenticated HTTP API. The `github-pr-intake` plugin uses it to post a quick,
advisory triage comment on pull requests. It never decides a verdict and never publishes anything itself.

## API

| Call | Purpose |
|---|---|
| `POST /v1/triage` `{repo, number, head_sha, token}` | Queues a review (202 with a job id). Idempotent per `repo#number@sha`. |
| `GET /v1/triage/{id}` | `queued`, `running`, `done` (with `result`) or `failed` (with `error`). 404 when the service forgot the job. |
| `GET /healthz` | Liveness, unauthenticated. |

Every call except `/healthz` needs `Authorization: Bearer $PR_TRIAGE_TOKEN`. Jobs live in memory (one hour), run
one at a time, and the per-job GitHub token is dropped as soon as the job ends.

The token the caller passes must be a short-lived, read-only installation token for that single repository
(the plugin mints it from its GitHub App with `contents`, `pull_requests` and `metadata` set to `read`).

## Configuration (environment)

`PR_TRIAGE_TOKEN` (required, 24+ characters) plus PR-Agent's own settings, for example:

```
OPENAI.KEY=<key of an OpenAI-compatible endpoint>
OPENAI.API_BASE=http://omniroute:20128/v1
CONFIG.GIT_PROVIDER=github
CONFIG.MODEL=openai/<model>
CONFIG.CUSTOM_MODEL_MAX_TOKENS=200000
CONFIG.LOG_LEVEL=INFO
CONFIG.AI_TIMEOUT=600
CONFIG.PUBLISH_OUTPUT=false
```

Keep `CONFIG.LOG_LEVEL=INFO`: PR-Agent's default (`DEBUG`) writes the pull request's source into the log.

## Run

Build the image next to `Dockerfile`, then start it with `compose.example.yml` (no published port, read-only
root filesystem, dropped capabilities, memory and CPU limits). Reach it from the plugin by container name on a
shared Docker network.

```
docker build -t pr-triage:local services/pr-triage
python -m unittest -v test_app   # run inside the image: docker run --rm -v "$PWD:/t" -w /t -e PYTHONPATH=/t:/app --entrypoint python pr-triage:local -m unittest -v test_app
```

The base image is pinned by digest on purpose; update it deliberately.
