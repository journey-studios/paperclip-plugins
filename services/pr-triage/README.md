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

## Repository rules (`.pr_agent.toml`)

Read from the repository's **default branch** for every job, so a pull request cannot change the rules it is
checked against. Only these keys are used; anything else in the file is ignored, so a repository can never point
the model endpoint, the token or the model elsewhere. A file that fails validation is rejected as a whole and the
job runs with the defaults; the result says why (`repo_rules`).

```toml
[pr_reviewer]
extra_instructions = "Conventions the reviewer should check in the diff."   # up to 4000 characters
num_max_findings = 5                                                        # 1 to 10

[ignore]
glob = ["apps/web/src/routeTree.gen.ts"]      # extends the service's own ignore list

# Risk radar: deterministic, no model involved. A hit is reported when a changed file matches `paths`
# (fnmatch: `*` also crosses directories) and, if given, an added line matches `added_matches` (a regex).
[[review_radar.rules]]
id = "rls-notes"
paths = ["supabase/migrations/*.sql"]
added_matches = "(?i)policy"
note = "Run the RLS check on staging before and after applying the migration."
```

The result carries `radar` (`[{id, note, files, more_files}]`) and `repo_rules` (`loaded`, `absent`,
`invalid: …` or `unreadable: GitHub <status>`) next to PR-Agent's fields.

## Configuration (environment)

`PR_TRIAGE_TOKEN` (required, 24+ characters) plus PR-Agent's own settings, for example:

```
OPENAI.KEY=<key of an OpenAI-compatible endpoint>
OPENAI.API_BASE=http://omniroute:20128/v1
CONFIG.GIT_PROVIDER=github
CONFIG.MODEL=openai/<model>
CONFIG.CUSTOM_MODEL_MAX_TOKENS=200000
CONFIG.MAX_MODEL_TOKENS=200000
CONFIG.LOG_LEVEL=INFO
CONFIG.AI_TIMEOUT=600
CONFIG.PUBLISH_OUTPUT=false
```

Set both context settings deliberately: PR-Agent takes the minimum of the model capacity and
`CONFIG.MAX_MODEL_TOKENS` (upstream defaults to 32000). Use a capacity supported by the configured route.
The wrapper applies `CONFIG.LOG_LEVEL` to the actual logger at startup and before each review. INFO or higher
is required; DEBUG is rejected because it writes prompts, source diffs and response metadata.

Every result includes `coverage` (complete, partial or unknown), the number of represented/changed files,
whether the diff was pruned, and a bounded list of omitted files. It compares the actual model input against
the uncapped upstream diff renderer. Ignored, binary or otherwise omitted files prevent a claim of complete
coverage. A measurement error is explicit unknown coverage. The intake comment and reviewer handoff carry
this limitation even when the model reports no findings. A changed PR head is rejected before inference.

`runtime` reports the configured model route, effective context limit and applied log level. A pooled route
is not a resolved model identity. Until provider evidence exists, `resolved_model` and `cost_usd` are null and
`billing` is unknown; a missing price is never reported as zero cost. Spotted tests are static evidence, not
test execution.

### DeepSeek through OmniRoute

Enable OmniRoute's built-in `deepseek` provider with a valid upstream credential. The native route is
`ds/deepseek-flash`; this differs from the Devin CLI bridge (`dva/...`) and OpenCode's free models (`oc/...`),
which have their own runtime and access requirements. Keep the upstream credential in the gateway and give
the services an OmniRoute key.

For triage, use these settings alongside the endpoint, context and logging settings above:

```text
CONFIG.MODEL=openai/ds/deepseek-flash
CONFIG.FALLBACK_MODELS=[]
```

The full OpenCode reviewer uses `model: omniroute/ds/deepseek-flash`. Register `ds/deepseek-flash` in the
custom `omniroute` provider's models map supplied through `PAPERCLIP_OPENCODE_PROVIDERS`:

```json
{
  "name": "DeepSeek V4.1 Flash",
  "reasoning": true,
  "tool_call": true,
  "interleaved": { "field": "reasoning_content" },
  "limit": { "context": 200000, "input": 167232, "output": 32768 }
}
```

Preserve the provider's existing `@ai-sdk/openai-compatible` package, endpoint and credential placeholder.
Set `PAPERCLIP_OPENCODE_SMALL_MODEL=omniroute/ds/deepseek-flash` as well, so auxiliary requests use the same
route. The operational context limit is deliberately below the upstream model's advertised capacity.

Without inference, check authenticated model discovery from both consumers, the upstream `/models` and
`/user/balance` endpoints, OpenCode's model resolution, and triage's effective settings. Avoid gateway tests
that can fall back to a chat completion; when provisioning through `/api/providers/bulk`, explicitly set
`validateKeys: false` and check authentication separately. Model discovery and available balance do not
prove that generation or tool calls work; those need a separately authorized live review. Keep billing
unknown until token usage and pricing are supported by provider evidence.

Before changing the running triage container, retain its environment for rollback and let pending jobs
finish and be collected by intake. Results live in memory, so an early restart can lose a completed result
and cause a second model request when intake resubmits it. Restore any temporary intake pause after the
new container is healthy.

## Run

Build the image next to `Dockerfile`, then start it with `compose.example.yml` (no published port, read-only
root filesystem, dropped capabilities, memory and CPU limits). Reach it from the plugin by container name on a
shared Docker network.

```
docker build -t pr-triage:local services/pr-triage
python -m unittest -v test_app test_repo_rules   # run inside the image: docker run --rm -v "$PWD:/t" -w /t -e PYTHONPATH=/t:/app --entrypoint python pr-triage:local -m unittest -v test_app test_repo_rules
```

The base image is pinned by digest on purpose; update it deliberately.
