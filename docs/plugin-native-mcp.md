# Direct MCP endpoints inside Paperclip plugins

**Status: experimental; not deployed.** The Observatory, Artifact Library and Evolution endpoints below remain read-only. The S3 Storage plugin owns a separate strict mutating endpoint for its upload/catalog actions. This work does not change Paperclip core, Tool Gateway, the official `@paperclipai/mcp-server`, `paperclip:agy`, or the currently deployed administrative bridge.

## Design

Each plugin declares a `POST /mcp` route in its **own** `manifest.apiRoutes[]`, requiring `auth: "board"` and host-validated `companyResolution`. The host mounts it at:

```text
https://paper.journeystudios.com.br/api/plugins/<pluginKey>/api/mcp?companyId=<COMPANY_UUID>
```

The plugin's `onApiRequest` handles MCP JSON-RPC requests using its existing domain services. The small `shared/mcp` module is **bundled into each plugin package**; it is neither a separately installed plugin nor a standalone MCP server. Each plugin owns its tools and lifecycle.

The endpoint supports a **stateless subset** of MCP Streamable HTTP (protocol `2025-11-25`): `initialize`, `ping`, `notifications/initialized`, `tools/list`, and `tools/call` using JSON-RPC POST. The plugin route cannot send SSE streams or arbitrary MCP response headers because the current Paperclip plugin API is JSON-only with an HTTP response-header allowlist. `GET` returns 405. Tools use safe, bounded JSON results. This is not complete transport compatibility across all MCP clients.

## Tools (16 total: nine read-only, seven S3 tools, including mutating actions)

| Plugin | MCP tools | Notes |
|---|---|---|
| Agent Observatory | `paperclipAgentHealthOverview`, `paperclipDiagnoseAgent`, `paperclipListRunFailures`, `paperclipFindAgentAnomalies`, `paperclipTraceRun` | Existing safe domain methods. **Direct trace excludes run event log entries**; the existing administrative bridge may provide a richer sanitized event trace. |
| Artifact Library | `artifactLibraryNavigation`, `artifactLibrarySearch` | Existing company-scoped navigation and artifact listing. Returns safe metadata, never raw file bytes or content URLs. |
| Org Tracker (Evolution) | `orgTrackerOverview`, `orgTrackerChangeSummary` | Reuses existing change intelligence services, omits snapshots and raw event metadata. |
| S3 Storage | `s3_storage_status`, `s3_storage_test_connection`, `s3_storage_list_objects`, `s3_storage_prepare_upload`, `s3_storage_finalize_upload`, `s3_storage_read_link`, `s3_storage_create_bucket` | Separately validates each flat tool schema, exposes read/write annotations, requires a stable upload `idempotencyKey`, and uses company-scoped service methods for both native tools and board API/MCP. Media bytes go directly from the caller to the signed provider URL; finalization streams and hashes the staging object before publishing an immutable content-addressed object. Bucket creation requires explicit company provisioning settings. |

The Founder Comms Router has no MCP tools because its actions mutate the organization and require a separate authorization/replay policy. The shared `createPluginMcpEndpoint` remains read-only; S3 uses its own plugin validator and does not broaden that helper. Daytona is a first-party environment provider and is not affected.

## Authorization and boundaries

- **Paperclip authenticates the caller as a board actor and checks company membership** before routing to the plugin worker. API secrets remain with the host; the plugin receives only a sanitized actor object.
- The plugin does not accept `companyId`, principal, `agentId`, or `runId` from tool arguments. All service reads use the trusted `input.companyId` received from the host.
- The read-only endpoints do not export mutating operations. S3 exports only its manifest-declared actions with explicit mutation annotations, rejects unknown names and arguments, and requires `allowProvisioning` for bucket creation.
- The plugin does not perform wake-ups or create fake runs.
- The plugin's ordinary `ctx.tools.register` tools remain agent-run scoped; exposing these HTTP endpoints does not bypass the native Tool Gateway's checks.
- Revocation and access control are inherited from the **Paperclip board credentials**. This is not a new OAuth server or an unauthenticated public endpoint.
- The shared helper limits input types and output size and sanitizes returned error messages. This is an MVP validator for flat tool schemas, **not** a general JSON Schema validator; do not advertise complex nested tool schemas before adding robust validation.

## Client integration caveats

1. The existing **static Paperclip MCP connector does not automatically discover these per-plugin URLs**. A client must configure each plugin endpoint individually, or a separately owned existing aggregation boundary must be retained.
2. **A Paperclip board API key is not automatically an OAuth credential accepted by ChatGPT.** ChatGPT-specific registration, authorization and connectivity remain to be verified before the old bridge can be retired.
3. Because route responses are JSON-only, transport compatibility must be checked with each target MCP client. A protocol smoke with `@modelcontextprotocol/sdk@1.30.0` passed in an isolated HTTP test. This does not establish that the hosted Paperclip API endpoint or ChatGPT connector has been tested end-to-end.
4. Do not expose these endpoints to unauthenticated traffic, publish an API key in a plugin manifest, bypass board authorization, or alter the core's `agentId/runId` checks.

## Verification checklist before release

- Run unit, typecheck, build and package checks for all affected plugins on Node 24, including existing UI regression suites.
- For S3, test company/project isolation and upload/finalize against a local S3-compatible HTTP fixture; verify the presigned PUT binds content type and length, mismatch never reaches `ready`, the final key cannot be changed with a stale staging URL, and bucket-create provider options omit ACLs.
- Inspect and address unrelated test-environment failures before promoting packages.
- Install a candidate **only in a reversible staging Paperclip** on the matching pinned Plugin SDK; verify API `initialize`, `tools/list`, `tools/call` and denial for revoked/unscoped credentials and wrong company.
- Validate authentication and protocol expectations with actual ChatGPT/OAuth or another named target MCP client.
- Preserve the current administrative MCP bridge until feature parity, especially event-level traces, is verified.
- Back up existing plugin packages and check rollback paths. Do not rebuild or replace `paperclip:agy` to ship this feature.

## Source of truth

Paperclip continues to own agents, issues, goals, runs, costs and artifacts. Plugins add read-only projections, not a second execution state machine. Follow existing [JOU-75](https://paper.journeystudios.com.br/JOU/issues/JOU-75) for the deployed Observatory and [JOU-80](https://paper.journeystudios.com.br/JOU/issues/JOU-80) for this proposed native endpoint work.
