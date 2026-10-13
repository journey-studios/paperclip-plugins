# Paperclip plugin MCP bridge

Private Node.js 24 stdio bridge that leaves the official Paperclip MCP server in place and adds five read-only tools from the Journey Studios Agent Observatory plugin and ten tools from the Project Dashboards plugin: six for dashboards (list, read, live status, create/update, validate) and four for the per-project changelog (list, add, update, import completed issues). The bridge spawns the official server, forwards its JSON-RPC stream, and intercepts `tools/list`, calls to its own fixed tool names, and the actor-aware `paperclipMe` compatibility adapter. It does not modify Paperclip core or expose an HTTP listener.

## Configuration

Required environment:

| Variable | Purpose |
| --- | --- |
| `PAPERCLIP_API_URL` | HTTPS Paperclip base URL reachable from this process. |
| `PAPERCLIP_API_KEY` | Paperclip API bearer key. Never pass this as an argument or print it. |
| `PAPERCLIP_COMPANY_ID` | One UUID pinned at deployment; callers cannot choose a company. |

Optional subprocess override for local tests or a host-specific CLI location:

| Variable | Purpose |
| --- | --- |
| `PAPERCLIP_ALLOW_INSECURE_HTTP` | Set exactly `1` only to explicitly permit HTTP on a trusted private network; exposes the bearer key to that network. HTTPS is the default. Loopback HTTP (`localhost`, `127.0.0.1`, `[::1]`) is permitted for local use. |
| `PAPERCLIP_MCP_COMMAND` | Executable; defaults to `/app/node_modules/.bin/paperclip-mcp-server`. |
| `PAPERCLIP_MCP_ARGS` | JSON array of string arguments; defaults to `[]`. |

Run `node src/bridge.mjs` (or `pnpm start`) with stdin/stdout connected to the MCP client. Stdout is reserved for JSONL MCP messages. Subprocess stderr is discarded; bridge diagnostics are generic and go to stderr. The official CLI receives the same environment so it can keep using its existing authentication configuration.

## Added tools and plugin contract

### Agent Observatory (read-only)

The bridge advertises these names, together with the Project Dashboards names below, only after the stock server answers `tools/list`:

| Tool | Read-only plugin request |
| --- | --- |
| `paperclipAgentHealthOverview` | `GET /api/plugins/journey-studios.agent-observatory/api/overview?companyId=…&windowHours=…` |
| `paperclipDiagnoseAgent` | `GET …/api/agent?companyId=…&agentId=…&windowHours=…` |
| `paperclipListRunFailures` | `GET …/api/failures?companyId=…&windowHours=…&limit=…` |
| `paperclipFindAgentAnomalies` | `GET …/api/anomalies?companyId=…&windowHours=…&limit=…` |
| `paperclipTraceRun` | `GET …/api/trace?companyId=…&runId=…` |

The company ID is always inserted from deployment configuration. UUID inputs are validated, window hours are bounded to 1–168, result limits to 1–100, unknown input keys are rejected, API calls time out after 10 seconds, and response bodies are capped at 1 MiB. Each plugin response must include the exact pinned `companyId`, or the bridge rejects it. Plugin/network errors return a generic MCP tool error without returning HTTP bodies.

For trace, the bridge requests `/api/heartbeat-runs/:runId/events?companyId=…&limit=100` only when the plugin trace summary includes the exact configured `companyId`. It returns only allowlisted event fields (`seq`, `eventType`, `type`, `stream`, `timestamp`) and safe tool metadata (`toolName`, `name`, `status`, `durationMs`). `createdAt` is normalized into `timestamp`. Event payloads, raw logs, and all other event fields are discarded. The response preserves existing coverage metadata and adds `coverage.eventsAvailable`, `coverage.eventsTruncated`, and `coverage.nextSeq`; a full 100-event page is conservatively marked truncated. If event lookup fails, the trace summary remains available with `coverage.eventsUnavailable` set.

If the Observatory plugin is absent, ordinary stock Paperclip MCP tools remain available; the five Observatory tools return a generic failure. A stock tool name collision with any of the fifteen bridge tool names (five Observatory, ten Dashboards and changelog) makes `tools/list` fail closed with a generic JSON-RPC error.

## Project Dashboards tools (0.3.0)

Ten tools expose the board REST API of the `journeystudios.project-dashboards` plugin (no hyphen in `journeystudios`, unlike `journey-studios.agent-observatory`). A Project Dashboard is declarative JSON: `datasets` (rows plus title, description, source, `updatedAt`) and `sections` of blocks (`markdown`, `mermaid`, `callout`, `kpis`, `chart`, `table`, `statusList`). Numbers come from datasets, so an agent refreshes a dashboard by updating dataset rows rather than rewriting the spec. The plugin owns the spec schema; the bridge only checks that `spec` is a plain JSON object and relays the plugin's path-precise validation messages.

All paths below are under `/api/plugins/journeystudios.project-dashboards/api`.

Dashboards:

| Tool | Plugin request | Input | Writes |
| --- | --- | --- | --- |
| `paperclipListDashboards` | `GET /dashboards` | `{ projectId?: uuid }` | no |
| `paperclipGetDashboard` | `GET /dashboards/:slug` | `{ slug }` | no |
| `paperclipDashboardStatus` | `GET /dashboards/:slug/status` | `{ slug }` | no |
| `paperclipUpsertDashboard` | `POST /dashboards` | `{ slug, title?, projectId?: uuid, spec }` (`projectId` required when creating) | yes, idempotent by slug |
| `paperclipUpdateDashboardDataset` | `POST /dashboards/:slug/datasets/:datasetId` | `{ slug, datasetId, rows, columns?, description?, source?, updatedAt? }` | yes, idempotent |
| `paperclipValidateDashboardSpec` | `POST /validate` | `{ spec }` | no (dry run) |

There is deliberately no delete tool; deleting a dashboard stays a board UI action. Every dashboard belongs to a project (see the project rule below). Read and validate tools are annotated `readOnlyHint: true`; the two dashboard writers are `readOnlyHint: false, destructiveHint: false, idempotentHint: true`. All ten set `openWorldHint: false`.

### Dashboard project rule

Every dashboard belongs to a Paperclip project, and Paperclip groups dashboards by project (plugin 0.3.0 and later). `paperclipUpsertDashboard` takes `projectId` as a UUID only:

- **Creating** a dashboard requires `projectId`; without it the plugin answers 400 `project_required`.
- **Updating** an existing dashboard may omit `projectId`, which keeps its project; passing a UUID moves it to that project. An existing dashboard that has no project (a legacy one, or one whose project was deleted) can also be updated without `projectId` and stays projectless; the board UI lists all such dashboards together in a separate "No project" area with a move-to-project control. Dataset updates and `paperclipDashboardStatus` work on them too, and the status reports `orphan: true`.
- `projectId: null` is refused by the bridge itself with `Invalid input: projectId must be a project UUID (null is not accepted: …)` and no HTTP call. The tool schema no longer allows `null`, and `projectId` stays optional in it because updates may omit it.
- The plugin's 400s `project_required`, `project_not_found` (not a project of this company) and `project_archived` reach the model as plugin client errors, for example `Project Dashboards rejected the request (HTTP 400): project_required`, so it can pick a project and retry. `paperclipListDashboards` results carry `projectId` and `projectName` and can be filtered by `projectId`.

### Changelog tools

Plugin 0.4.0 and later keeps a dated, per-project changelog of how a project evolves (kinds `milestone`, `release`, `feature`, `fix`, `improvement`, `decision`, `incident`, `note`, written by agents and the board, plus `issue` entries it generates itself when an issue is completed, according to the company setting). Four tools expose it. Their descriptions tell the model when to record an entry (a merged PR, a validated deploy, a milestone, a decision, an incident or a release; one entry per relevant change, not one per run), what to put in `title`, `body` and `refs`, and that completed issues already arrive on their own.

| Tool | Plugin request | Input | Writes |
| --- | --- | --- | --- |
| `paperclipListChangelog` | `GET /changelog` | `{ projectId?: uuid, kinds?: kind[], includeIssues?: boolean, before?: string, limit?: 1-500 }` | no |
| `paperclipAddChangelogEntry` | `POST /changelog` | `{ projectId: uuid, kind, title, body?, version?, refs?, links?, occurredAt? }` | yes, **not idempotent**: every call adds an entry |
| `paperclipUpdateChangelogEntry` | `POST /changelog/:entryId` | `{ entryId: uuid, kind?, title?, body?: string \| null, version?: string \| null, refs?, links?, occurredAt? }`, at least one field | yes, idempotent |
| `paperclipImportChangelogFromIssues` | `POST /changelog/import` | `{ projectId: uuid }` | yes, idempotent: adds the completed issues that have no entry yet |

- `kinds` takes any of the nine kinds (`issue` included, to read generated entries); the writers only accept the eight curated kinds, because the plugin refuses `issue` on writes. `kinds` is sent as the plugin's comma-separated `kind` query parameter, `includeIssues` as `true` or `false`, and the list answers `{ entries, nextCursor }` (`nextCursor` is `null` at the end; pass it as `before`).
- Limits checked before any HTTP call: `title` 1-200 characters, `body` 1-20,000 (`null` clears it on update), `version` 1-64 (`null` clears it on update), `refs` at most 20 strings of 1-100 characters, `links` at most 20 `{ label, url }` objects (`label` 1-100 characters, `url` an absolute `http`/`https` URL of at most 2,000 characters, no other keys), `occurredAt` an ISO 8601 date or timestamp, `before` at most 200 characters. The plugin repeats these checks and answers 422 `invalid_entry` with path-precise `details`, which the bridge relays like any other 422.
- There is deliberately no delete tool. Deleting an entry stays a board UI action, and an entry generated from an issue cannot be edited (the plugin answers 400).
- `paperclipAddChangelogEntry` is annotated `readOnlyHint: false, destructiveHint: false, idempotentHint: false`, so clients know a retry can duplicate the entry; read `paperclipListChangelog` first when a call may already have succeeded. The import writes only entries the plugin would have recorded itself, never duplicates one, never restores an entry the board deleted, and reports `{ scanned, imported, skipped, truncated }`.

### Request contract

- Every request (GET and POST) carries `?companyId=<PAPERCLIP_COMPANY_ID>` from deployment configuration, the Bearer key from configuration, and `accept: application/json`; POST adds `content-type: application/json`. A company in the tool input is rejected as an unknown field. Redirects are rejected (the Bearer key is never forwarded elsewhere).
- Timeouts: 10 s for GET and 25 s for POST. Response bodies are capped at 1 MiB.
- Input is validated before any HTTP call and unknown keys are rejected (the changelog fields are listed above): `slug` `^[a-z0-9-]{1,64}$`; `datasetId` `^[A-Za-z0-9_-]{1,64}$`; `projectId` a UUID (`null` is rejected); `spec` a plain object; `rows` at most 10,000 plain objects; `columns` at most 200 non-empty strings of at most 200 characters; `title` 1-200 characters; `description` at most 10,000; `source` at most 500; `updatedAt` an ISO 8601 date or timestamp. Path segments are URL-encoded.
- The serialized request body must be at most 950,000 bytes (the host limit is 1,000,000). The bridge's existing 1 MiB limit per incoming JSON-RPC line still applies, so the practical ceiling for one call is slightly under 1 MiB; refresh large datasets with several `paperclipUpdateDashboardDataset` calls.
- Every plugin response body must carry `companyId` equal to the pinned company, otherwise the call fails closed. The echo is then dropped from the result.
- Dashboard calls share the existing concurrency limit of 8 in-flight bridge-handled tool calls (Observatory, Dashboards and `paperclipMe` together); a ninth gets a "busy; retry shortly" tool error.

### Results and errors

Successful calls return the plugin payload as compact JSON in the last `content` block, without the `companyId` echo. `paperclipDashboardStatus` prepends a one-line summary block (title, revision, health, stale dataset count, `updatedAt`).

Unlike the Observatory tools, the Dashboards tools surface the plugin's documented client errors, because the model needs them to correct a spec. Everything else stays generic and never echoes an upstream body:

| Situation | Tool result |
| --- | --- |
| Input fails validation (including a body over 950,000 bytes) | `isError`, bridge-authored `Invalid input: …` message; no HTTP call |
| HTTP 400, 404, 413 or 422 whose JSON body has the pinned `companyId` and a string `error` | `isError`: `Project Dashboards rejected the request (HTTP n): <error>`; for 413 also `limitBytes`; for 422 up to 50 `details` lines, each at most 300 characters, one per line prefixed with `- ` |
| HTTP 503, or HTTP 404 without a company echo (plugin or route not installed) | `isError`: `Project Dashboards plugin unavailable …` |
| Anything else: 5xx, 401/403/429, transport error, timeout, oversize or invalid body, missing or different `companyId` (even on 4xx) | `isError`: generic `Project Dashboards request failed …` |

A missing dashboard answers 404 `not_found` with the company echo, so it is reported as a normal client error and not as an unavailable plugin. The project rule's 400s (`project_required`, `project_not_found`, `project_archived`) are plugin client errors with the company echo and travel the same way. Stock tools and Observatory tools keep working when the Dashboards plugin is absent.

## Deploy and rollback

Build/run this service as a sidecar or wrapper in the Paperclip container environment, mount only this service directory read-only, provide its three required environment values through the deployment secret mechanism, and point the MCP client at `node /path/to/plugin-mcp-bridge/src/bridge.mjs` using stdio. Keep the existing official server command and credentials unchanged. This bridge opens no public port; use the existing authenticated MCP transport if one is needed. Verify that `tools/list` includes all fifteen names (five Observatory, ten Dashboards and changelog) and that one stock tool call, one Observatory read-only call and one Dashboards read-only call succeed before routing users to it.

Rollback by switching the MCP client command back to the existing official `paperclip-mcp-server` command (or to the previous bridge release directory, for example 0.1.1) and removing the bridge process/container. No Paperclip database migration or core change is made, so rollback does not require a data restore. Dashboards and changelog entries written through the bridge stay in the plugin and remain editable in the board UI.

## Tests

Run `pnpm test`. Tests exercise protocol initialization and tool listing with a mock subprocess, stock tool forwarding/notifications, fixed company scoping, strict input validation, trace company proof, and event sanitization without external dependencies. `test/dashboards.test.mjs` covers the Dashboards and changelog tools: tool catalog and annotations (including the non-idempotent `paperclipAddChangelogEntry`), the method/path/query/body of every tool, company pinning, input and body-size rejections, the 422/400/404/413 client-error policy and its truncation, generic 5xx handling, company-mismatch fail-closed, plugin-unavailable detection, the status summary, the shared concurrency limit and the GET/POST timeouts.

## Live verification

Run `node scripts/smoke.mjs` in the target MCP container with the existing API URL, company ID, and key environment. A deployment may set `PAPERCLIP_API_KEY_FILE` instead of an inline key; the script reads it into the child environment and never prints it. The check initializes the official server, verifies all fifteen added tools, calls one stock tool and all Observatory tools, and rejects invalid bounds, a company override, and an unknown agent. By default it performs no writes or agent wakes.

The Dashboards part of the smoke is read-only by default: it lists dashboards, validates a tiny spec (a dry run, nothing stored), checks the 422, 404 and input-bound error paths and that `projectId: null` is refused by the bridge before any HTTP call (it is sent with a deliberately invalid spec, so a regression could not store anything), and, when `SMOKE_DASHBOARD_SLUG` is set, reads that dashboard's status and spec. Setting `SMOKE_DASHBOARD_WRITE=1` additionally **writes**: it first reads the `mcp-bridge-smoke` dashboard. If it exists, the smoke upserts it without `projectId` (title "MCP bridge smoke test"), so it stays in its project or stays projectless. If it does not exist, `SMOKE_DASHBOARD_PROJECT_ID` (the UUID of a project in the configured company) is required to create it in that project; without it the script stops with a clear message before writing anything, and a value that is not a UUID is rejected before the bridge starts. It then refreshes the `smoke` dataset, reads it back and checks the status and the project. There is no delete tool, so that one dashboard stays until someone removes it in the board UI; leave the variable unset for production checks that must not write.

The changelog part is read-only by default as well: it lists the changelog (`paperclipListChangelog`, optionally scoped with `SMOKE_CHANGELOG_PROJECT_ID`, which must be a UUID and is validated before the bridge starts, and without issue entries) and checks that bad input (a `limit` of 0, a company override, the `issue` kind, an update without fields) is rejected without touching the network. Only when `SMOKE_DASHBOARD_WRITE=1` **and** `SMOKE_CHANGELOG_PROJECT_ID` are both set does it also write: it adds one `note` entry titled "MCP bridge smoke test <timestamp>" to that project, updates it (sets `version` and clears `body`) and reads it back. Adding is not idempotent, so every such run leaves one more `note` that can only be removed in the board UI. The smoke never calls `paperclipImportChangelogFromIssues`, because an import writes an entry for every completed issue of the project.

When wrapping a tunnel with a baked-in entrypoint script, mount both the service directory and the replacement entrypoint script read-only. Preserve the image, nonroot user, network, existing secret mounts, and the original profile. Back up the Compose file and original script before recreating only the MCP service. Verify tunnel health and run the live check again after activation.


## Actor-aware `paperclipMe` (0.1.1)

The stock tool describes an authenticated *actor*, but the installed native
implementation calls the agent-only `/api/agents/me`. Human/board keys are
valid credentials and still receive 401 on that route. Do not replace a
human key with an agent key, weaken the route, patch Paperclip core, or pick
an arbitrary agent to make the check succeed.

The existing bridge now adapts **only `paperclipMe`**:

| Authenticated principal / result | Behavior |
| --- | --- |
| Human/board: `/api/auth/profile` returns 200 and a valid profile | Return `{ actorType: "board", id, name, email, image }`; no role, company or agent identity is invented. |
| Native profile returns exactly 401 `Board authentication required` | Forward the original `paperclipMe` call unchanged to the official MCP server, which independently authorizes `/agents/me` and preserves its full agent response/denial. |
| Invalid/expired/revoked credential or missing user | Return a structured MCP tool error; do not fallback or reuse a cached identity. |
| 403, other HTTP failure, timeout, redirect, invalid JSON, oversized body | Fail closed with a sanitized error code; no raw HTTP body or credential is emitted. |

Uses only the already-configured bearer, no cookies or additional credential.
GET behavior matches the native MCP client's GET requests (no injected run
header). The human profile is not an authorization token and grants no new
permission. `paperclipInboxLite` and other agent-only tools remain native and
agent-only. This is not a universal health check for every MCP action.

No input arguments are accepted; the client cannot supply a user, agent,
company, API URL or key. Identity responses are capped at 64 KiB, reads time
out after 10 seconds, redirects are rejected, concurrency is bounded and
request IDs cannot collide with an in-flight identity request. The tool is
not duplicated in `tools/list`, including paginated catalogs. Names and other
native tool schemas are preserved.

### Verification without changing production identity

Run `pnpm test:coverage` in this service. Tests need only Node 24; they make
no external calls and exercise board, agent, invalid auth, revocation,
errors, injection, request bounds and the unchanged Observatory/native tools.

In the MCP runtime, use the existing secret-file environment and run:

```sh
PAPERCLIP_SMOKE_IDENTITY_ONLY=1 node scripts/smoke.mjs
```

This checks the real authenticated identity against its native endpoint,
reads the native company agent list, and proves that a board identity still
cannot use `/agents/me`. It prints only PASS metadata, not profile data or
credentials. The optional `PAPERCLIP_SMOKE_EXPECT_AUTH_FAILURE=1` mode is for
a **separate process with an explicitly invalid disposable test key**; it
must report `identity_unauthorized`. Never overwrite the production key file.

For rollout, stage this service under a new immutable release directory,
run the smoke there with the existing runtime and credentials, then change
only the read-only bridge mount in the existing MCP tunnel Compose service.
Recreate only that tunnel, not the app/database/runners or other connectors.
Keep its image, user, networks, secret mounts, profile and start script.
Back up the original Compose file and retain the previous bridge directory.
After deployment, test `paperclipMe` through the actual connector as well as
native issue reads and Observatory tools. An MCP session may need its normal
reinitialization after a tunnel restart. Roll back by restoring the previous
bridge mount and recreating only the same tunnel; no database rollback.
