# Performance Observatory

Native Paperclip plugin for private Lighthouse history, scheduled and on-demand reviews. No GitHub
Actions, CI provider, LHCI server or public report upload is required. This is synthetic monitoring,
not real-user monitoring.

The sidebar and project tab show score, FCP, LCP, TBT, CLS, transfer bytes, request counts and UI-ready
timings. Series separate target, environment, scenario, cache, device, Lighthouse and Chrome version.
Every review preserves six samples, build identity, arithmetic means and failures. A below-goal score
is valid evidence; an invalid or incomplete collection never becomes a favorable score.

## Commands for agents and external clients

Native tools: `request_review({targetKey,requestKey})`, `list_targets({})`,
`list_runs({targetKey?,environment?,limit?})`, `get_run({runId})`.
The host derives company identity from the agent execution, never the tool payload.
Use a stable request key when retrying a submission: the same target and key returns the same run.

Private authenticated API (Paperclip board session or board API key):

```
GET  /api/plugins/journey-studios.performance-observatory/api/targets?companyId=COMPANY
POST /api/plugins/journey-studios.performance-observatory/api/reviews?companyId=COMPANY
     {"targetKey":"prod-chat-reload","requestKey":"your-stable-request-id"}
GET  /api/plugins/journey-studios.performance-observatory/api/runs?companyId=COMPANY&limit=50
GET  /api/plugins/journey-studios.performance-observatory/api/runs/RUN_ID?companyId=COMPANY
```

`list_runs` returns status and cold/warm metrics. `get_run` includes every sanitized sample. The
external Paperclip connector can call these routes with `paperclipApiRequest` too.

The packaged CLI reads `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` and `PAPERCLIP_COMPANY_ID` from the
environment. Supply secrets through an existing secret manager; never put a key in a URL or argument.

```
performance targets
performance review prod-chat-reload
performance runs prod-chat-reload
performance show RUN_ID
```

## Configuration

Configure the controller URL, a company-scoped Paperclip secret reference and targets in the native
plugin company settings. Target fields: key, title, projectId, URL, environment (`prod`, `staging`,
`test`), scenario (`reload`, `home-to-chat`, `page`), profile (`mobile`, `desktop`), authProfile,
enabled, intervalMinutes (15–10080; default 360), selectors and optional startUrl.

Authenticated targets require `ready` and `history` selectors. `home-to-chat` requires startUrl and
`click`; optionally `conversation` chooses an existing conversation after opening chat. No messages
are sent. Production and staging sessions are separate. A missing session produces a visible failed
review; it never substitutes the production account for staging.

## Execution and validity

The native one-minute job queues due slots and reconciles results. The controller serializes requests.
It starts one `docker run --rm` container with 2 CPUs, 3 GiB RAM, 512 PIDs, a read-only root filesystem
and private temporary storage. After the process ends only sanitized result JSON remains. There is no
idle Chrome/container. The controller is a small authenticated private launcher, not a browser runner.

Each run uses pinned Lighthouse 13.4.1 and `lhci collect` plus `lhci assert`. Actual Chrome version is
recorded. Three cold HTTP-cache runs and three independently warmed runs are collected, with a new
browser per sample. HTTP cold does not imply an empty backend KV/auth cache. UI journey timing is
measured in a separate preparation phase; Lighthouse itself measures navigation to the final URL.
The audit requires document HTTP200, exact final origin/path, network evidence, controlled cache,
finite metrics, stable build before/after each sample, and a stable build across the entire cohort.
Authenticated audits additionally require a sessionless negative control, successful threads or
conversations response and composer/history DOM evidence during the audited navigation.

Warm arithmetic mean must be strictly greater than 94; cold ideally greater than 70. The history
labels below-goal reviews separately; it does not infer a causal regression from the previous build.
Only comparable device/engine/scenario cohorts should be used to attribute improvements.

Raw Lighthouse reports can contain sensitive URLs/content: they exist only inside the ephemeral
container's private temp directory and are deleted. SQL/UI/API persist a strict metrics allowlist.
No cookies, tokens, message bodies, signed URLs or screenshots are exported. Main Git SHA is not
treated as a Vite content hash; `/version.json` supplies the product build anchor.

## Development and rollout

Use the repository SDK bootstrap, pnpm install, this plugin's tests and build. The launcher and
ephemeral image live in `services/performance-runner`. Install a self-contained packed candidate
through the existing Paperclip local-path install endpoint. No core patch or app restart is required.
Rollback disables this plugin and stops its launcher; existing Paperclip plugins and canonical UX
capture remain independent. Preserve completed rows and private controller state.
