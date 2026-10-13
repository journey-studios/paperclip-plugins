# Project Dashboards

Agents (and board users) publish **project tracking dashboards** for any system, and Paperclip renders them natively: KPIs, charts, filterable tables, status lists, Markdown and Mermaid diagrams, plus a Sources panel that shows where every number comes from and when it was last updated.

An agent never sends HTML or scripts. It sends a declarative JSON **DashboardSpec**; the plugin validates it with path-precise errors and the Paperclip UI renders it.

- Sidebar entry and a `dashboards` page that lists dashboards grouped by project.
- A **Dashboard** tab on every project page.
- Six agent tools: `upsert_dashboard`, `get_dashboard`, `list_dashboards`, `get_dashboard_status`, `update_dataset`, `validate_dashboard_spec`.
- A board REST API for external clients (and the MCP bridge), with data-freshness reporting.
- Live refresh: open dashboards poll for new revisions and show how fresh each source is.
- Plugin-owned PostgreSQL tables with revision history (restore from the UI).
- Everything configurable lives in the plugin settings: locale, currency, limits, labels, palette and status tones.

## Install

Build and pack from this monorepo (see the root README), then install the produced `@journey-studios/paperclip-plugin-project-dashboards` archive in Paperclip. The plugin id is `journeystudios.project-dashboards`.

Capabilities requested (least privilege): `agent.tools.register`, `agents.read` (agent names in "updated by"), `projects.read` (validate `projectId`), `companies.read` (company URL prefix for links), `api.routes.register` (REST API), `database.namespace.migrate|read|write`, `activity.log.write`, `ui.sidebar.register`, `ui.page.register`, `ui.detailTab.register`. It needs no artifact access and no host patch. The migration creates `dashboards` and `dashboard_revisions` in the plugin namespace and references `companies` and `projects` (read-only foreign keys).

## Settings

Open the plugin's settings page in Paperclip (generated from the manifest's `instanceConfigSchema`; settings are per company). Invalid values never break dashboards: each falls back to its default.

| Setting | Default | Meaning |
| --- | --- | --- |
| `locale` | `en-US` | BCP-47 tag for number and date formatting **and** UI language. `en` and `pt-BR` strings are shipped; other languages format numbers correctly but show English text. |
| `currency` | `USD` | ISO 4217 code used by the `currency` format. |
| `maxRevisions` | `20` (1 to 200) | Revisions kept per dashboard; older ones are pruned on write. |
| `maxSpecBytes` | `524288` (1 KiB to 8 MiB) | Maximum serialized spec size; larger specs are rejected with a clear error. |
| `navLabel` | `Dashboards` | Sidebar entry and page title. |
| `projectTabLabel` | `Dashboard` | Heading shown inside the project tab. |
| `defaultStaleAfterHours` | `0` (0 to 8760) | Datasets older than this many hours are flagged stale unless they set `staleAfterHours`. `0` never marks datasets stale. |
| `refreshIntervalSeconds` | `30` (`0`, or 5 to 3600) | How often an open dashboard checks for new revisions. `0` turns automatic refresh off. |
| `palette` | built-in | Up to 8 hex colors overriding the chart palette; an invalid entry keeps the built-in color for that slot. |
| `defaultStatusTones` | none | Map of status or priority values to `ok`, `warn`, `bad`, `muted` or `info`, merged under each spec's own `statusTones`. |

Built-in status tones (case-insensitive, accents and spaces ignored): `done`, `complete`, `completed`, `ok`, `success`, `passed`, `shipped`, `pronto`, `concluido` are **ok**; `in_progress`, `partial`, `at_risk`, `parcial`, `em_andamento` are **warn**; `warn`, `warning` are **warn**; `blocked`, `failed`, `error`, `critical`, `bad`, `falhou`, `bloqueado` and `P0` are **bad**; `info` is **info**; `todo`, `pending`, `open`, `planned`, `pendente` and `P2` are **muted**; `P1` is **warn**.

## Tool reference

Tools run inside an agent run. The company always comes from the run, never from parameters. Tool `content` is a short sentence; validation failures return an `error` that lists every problem with its path, for example `sections[2].blocks[0].dataset: unknown dataset "foo"`.

| Tool | Parameters | Effect |
| --- | --- | --- |
| `upsert_dashboard` | `slug`, `spec`, `title?`, `projectId?` | Create or replace the dashboard `slug`; each call stores a new revision. `projectId` omitted: a new dashboard uses the run's project and an existing one keeps its project. `null`: company-level. |
| `get_dashboard` | `slug` | Returns the stored record and spec. |
| `list_dashboards` | `projectId?` | Lists dashboards in the company. |
| `get_dashboard_status` | `slug` | One-line freshness summary plus the full status (see below). |
| `update_dataset` | `slug`, `datasetId`, `rows`, `columns?`, `description?`, `source?`, `updatedAt?` | Replaces one dataset's rows without resending the page. The whole spec is revalidated and `updatedAt` defaults to now. |
| `validate_dashboard_spec` | `spec` | Dry run, stores nothing. |

`slug` is lowercase `[a-z0-9-]`, 1 to 64 characters, unique per company.

### Authoring guidance for agents

1. Put every number in a **dataset** and reference it from blocks, so refreshing data with `update_dataset` updates the whole page.
2. Always fill each dataset's `title`, `description`, `source` and `updatedAt`. The Sources panel is how readers decide whether to trust the page.
3. Validate with `validate_dashboard_spec` before publishing large specs.
4. Prefer a few focused sections. State what the dashboard does **not** prove in a closing Markdown block.

## DashboardSpec v1

```jsonc
{
  "version": 1,
  "title": "Acme Web App",
  "summary": "Markdown shown under the title",
  "meta": "Markdown shown in the meta line",
  "datasets": {
    "tasks": {
      "title": "Tasks", "description": "Open work items", "source": "https://example.com/tracker",
      "updatedAt": "2026-10-11T09:00:00Z",
      "staleAfterHours": 24,                             // optional freshness threshold, > 0 and <= 8760
      "columns": ["id", "status", "priority"],          // optional; otherwise the union of row keys
      "rows": [{ "id": "A-1", "status": "done", "priority": "P1" }]
    }
  },
  "statusTones": { "shipped": "ok" },                    // optional, wins over settings and built-ins
  "sections": [
    { "id": "overview", "title": "Overview", "note": "Markdown", "columns": 2, "blocks": [ /* blocks */ ] }
  ]
}
```

Row values are `string | number | boolean | null`. Dataset ids and section/block ids match `[A-Za-z0-9_-]{1,64}`. Unknown properties are rejected, and the names `__proto__`, `constructor` and `prototype` are reserved: they are rejected as dataset ids, column or field names, row keys and map keys. Every dataset and field referenced by a block or value must exist (fields are checked against `columns`, or the union of row keys).

Every block accepts `id?`, `title?`, `note?` (Markdown) and `span?` (1 to 4 grid columns within the section).

| Block | Fields |
| --- | --- |
| `markdown` | `content` (Markdown, Mermaid fences allowed) |
| `mermaid` | `code` (rendered as a Mermaid diagram) |
| `callout` | `tone`, `content` |
| `kpis` | `items[]`: `label`, `value`, `of?`, `caption?` (plain text), `format?`, `tone?` |
| `chart` | `chart` (`bar`, `horizontalBar`, `stackedBar`, `line`, `area`, `donut`, `progress`), `dataset`, `x`, `y` (field or fields), `seriesLabels?`, `seriesColors?`, `format?`, `tooltip?` (extra fields), `goal?` |
| `table` | `dataset`, `rowKey`, `columns[]` (`field`, `label`, `format?`, `wide?`), `filters?` (`chips` field, `selects` fields, `search`), `sort?` (`field`, `dir`), `emptyText?` |
| `statusList` | `dataset`, `labelField`, `valueField`, `statusField`, `detailField?` (dataset fields), `format?` |

A **Value** is a number, a string, or `{ dataset, field, where?, row?, agg? }` computed from a dataset: `where` filters rows by equality, `row` picks a row (default 0), `agg` is `sum`, `count`, `avg`, `min` or `max`.

**Formats** (use the `locale` and `currency` settings): `int`, `decimal`, `pct`, `currency`, `duration`, `raw`. `pct` expects a **fraction**: `0.42` shows `42%`. `duration` expects seconds. Table columns also accept `status` (colored dot plus text), `priority`, `date`, `link` (http/https only), `code`, `muted`, `strong`.

Chart notes: `stackedBar` stacks the `y` fields; `bar` and `horizontalBar` group them; `donut` and `progress` take one `y` field. `progress` shows each value against `goal` (default `1` with the `pct` format, otherwise `100`). `goal` also draws a reference line on bar charts; on `progress` it draws a thin marker when values exceed it. Series colors: `seriesColors` maps a y field to a tone (`ok`, `warn`, `bad`, `muted`, `info`) or `#rrggbb`. Without it, when every y field name resolves to a status tone (for example `P0`, `blocked`, `done`), those tone colors are used; otherwise the categorical palette applies. Legend and tooltip use the same colors.

A complete example, with every block type, lives in [`examples/project-dashboard.example.json`](examples/project-dashboard.example.json) and is validated by the test suite.

## Data freshness

Each dataset can declare `staleAfterHours`; otherwise the `defaultStaleAfterHours` setting applies (`0` or unset means "never stale"). A dataset is **stale** when a threshold applies and its `updatedAt` is missing or older than that many hours. A dashboard's **health** is `stale` if any dataset is stale, `unknown` if no dataset has an `updatedAt`, and `fresh` otherwise. The same rules feed the REST `status` route, the `get_dashboard_status` tool and the UI (a "N stale sources" warning plus a stale badge per dataset in the Sources panel). `update_dataset` stamps `updatedAt` with the current time unless you pass one.

## Live refresh and sharing

While a dashboard is open (and the browser tab is visible) the UI polls a lightweight status check every `refreshIntervalSeconds` and refetches the full dashboard only when its revision or `updatedAt` changed, then shows "Updated to revision N". Dashboard and project lists poll too. The header shows "Live, checked Ns ago", or that automatic refresh is off when the interval is `0`. Polling is used because the stock host does not expose plugin push streams.

Dashboards are visible to every member of the company. **Copy link** copies an absolute URL such as `https://your-host/ACME/dashboards?d=my-slug`; opening it loads that dashboard directly.

## REST API

Board-authenticated routes mounted by the host under `/api/plugins/journeystudios.project-dashboards/api`. Every request carries `?companyId=<uuid>` (the host authorizes it, and the plugin only trusts that authorized value). Bodies are JSON (the host limits them to 1,000,000 bytes). Every response, including errors, has `cache-control: no-store` and contains `"companyId"`. Writes are attributed to the calling board user and recorded in the activity log. There is no delete route; deleting stays a UI action.

| Method and path | Body | 200 response |
| --- | --- | --- |
| `GET /dashboards` (`?projectId=`) | none | `{ companyId, dashboards: Summary[] }` |
| `GET /dashboards/:slug` | none | `{ companyId, dashboard: Summary & { spec } }` |
| `GET /dashboards/:slug/status` | none | `{ companyId, status: Status }` |
| `POST /dashboards` | `{ slug, title?, projectId?: uuid \| null, spec }` | `{ companyId, created, dashboard: Summary }` |
| `POST /dashboards/:slug/datasets/:datasetId` | `{ rows, columns?, description?, source?, updatedAt? }` | `{ companyId, dashboard: Summary, dataset: DatasetStatus }` |
| `POST /validate` | `{ spec }` | `{ companyId, valid: true, datasets, sections }` |

- `Summary` is `{ id, slug, title, projectId, projectName, revision, updatedAt, updatedBy, viewPath }`; `viewPath` is `/<COMPANY_PREFIX>/dashboards?d=<slug>`, relative to the web origin.
- `DatasetStatus` is `{ id, title, rows, updatedAt, ageMinutes, staleAfterHours, stale }`. `Status` is a `Summary` plus `{ checkedAt, health, staleCount, datasets, sections, blocks }`.
- `projectId` on upsert: omitted means a new dashboard is company-level and an existing one keeps its project; `null` makes it company-level; a UUID must belong to the company.
- Errors: `400 { error: "<message>" }` (bad slug, dataset id, project or body shape), `404 { error: "not_found" }` (dashboard, dataset or route), `413 { error: "spec_too_large", limitBytes }`, `422 { error: "invalid_spec", details: string[] }` (at most 50 path-precise messages, each at most 300 characters), `500 { error: "internal_error" }` (details are logged, never returned).

## Using from MCP

The companion `plugin-mcp-bridge` service in this repository exposes these routes to external MCP clients as `paperclip*Dashboard*` tools, using the board credentials of the bridge's operator. See its README for setup. The plugin itself needs no MCP configuration.

## Security model

- **No agent-authored HTML or JavaScript.** Plugin UI runs in the Paperclip page without a sandbox, so rendering agent HTML would be a cross-site scripting hole. Specs are data; React renders them.
- Dataset values, labels and captions are always rendered as text (React escapes them).
- Markdown goes only through the host `MarkdownBlock`. In the pinned host (`MarkdownBody` on `react-markdown` with `remark-gfm` and no `rehype-raw`), raw HTML in Markdown is not rendered, URLs are filtered by the library's default transform, and Mermaid runs with `securityLevel: "strict"`. Mermaid blocks are wrapped in a fence longer than any backtick run in the code, so a diagram cannot break out into Markdown.
- Table links render only absolute `http`/`https` URLs with `rel="noopener noreferrer"`; anything else is shown as text.
- REST routes use board authentication; the company comes from the host-authorized query value, never from the body. Every query is scoped by `company_id`.
- Agent tools take the company from the run context; every query is scoped by `company_id`; `projectId` must belong to the company.
- Writes are serialized per company and recorded in the activity log.

## Limits

- Serialized spec size: `maxSpecBytes` (default 512 KiB).
- Revisions kept: `maxRevisions` (default 20).
- Text fields are capped (titles 200 characters, Markdown 100,000), and at most 50 validation errors are reported per call.
- Live refresh is polling-based and only runs while the tab is visible; changes appear within one `refreshIntervalSeconds`.
- Charts are drawn as responsive SVG, sized for dashboards rather than for tens of thousands of points; long category lists thin their axis labels.
- A project's tab label in the host tab strip is fixed to `Dashboard`; `projectTabLabel` sets the heading inside the tab.
- Settings are edited in the host's generated settings form (the SDK has no worker-side config write path for a custom page).

## Development

```sh
pnpm --filter @journey-studios/paperclip-plugin-project-dashboards typecheck
pnpm --filter @journey-studios/paperclip-plugin-project-dashboards test
pnpm --filter @journey-studios/paperclip-plugin-project-dashboards build
```

Tests run the real migration on PGlite and render the UI under jsdom.
