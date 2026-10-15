# Project Dashboards

Agents (and board users) publish **project tracking dashboards** for any system, and Paperclip renders them natively: KPIs, charts, filterable tables, status lists, Markdown and Mermaid diagrams, plus a Sources panel that shows where every number comes from and when it was last updated.

An agent never sends HTML or scripts. It sends a declarative JSON **DashboardSpec**; the plugin validates it with path-precise errors and the Paperclip UI renders it.

- New dashboards must belong to a Paperclip project; existing projectless dashboards stay editable (see [Projects](#projects)).
- Sidebar entry and a `dashboards` page that lists dashboards grouped by project, with projectless dashboards in a separate "No project" group, and a **Dashboards | Changelog** switch.
- A **Dashboard** tab and a **Changelog** tab on every project page.
- A per-project **changelog**: agents record milestones, releases, fixes and decisions, and completed issues are added automatically, so you can watch a project evolve (see [Changelog](#changelog)).
- Nine agent tools: `upsert_dashboard`, `get_dashboard`, `list_dashboards`, `get_dashboard_status`, `update_dataset`, `validate_dashboard_spec`, `add_changelog_entry`, `list_changelog`, `update_changelog_entry`.
- A board REST API for external clients (and the MCP bridge), with data-freshness reporting.
- Live refresh: open dashboards poll for new revisions and show how fresh each source is.
- Plugin-owned PostgreSQL tables with revision history (restore from the UI).
- Everything configurable lives in the plugin settings: locale, currency, limits, labels, palette and status tones.

## Install

Build and pack from this monorepo (see the root README), then install the produced `@journey-studios/paperclip-plugin-project-dashboards` archive in Paperclip. The plugin id is `journeystudios.project-dashboards`.

Capabilities requested (least privilege): `agent.tools.register`, `agents.read` (agent names in "updated by"), `projects.read` (validate `projectId`, project names), `issues.read` (read a completed issue and import completed issues into the changelog), `events.subscribe` (the `issue.updated` event, for automatic changelog entries), `companies.read` (company URL prefix for links), `api.routes.register` (REST API), `database.namespace.migrate|read|write`, `activity.log.write`, `ui.sidebar.register`, `ui.page.register`, `ui.detailTab.register`. It needs no artifact access, no issue write access and no host patch. Migration `001` creates `dashboards` and `dashboard_revisions`; migration `002` adds `changelog_entries`. Both live in the plugin namespace and reference `companies` and `projects` (read-only foreign keys). Upgrading from 0.3.x applies `002` and changes nothing else.

## Settings

Open the plugin's settings page in Paperclip (generated from the manifest's `instanceConfigSchema`; settings are per company). Invalid values never break dashboards: each falls back to its default.

| Setting | Default | Meaning |
| --- | --- | --- |
| `locale` | `en-US` | BCP-47 tag for number and date formatting **and** UI language. `en` and `pt-BR` strings are shipped; other languages format numbers correctly but show English text. |
| `currency` | `USD` | ISO 4217 code used by the `currency` format. |
| `maxRevisions` | `20` (1 to 200) | Revisions kept per dashboard; older ones are pruned on write. |
| `maxSpecBytes` | `524288` (1 KiB to 8 MiB) | Maximum serialized spec size; larger specs are rejected with a clear error. |
| `navLabel` | `Dashboards` | Sidebar entry and page title. |
| `projectTabLabel` | `Dashboard` | Heading shown inside the project's Dashboard tab. |
| `changelogTabLabel` | `Changelog` | Heading shown inside the project's Changelog tab, and the label of the Changelog view on the dashboards page. |
| `changelogFromIssues` | `top-level` | Which issues that become done are added to their project's changelog on their own: `off`, `top-level` (no parent issue) or `all` (sub-issues too). An invalid value falls back to `top-level`. See [Changelog](#changelog). |
| `defaultStaleAfterHours` | `0` (0 to 8760) | Datasets older than this many hours are flagged stale unless they set `staleAfterHours`. `0` never marks datasets stale. |
| `refreshIntervalSeconds` | `30` (`0`, or 5 to 3600) | How often an open dashboard checks for new revisions. `0` turns automatic refresh off. |
| `palette` | built-in | Up to 8 hex colors overriding the chart palette; an invalid entry keeps the built-in color for that slot. |
| `defaultStatusTones` | none | Map of status or priority values to `ok`, `warn`, `bad`, `muted` or `info`, merged under each spec's own `statusTones`. |

Built-in status tones (case-insensitive, accents and spaces ignored): `done`, `complete`, `completed`, `ok`, `success`, `passed`, `shipped`, `pronto`, `concluido` are **ok**; `in_progress`, `partial`, `at_risk`, `parcial`, `em_andamento` are **warn**; `warn`, `warning` are **warn**; `blocked`, `failed`, `error`, `critical`, `bad`, `falhou`, `bloqueado` and `P0` are **bad**; `info` is **info**; `todo`, `pending`, `open`, `planned`, `pendente` and `P2` are **muted**; `P1` is **warn**.

## Tool reference

Tools run inside an agent run. The company always comes from the run, never from parameters. Tool `content` is a short sentence; validation failures return an `error` that lists every problem with its path, for example `sections[2].blocks[0].dataset: unknown dataset "foo"`.

| Tool | Parameters | Effect |
| --- | --- | --- |
| `upsert_dashboard` | `slug`, `spec`, `title?`, `projectId?` | Create or replace the dashboard `slug`; each call stores a new revision. `projectId` is a project UUID of the company. Omitted: a new dashboard uses the run's project (a tool error `project_required` if the run has none) and an existing dashboard keeps its project, or stays projectless. A UUID moves it. `null` is rejected. |
| `get_dashboard` | `slug` | Returns the stored record and spec. |
| `list_dashboards` | `projectId?` | Lists dashboards in the company. |
| `get_dashboard_status` | `slug` | One-line freshness summary plus the full status (see below). |
| `update_dataset` | `slug`, `datasetId`, `rows`, `columns?`, `description?`, `source?`, `updatedAt?` | Replaces one dataset's rows without resending the page. The whole spec is revalidated and `updatedAt` defaults to now. |
| `validate_dashboard_spec` | `spec` | Dry run, stores nothing. |
| `add_changelog_entry` | `kind`, `title`, `projectId?`, `body?`, `version?`, `refs?`, `links?`, `occurredAt?` | Record one changelog entry. `projectId` omitted: the run's project. |
| `list_changelog` | `projectId?`, `kinds?`, `includeIssues?`, `before?`, `limit?` | Read the changelog, newest first; `before` takes the previous `nextCursor`. |
| `update_changelog_entry` | `entryId`, and any of `kind`, `title`, `body`, `version`, `refs`, `links`, `occurredAt` | Correct an entry written by hand; `null` clears `body` or `version`. |

`slug` is lowercase `[a-z0-9-]`, 1 to 64 characters, unique per company.

### Authoring guidance for agents

1. Put every number in a **dataset** and reference it from blocks, so refreshing data with `update_dataset` updates the whole page.
2. Always fill each dataset's `title`, `description`, `source` and `updatedAt`. The Sources panel is how readers decide whether to trust the page.
3. Validate with `validate_dashboard_spec` before publishing large specs.
4. Prefer a few focused sections. State what the dashboard does **not** prove in a closing Markdown block.

## Changelog

A project's changelog shows how it evolved: a dated list of what changed and why. It is stored in its own table, apart from dashboards, because a dashboard spec is rewritten on every publish while a changelog only grows.

### Entries

| Field | Meaning |
| --- | --- |
| `kind` | `milestone`, `release`, `feature`, `fix`, `improvement`, `decision`, `incident` or `note` for entries written by agents, the board or the bridge; `issue` for the entries the plugin generates itself. Nothing external can write `issue`. |
| `title` | The result, 1 to 200 characters. |
| `body` | Optional Markdown, at most 20,000 characters: what changed and why. |
| `version` | Optional release label, 1 to 64 characters. |
| `refs` | Up to 20 short strings (1 to 100 characters): issue identifiers, PR numbers, commit SHAs. An identifier such as `ABC-12` becomes a link to that issue. |
| `links` | Up to 20 `{ label, url }`. `url` must be an absolute `http`/`https` URL of at most 2,000 characters. |
| `occurredAt` | When it happened (ISO 8601 date or timestamp, 1970 or later); defaults to now. |

The project is fixed when an entry is created. Entries record who wrote them (agent, board user or system) and appear newest first by `occurredAt`.

### Completed issues

Issues that become `done` are added by the plugin as `issue` entries (title of the issue, its identifier as the ref, its completion time, the system as author). This is controlled per company by `changelogFromIssues`:

- `top-level` (default): issues without a parent. Completed sub-issues are mostly tests and smoke checks, so they are skipped.
- `all`: every eligible issue, sub-issues included.
- `off`: nothing is captured automatically.

An issue is eligible when it is `done`, belongs to a project, is not hidden and was created manually (`originKind` absent or `manual`); routine runs, watchdogs, recoveries, chat-channel issues and issues made by plugins are never captured. The plugin reads each `issue.updated` event, looks the issue up and inserts an entry once per issue (a unique index absorbs repeated or re-delivered events). It never edits an entry afterwards. Entries of kind `issue` cannot be edited, because they mirror the issue.

Event delivery is best-effort and held in memory, so events can be missed while the plugin restarts or upgrades. **Import completed issues** (button in the project's Changelog tab, REST `POST /changelog/import`, or the bridge) reads the project's completed issues (up to 1,000, as the host returns them) and inserts the ones that have no entry yet. It is idempotent, runs even when automatic capture is `off`, uses `all` only when the setting is `all`, and reports `{ scanned, imported, skipped, truncated }` (`skipped` is every scanned issue that was not newly imported; `truncated` means the host returned a full page of 1,000 and older issues may not have been seen).

### Deleting

Deleting is a board action in the UI (with a confirmation) and is soft: the entry disappears from every list but its row stays. That keeps the one-entry-per-issue index in force, so a later import or a repeated event never brings back an automatic entry the board removed. There is no delete tool, REST route or bridge tool, as with dashboards.

### In the UI

- The project page has a **Changelog** tab (after **Dashboard**). The dashboards page has **Dashboards | Changelog** tabs (`/dashboards?view=changelog`; a `?d=<slug>` link still opens that dashboard) with a project selector and "All projects".
- The timeline is grouped by month. Each entry shows its date, a kind badge, title, version, the project (company view only), Markdown body, refs, links and author; `issue` entries are compact and have no body.
- Filters: one chip per kind present, and **Include completed issues**. **Show more** loads 50 more entries each time, up to 500.
- The list refreshes on the `refreshIntervalSeconds` setting like dashboards do.
- The project tab has **Import completed issues**.

### Recording entries well

1. Record an entry when something relevant closes: a merged PR, a validated deploy, a milestone, a decision, an incident or a release. One entry per relevant change, not one per run.
2. Title with the result ("Checkout accepts bank transfers"), `body` with what changed and why, `refs` with the issue, PR or SHA.
3. Do not duplicate completed issues; they arrive on their own.
4. Read with `list_changelog` first when you only need to know what already happened.

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

## Projects

New dashboards must belong to a Paperclip project, and the UI groups dashboards by project. Existing dashboards without a project (created before this rule, or whose project was deleted) can remain projectless and are shown in a separate group.

- **New dashboards need a project.** REST: `projectId` is required, otherwise `400 project_required`. Agent tool: `projectId`, else the run's project, else a tool error `project_required` that says the run has no project. `null` is not accepted anywhere.
- **Existing dashboards keep their project** when `projectId` is omitted; a UUID moves them.
- **Projectless dashboards** can still exist, because deleting a project only detaches its dashboards (the database foreign key is `ON DELETE SET NULL`). An existing projectless dashboard can be updated without `projectId` and stays projectless; `update_dataset` and status work on it, and `status.orphan` is `true`. A UUID moves it into a project.
- The project must exist in the company (`project_not_found`, also for projects of another company) and must not be archived (`project_archived`). The archived check applies when a dashboard is created or moved; a dashboard that stays in a project that is archived later can still be updated.
- **Board action `dashboard.setProject`** `{ id, projectId }` moves any dashboard, projectless ones included, to an active project of the company. It writes a new revision with an unchanged spec, so the move shows in the history, and logs activity. A move to the current project does nothing. The REST route `POST /dashboards/:slug/project` (see [REST API](#rest-api)) runs the same logic for external clients.
- **UI.** The Dashboards page has one section per project ordered by name, each titled with a link to the project page and a dashboard count, dashboards sorted by title. Projectless dashboards are grouped apart in a collapsible "No project" area below a divider, each with a "Move to project" control (the host project picker). The viewer header shows "Project: <link>", or a warning with the same control. The project tab lists only that project's dashboards (a selector when there are several); when there are none it explains how to create one and shows the project ID to copy.

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
| `POST /dashboards` | `{ slug, title?, projectId?: uuid, spec }` | `{ companyId, created, dashboard: Summary }` |
| `POST /dashboards/:slug/datasets/:datasetId` | `{ rows, columns?, description?, source?, updatedAt? }` | `{ companyId, dashboard: Summary, dataset: DatasetStatus }` |
| `POST /dashboards/:slug/project` | `{ projectId: uuid }` | `{ companyId, moved: boolean, dashboard: Summary }` |
| `POST /validate` | `{ spec }` | `{ companyId, valid: true, datasets, sections }` |
| `GET /changelog` (`?projectId=&kind=&includeIssues=&before=&limit=`) | none | `{ companyId, entries: Entry[], nextCursor }` |
| `POST /changelog` | `{ projectId, kind, title, body?, version?, refs?, links?, occurredAt? }` | `{ companyId, entry: Entry }` |
| `POST /changelog/import` | `{ projectId }` | `{ companyId, scanned, imported, skipped, truncated }` |
| `POST /changelog/:entryId` | any of `kind`, `title`, `body`, `version`, `refs`, `links`, `occurredAt` | `{ companyId, entry: Entry }` |

- `Summary` is `{ id, slug, title, projectId, projectName, revision, updatedAt, updatedBy, viewPath }` (`projectId` and `projectName` are `null` only for projectless dashboards); `viewPath` is `/<COMPANY_PREFIX>/dashboards?d=<slug>`, relative to the web origin.
- `DatasetStatus` is `{ id, title, rows, updatedAt, ageMinutes, staleAfterHours, stale }`. `Status` is a `Summary` plus `{ orphan, checkedAt, health, staleCount, datasets, sections, blocks }`.
- `projectId` on upsert is required for a new dashboard (`400 project_required`); omitted on an existing dashboard keeps its project, or its lack of one; a UUID moves it. `null` is rejected with a 400. The project must belong to the company (`400 project_not_found`) and must not be archived (`400 project_archived`).
- `POST /dashboards/:slug/project` (plugin 0.4.1) moves a dashboard, projectless ones included, to another project. It runs the same logic as the board action `dashboard.setProject`: one statement writes the dashboard row and a new revision with an unchanged spec, the move is logged as activity, and `moved` is `true`. Moving to the project the dashboard is already in answers `moved: false` with no new revision and no activity. Errors: `400 project_required` (`projectId` missing, `null` or not a UUID; checked before the dashboard lookup), `400 project_not_found` (also for a project of another company), `400 project_archived`, and `404 not_found` for an unknown dashboard. It needs no migration.
- Changelog routes: `kind` is a comma-separated list (`issue` is accepted when reading), `includeIssues` is `true` or `false` (default `true`), `limit` is 1 to 500 (default 50) and `before` is the `nextCursor` of the previous page (an opaque keyset cursor; `null` means the end). Entries are ordered by `occurredAt`, then `id`, descending. `Entry` is `{ id, projectId, projectName, kind, title, body, version, refs, links, occurredAt, issueId, createdBy, updatedBy, createdAt, updatedAt }`, with actors as `{ kind, id, name }`. `POST /changelog/import` is declared before `POST /changelog/:entryId` because the host uses the first route that matches. Updating needs at least one field; `null` clears `body` or `version`; `projectId` cannot change; an `issue` entry cannot be updated (400). `kind: "issue"` is rejected on writes. Deleting is not available over REST. Unlike new dashboards, an entry may be recorded for any project of the company, archived ones included, because the changelog is history.
- Errors: `400 { error: "<message>" }` (bad slug, dataset id, project, entry id, list parameter or body shape; `project_required`, `project_not_found` and `project_archived` are the project codes), `404 { error: "not_found" }` (dashboard, dataset, entry or route), `413 { error: "spec_too_large", limitBytes }`, `422 { error: "invalid_spec", details: string[] }` for specs and `422 { error: "invalid_entry", details: string[] }` for changelog fields (at most 50 path-precise messages, each at most 300 characters, for example `links[0].url: must be an absolute http or https URL of at most 2000 characters`), `500 { error: "internal_error" }` (details are logged, never returned).

## Using from MCP

The companion `plugin-mcp-bridge` service in this repository exposes these routes to external MCP clients as `paperclip*Dashboard*` tools (`paperclipMoveDashboard` calls `POST /dashboards/:slug/project`) and, for the changelog, `paperclipListChangelog`, `paperclipAddChangelogEntry`, `paperclipUpdateChangelogEntry` and `paperclipImportChangelogFromIssues`, using the board credentials of the bridge's operator. See its README for setup. The plugin itself needs no MCP configuration.

## Security model

- **No agent-authored HTML or JavaScript.** Plugin UI runs in the Paperclip page without a sandbox, so rendering agent HTML would be a cross-site scripting hole. Specs are data; React renders them.
- Dataset values, labels and captions are always rendered as text (React escapes them).
- Markdown goes only through the host `MarkdownBlock`. In the pinned host (`MarkdownBody` on `react-markdown` with `remark-gfm` and no `rehype-raw`), raw HTML in Markdown is not rendered, URLs are filtered by the library's default transform, and Mermaid runs with `securityLevel: "strict"`. Mermaid blocks are wrapped in a fence longer than any backtick run in the code, so a diagram cannot break out into Markdown.
- Table links render only absolute `http`/`https` URLs with `rel="noopener noreferrer"`; anything else is shown as text.
- REST routes use board authentication; the company comes from the host-authorized query value, never from the body. Every query is scoped by `company_id`.
- Agent tools take the company from the run context; every query is scoped by `company_id`; `projectId` must belong to the company and, for a new or moved dashboard, not be archived.
- Changelog text is always rendered as text, bodies go through the host Markdown renderer, and `links` open only absolute `http`/`https` URLs (checked when written and again when rendered); issue links are built only from strictly shaped identifiers. Writes reject unexpected and reserved fields.
- Writes are serialized per company and recorded in the activity log.

## Limits

- Serialized spec size: `maxSpecBytes` (default 512 KiB).
- Revisions kept: `maxRevisions` (default 20).
- Text fields are capped (titles 200 characters, Markdown 100,000), and at most 50 validation errors are reported per call.
- Changelog: titles 200 characters, `body` 20,000, `version` 64, 20 `refs` of 100 characters, 20 `links`, 500 entries per request (the UI shows up to 500), and an import looks at up to 1,000 completed issues.
- Automatic entries depend on host events that are delivered best-effort; run **Import completed issues** after downtime to reconcile.
- Live refresh is polling-based and only runs while the tab is visible; changes appear within one `refreshIntervalSeconds`.
- Charts are drawn as responsive SVG, sized for dashboards rather than for tens of thousands of points; long category lists thin their axis labels.
- A project's tab labels in the host tab strip are fixed to `Dashboard` and `Changelog`; `projectTabLabel` and `changelogTabLabel` set the headings inside the tabs.
- Settings are edited in the host's generated settings form (the SDK has no worker-side config write path for a custom page).

## Development

```sh
pnpm --filter @journey-studios/paperclip-plugin-project-dashboards typecheck
pnpm --filter @journey-studios/paperclip-plugin-project-dashboards test
pnpm --filter @journey-studios/paperclip-plugin-project-dashboards build
```

Tests run the real migration on PGlite and render the UI under jsdom.

## Milestones (0.5.0)

Each **project** has a native **Milestones** tab, between Dashboard and Changelog. Unlike a changelog entry (historical record) or a Goal (strategic outcome), a Milestone is a planned, verifiable project checkpoint. It does not own execution: Issues remain the host's source of truth and are never edited by this plugin.

- **Create / edit:** name, optional description and target date (YYYY-MM-DD), 1–30 verifiable criteria (checked/unchecked), up to 50 linked Issue UUIDs **belonging to the same project/company**, and up to 20 evidence links (absolute http/https URLs).
- **Progress:** based on the number of live linked Issues with status `done` plus checked criteria, divided by all linked Issues + criteria. The percentage is a display aid, not a completion signal. If an Issue reopens or moves out of the project, the next read reflects this and flags a blocker.
- **Completion:** an explicit actor action. Every linked Issue must be `done`; all criteria must be checked, with at least one evidence URL. Completion saves `completedAt` and records **one immutable Changelog entry** in the same database operation. No automatic completion on Issue changes. Completed milestones can only be reopened explicitly; the original changelog history is preserved if completed again.
- **Consistency:** all writes are serialized per company within the worker and require an optimistic `revision` to avoid overwriting concurrent edits (REST returns 409 on conflict). Read and write operations are company-scoped; archived projects reject new milestones. Changelog entries originating from milestone completion cannot be edited or deleted through the ordinary Changelog controls.

Agent tools: `create_milestone`, `list_milestones`, `get_milestone`, `update_milestone`. Agents may use their current Issue's project by default. Board data: `milestones.list`, `milestone.get`, `milestones.projectIssues`; actions: `milestone.create`, `milestone.update`.

REST (board authenticated, requires `companyId` in query): `GET /milestones?projectId=<uuid>`, `GET /milestones/:milestoneId`, `POST /milestones` with `projectId` and fields, `POST /milestones/:milestoneId` with `revision` and edited fields. Errors: 400 bad input/domain rules, 404 inaccessible record, 409 optimistic concurrency, 422 malformed field set. Migration `003_project_milestones.sql` adds the plugin-owned table and an optional `milestone_id` to existing Changelog entries without dropping legacy data. Deploy requires a backed-up DB and compatible pinned SDK; do not replace custom Paperclip images with upstream ones.
