import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { API_ROUTES } from "./routes.js";
import { TOOL_DECLARATIONS } from "./tools.js";

export const PLUGIN_ID = "journeystudios.project-hierarchy";
export const DATABASE_NAMESPACE = "plugin_project_hierarchy_f21f3d006f";
export const PLUGIN_VERSION = "0.2.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Sub-projects",
  description:
    "Nest projects under a parent project: a Sub-projects tab on every project, a company-wide project tree, and agent tools, without changing Paperclip core.",
  author: "Journey Studios",
  categories: ["ui"],
  capabilities: [
    "agent.tools.register",
    "projects.read",
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "activity.log.write",
    "ui.sidebar.register",
    "ui.page.register",
    "ui.detailTab.register",
    "ui.action.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: {
    namespaceSlug: "project_hierarchy",
    migrationsDir: "migrations",
    coreReadTables: ["companies", "projects"],
  },
  tools: TOOL_DECLARATIONS,
  // Agents running through CLI adapters reach the hierarchy over REST with their own token.
  apiRoutes: API_ROUTES.map((route) => ({
    ...route,
    auth: "board-or-agent" as const,
    capability: "api.routes.register" as const,
    companyResolution: { from: "query" as const, key: "companyId" },
  })),
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "project-hierarchy-sidebar",
        displayName: "Project tree",
        exportName: "SidebarLink",
        order: 36,
      },
      {
        type: "page",
        id: "project-hierarchy-page",
        displayName: "Project tree",
        exportName: "ProjectTreePage",
        routePath: "project-tree",
      },
      {
        type: "detailTab",
        id: "project-hierarchy-tab",
        displayName: "Sub-projects",
        exportName: "SubProjectsTab",
        entityTypes: ["project"],
        order: 5,
      },
      {
        // Core offers no slot on the Projects list; this invisible overlay
        // orders and indents the rows core rendered there.
        type: "appShellOverlay",
        id: "project-hierarchy-list-tree",
        displayName: "Project list tree",
        exportName: "ProjectListTree",
      },
    ],
  },
};

export default manifest;
