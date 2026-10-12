# Paperclip plugin MCP bridge

Private Node.js 24 stdio bridge that leaves the official Paperclip MCP server in place and adds five read-only tools from the Journey Studios Agent Observatory plugin. The bridge spawns the official server, forwards its JSON-RPC stream, and intercepts `tools/list`, calls to its own fixed tool names, and the actor-aware `paperclipMe` compatibility adapter. It does not modify Paperclip core or expose an HTTP listener.

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

The bridge advertises these names only after the stock server answers `tools/list`:

| Tool | Read-only plugin request |
| --- | --- |
| `paperclipAgentHealthOverview` | `GET /api/plugins/journey-studios.agent-observatory/api/overview?companyId=…&windowHours=…` |
| `paperclipDiagnoseAgent` | `GET …/api/agent?companyId=…&agentId=…&windowHours=…` |
| `paperclipListRunFailures` | `GET …/api/failures?companyId=…&windowHours=…&limit=…` |
| `paperclipFindAgentAnomalies` | `GET …/api/anomalies?companyId=…&windowHours=…&limit=…` |
| `paperclipTraceRun` | `GET …/api/trace?companyId=…&runId=…` |

The company ID is always inserted from deployment configuration. UUID inputs are validated, window hours are bounded to 1–168, result limits to 1–100, unknown input keys are rejected, API calls time out after 10 seconds, and response bodies are capped at 1 MiB. Each plugin response must include the exact pinned `companyId`, or the bridge rejects it. Plugin/network errors return a generic MCP tool error without returning HTTP bodies.

For trace, the bridge requests `/api/heartbeat-runs/:runId/events?companyId=…&limit=100` only when the plugin trace summary includes the exact configured `companyId`. It returns only allowlisted event fields (`seq`, `eventType`, `type`, `stream`, `timestamp`) and safe tool metadata (`toolName`, `name`, `status`, `durationMs`). `createdAt` is normalized into `timestamp`. Event payloads, raw logs, and all other event fields are discarded. The response preserves existing coverage metadata and adds `coverage.eventsAvailable`, `coverage.eventsTruncated`, and `coverage.nextSeq`; a full 100-event page is conservatively marked truncated. If event lookup fails, the trace summary remains available with `coverage.eventsUnavailable` set.

If the Observatory plugin is absent, ordinary stock Paperclip MCP tools remain available; the five added tools return a generic failure. A stock tool name collision with one of the five names makes `tools/list` fail closed with a generic JSON-RPC error.

## Deploy and rollback

Build/run this service as a sidecar or wrapper in the Paperclip container environment, mount only this service directory read-only, provide its three required environment values through the deployment secret mechanism, and point the MCP client at `node /path/to/plugin-mcp-bridge/src/bridge.mjs` using stdio. Keep the existing official server command and credentials unchanged. This bridge opens no public port; use the existing authenticated MCP transport if one is needed. Verify that `tools/list` includes the five names and that one stock tool call and one Observatory read-only call succeed before routing users to it.

Rollback by switching the MCP client command back to the existing official `paperclip-mcp-server` command and removing the bridge process/container. No Paperclip database migration or core change is made, so rollback does not require a data restore.

## Tests

Run `pnpm test`. Tests exercise protocol initialization and tool listing with a mock subprocess, stock tool forwarding/notifications, fixed company scoping, strict input validation, trace company proof, and event sanitization without external dependencies.

## Live verification

Run `node scripts/smoke.mjs` in the target MCP container with the existing API URL, company ID, and key environment. A deployment may set `PAPERCLIP_API_KEY_FILE` instead of an inline key; the script reads it into the child environment and never prints it. The check initializes the official server, verifies all five added tools, calls one stock tool and all Observatory tools, and rejects invalid bounds, a company override, and an unknown agent. It performs no writes or agent wakes.

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
