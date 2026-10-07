# Paperclip plugin MCP bridge

Private Node.js 24 stdio bridge that leaves the official Paperclip MCP server in place and adds five read-only tools from the Journey Studios Agent Observatory plugin. The bridge spawns the official server, forwards its JSON-RPC stream, and only intercepts `tools/list` plus calls to its own fixed tool names. It does not modify Paperclip core or expose an HTTP listener.

## Configuration

Required environment:

| Variable | Purpose |
| --- | --- |
| `PAPERCLIP_API_URL` | Paperclip base URL reachable from this process. |
| `PAPERCLIP_API_KEY` | Paperclip API bearer key. Never pass this as an argument or print it. |
| `PAPERCLIP_COMPANY_ID` | One UUID pinned at deployment; callers cannot choose a company. |

Optional subprocess override for local tests or a host-specific CLI location:

| Variable | Purpose |
| --- | --- |
| `PAPERCLIP_MCP_COMMAND` | Executable; defaults to `/app/node_modules/.bin/paperclip-mcp-server`. |
| `PAPERCLIP_MCP_ARGS` | JSON array of string arguments; defaults to `[]`. |

Run `node src/bridge.mjs` (or `npm start`) with stdin/stdout connected to the MCP client. Stdout is reserved for JSONL MCP messages. Subprocess stderr is discarded; bridge diagnostics are generic and go to stderr. The official CLI receives the same environment so it can keep using its existing authentication configuration.

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

Run `npm test`. Tests exercise protocol initialization and tool listing with a mock subprocess, stock tool forwarding/notifications, fixed company scoping, strict input validation, trace company proof, and event sanitization without external dependencies.

## Live verification

Run `node scripts/smoke.mjs` in the target MCP container with the existing API URL, company ID, and key environment. A deployment may set `PAPERCLIP_API_KEY_FILE` instead of an inline key; the script reads it into the child environment and never prints it. The check initializes the official server, verifies all five added tools, calls one stock tool and all Observatory tools, and rejects invalid bounds, a company override, and an unknown agent. It performs no writes or agent wakes.

When wrapping a tunnel with a baked-in entrypoint script, mount both the service directory and the replacement entrypoint script read-only. Preserve the image, nonroot user, network, existing secret mounts, and the original profile. Back up the Compose file and original script before recreating only the MCP service. Verify tunnel health and run the live check again after activation.
