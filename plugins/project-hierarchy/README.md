# Sub-projects (`journeystudios.project-hierarchy`)

Nest Paperclip projects under a parent project without changing Paperclip core. Core projects stay flat: this plugin stores parent links in its own database namespace and adds views and tools on top.

## What it adds

- **Sub-projects tab** on every project page: the project's path from the top-level project, a parent picker, "Make top-level", the direct sub-projects (with Detach), "Add an existing project…", and "Create sub-project".
- **Tree on the core Projects list** (`/<company>/projects`): sub-projects are listed right under their parent, indented with a `└`. The list's own sort still orders each level. Core has no plugin slot on that page, so an invisible app-shell overlay sets a CSS `order` and a depth on the rows core already rendered. It never adds, moves or removes those nodes. If a Paperclip upgrade changes that markup, the list simply goes back to flat. CSS `order` alone would split the visual order from the Tab and screen-reader order, so the tree appears only in browsers that support `reading-flow: flex-visual` (Chromium 137+: Chrome and Edge 137+, Opera 121+). Firefox and Safari keep the flat list; the Project tree page works everywhere.
- **Project tree** page (`/<company>/project-tree`, linked from the sidebar): every project as a collapsible tree, with a filter, an archived toggle, and an Organize mode that sets each project's parent in place.
- **Agent tools**: `list_project_tree`, `get_project_hierarchy`, `set_project_parent`.
- **REST routes** under `/api/plugins/journeystudios.project-hierarchy/api` for boards and agents (`board-or-agent`), with `?companyId=`:
  - `GET /tree`
  - `GET /projects/:projectId`
  - `POST /projects/:projectId/parent` with `{"parentProjectId": "<uuid>" | null}`

## Rules

- A parent belongs to the same company and is not archived.
- A project cannot be its own parent or sit under one of its own sub-projects. These requests return `422` with the code `self_parent` or `cycle`.
- Deleting a parent project drops its links (`ON DELETE CASCADE`), so its sub-projects become top-level. Deleting a sub-project drops its link.
- Moves are serialized per company inside the worker, so two concurrent moves cannot close a cycle together.
- Every change is written to the activity log with the acting user or agent.

Sub-projects keep their own tasks, workspaces, budget and goals. Nothing is inherited or rolled up from the parent.

## Limits

- The core Projects list has no collapse control and the project sidebar stays flat: Paperclip offers no plugin slot there. Use the Project tree page for collapsing and organizing.
- "Create sub-project" creates the project through the core REST API with the signed-in board user's session, because the plugin worker has no host service that creates projects. Then it links the new project. If linking fails, the project exists at top level and the tab says so.
- The official Paperclip MCP server does not list plugin tools. MCP clients call the REST routes with the generic request tool, for example `paperclipApiRequest` with `POST /plugins/journeystudios.project-hierarchy/api/projects/<id>/parent?companyId=<company>`.

## Install

Requires the Paperclip host pinned in [docs/compatibility.md](../../docs/compatibility.md). No host compatibility patch is needed.

1. Verify the release `SHA256SUMS`, extract `package/` into an immutable directory on the host, for example `/paperclip/instances/default/plugins/journey-studios/project-hierarchy/<version>-<hash>`.
2. Install it as an instance admin: `POST /api/plugins/install` with `{"packageName": "<that path>", "isLocalPath": true}`. The host applies `migrations/001_project_hierarchy.sql` in the `plugin_project_hierarchy_f21f3d006f` schema. No restart is needed.

Upgrade: soft-unload (`DELETE /api/plugins/:id` without `purge`), then install the new path. Links and the schema are preserved.

## Development

```sh
pnpm --filter @journey-studios/paperclip-plugin-project-hierarchy typecheck
pnpm --filter @journey-studios/paperclip-plugin-project-hierarchy test
pnpm --filter @journey-studios/paperclip-plugin-project-hierarchy build
```

Tests run the real migration on PGlite against a fake host that enforces the host's runtime SQL rules, and validate the manifest with the pinned host's validator.
