# Paperclip host compatibility

The plugins in this repository target the Paperclip Plugin SDK v1 API. Artifact Library additionally requires the company-scoped artifact catalog API named `artifacts.read` and `ctx.artifacts.list`.

The pinned upstream source is `paperclipai/paperclip` at commit `8f8a0ab7effbd6a0584107d8038736c134ee5047` (release `2026.1001.0`). That upstream SDK does not yet provide the artifact catalog API. [`compat/paperclip-artifacts-read.patch`](../compat/paperclip-artifacts-read.patch) is the minimal host compatibility extension maintained by this project. It adds the capability, typed worker contract, host service delegation, and API tests. It grants read access to the host's canonical company artifact catalog; it adds no artifact write operation or core database migration.

Artifact Library `0.1.2` uses this exact baseline. A stock Paperclip `2026.1001.0` host is not compatible until the patch is applied and the host packages are rebuilt. Both plugin packages in this monorepo are versioned `0.1.2` for this release; the artifact API compatibility patch is required by Artifact Library.

Apply the patch to a clean checkout at the pinned commit, then rebuild the host shared package and Plugin SDK before building/installing Artifact Library. The bootstrap script performs the pin and patch checks automatically. For an existing host build, set `PAPERCLIP_HOST_DIR` to its source checkout; the path must point to the pinned upstream checkout, and the compatibility patch must either already be applied or be applicable without conflicts. A previously applied patch is detected and left in place.

The public plugin API remains flat: `ctx.artifacts.list({ companyId, kind, projectId, q, groupBy, groupIssueId, limit, cursor })`. The worker sends the allowlisted filters in both the legacy flat RPC envelope and the newer nested `query` envelope (`{ companyId, ...filters, query: filters }`). The pinned compatibility host reads the flat fields; newer hosts may read `params.query`. `companyId` remains at the envelope top level and is excluded from the nested query, and native per-user `starred` is not sent.

The compatibility patch must be reviewed against each new upstream release before changing the pin. Do not infer support from the package version alone: the host service implementation and worker RPC contract must both include `artifacts.list`, and the plugin capability validator must recognize `artifacts.read`.

Agent Observatory `0.1.0` uses the pinned SDK's existing company-scoped API routes, data handlers, agent tools, and restricted reads of `agents`, `heartbeat_runs`, and `cost_events`. It requires no additional host patch. The host requires `database.namespace.migrate` when a database declaration is present; the plugin supplies an empty migration directory, creates no core tables, and has no runtime database write capability.

Historical run event rows are outside the SDK's core table allowlist. The Observatory plugin returns safe lifecycle metadata with explicit coverage. Its optional administrative MCP bridge can add safe event metadata through the existing authenticated heartbeat events REST endpoint. It never reads logs, provider prompts, event payloads, or API credentials from the plugin worker.
## Evolution

Evolution `0.1.0` uses a plugin-owned PostgreSQL namespace for Change Sets, snapshots, evidence, metrics, links, and conclusions. It references Paperclip core runs, costs, issues, goals, agents, skills, and Audit rows instead of duplicating them.

The pinned upstream host does not expose `activity_log`, `agent_config_revisions`, `company_skills`, or `company_skill_versions` to plugin database reads and does not forward all Evolution-relevant Audit actions to `activity.logged`. [`compat/paperclip-evolution.patch`](../compat/paperclip-evolution.patch) adds only those read-only table allowlist entries, Audit event forwarding/provenance, and the self-hosted bundled-plugin registration used by the Journey runtime. It grants no core database write capability to the plugin.

Agent configuration revisions provide exact before/after JSON. Historical instruction-file content may be partial because the pinned host did not previously version every instruction-file mutation; Evolution records the audited mutation and marks those snapshots as partial rather than inventing history.
