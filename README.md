# Journey Studios Paperclip plugins

Public monorepo for installable Paperclip plugins. Each plugin is independently versioned and packed as a tarball containing its compiled output, migrations, and installation notes. GitHub releases attach those archives with SHA-256 digests; this repository does not publish packages to npm or deploy a Paperclip host.

## Development

Requirements: Node.js 24.11 or newer and pnpm 10.7.0.

```sh
pnpm bootstrap:host
pnpm install --frozen-lockfile
pnpm check
pnpm run package
```

The bootstrap downloads the public Paperclip source at a fixed commit into ignored `.paperclip/`, verifies its origin and commit, and applies the host compatibility patch once. It does not use a private checkout. To build inside an existing Paperclip source checkout, set `PAPERCLIP_HOST_DIR` to that checkout; it must match the documented public commit.

See the [compatibility guide](docs/compatibility.md), [release guide](docs/releases.md), [contribution guide](CONTRIBUTING.md), and [security policy](SECURITY.md).

## Plugins

- [`@journey-studios/paperclip-artifact-library`](plugins/artifact-library/README.md): company-scoped organization for the existing Paperclip artifact catalog.
- [`@journey-studios/telegram-gateway`](plugins/telegram-gateway/README.md): authenticated Telegram commands and Founder communication routing.
- [`@journey-studios/agent-observatory`](plugins/agent-observatory/README.md): read-only agent health, failures, costs, anomaly evidence and safe run summaries.
- [`@journey-studios/paperclip-s3-storage`](plugins/s3-storage/README.md): company-scoped S3-compatible media uploads and private object access for AWS S3, Cloudflare R2 and Backblaze B2.
- [`@journey-studios/paperclip-evolution`](plugins/evolution/README.md): Change Intelligence for agent/skill diffs, Audit provenance, evidence, metrics, and conclusions.
- [`@journey-studios/paperclip-storage-manager`](plugins/storage-manager/README.md): read-only VPS disk, Docker storage, growth and operator-configured warnings via the native local-folder API and a [separate host collector](services/storage-collector/README.md).
- [`@journey-studios/paperclip-plugin-project-dashboards`](plugins/project-dashboards/README.md): agents publish project tracking dashboards (KPIs, charts, filterable tables, Markdown, Mermaid) from a declarative spec, rendered natively, with provenance and revision history.
- [`@journey-studios/paperclip-plugin-project-hierarchy`](plugins/project-hierarchy/README.md): sub-projects without core changes: a Sub-projects tab on every project, a company-wide project tree, agent tools and REST routes to set a project's parent.

- [`@journey-studios/performance-observatory`](plugins/performance-observatory/README.md): scheduled and on-demand Lighthouse reviews, ephemeral VPS executors, environment-separated charts, native agent tools and an authenticated external CLI/API.

- [`@journey-studios/paperclip-social-publisher`](plugins/social-publisher/README.md): independent OAuth for Instagram, Facebook Pages, Threads and X, native agent tools, version-bound Telegram approval, durable scheduling and verified receipts. New installations are restricted to dry runs.

## Administrative MCP tools

The optional [plugin MCP bridge](services/plugin-mcp-bridge/README.md) adds five Observatory tools and six Project Dashboards tools (list, read, status, create/update, validate) to the official Paperclip MCP server through a separate stdio process. It calls company-scoped plugin APIs, preserves the official server's tools and protocol, and requires no change to Paperclip Core or its Tool Gateway. The plugin worker receives no board API key. The bridge and plugin can be disabled independently.
