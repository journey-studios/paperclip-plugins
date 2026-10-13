import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { INSTANCE_CONFIG_SCHEMA } from "./settings.js";
import { API_ROUTES } from "./routes.js";
import { TOOL_DECLARATIONS } from "./tools.js";

export const PLUGIN_ID = "journeystudios.project-dashboards";
export const DATABASE_NAMESPACE = "plugin_project_dashboards_54173784c0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.3.0",
  displayName: "Project Dashboards",
  description:
    "Agents publish project tracking dashboards (KPIs, charts, tables, Markdown, Mermaid) from a declarative spec, rendered natively in Paperclip.",
  author: "Journey Studios",
  categories: ["ui"],
  capabilities: [
    "agent.tools.register",
    "agents.read",
    "projects.read",
    "companies.read",
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "activity.log.write",
    "ui.sidebar.register",
    "ui.page.register",
    "ui.detailTab.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: {
    namespaceSlug: "project_dashboards",
    migrationsDir: "migrations",
    coreReadTables: ["companies", "projects"],
  },
  instanceConfigSchema: INSTANCE_CONFIG_SCHEMA,
  tools: TOOL_DECLARATIONS,
  apiRoutes: API_ROUTES.map((route) => ({
    ...route,
    auth: "board" as const,
    capability: "api.routes.register" as const,
    companyResolution: { from: "query" as const, key: "companyId" },
  })),
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "project-dashboards-sidebar",
        displayName: "Dashboards",
        exportName: "SidebarLink",
        order: 37,
      },
      {
        type: "page",
        id: "project-dashboards-page",
        displayName: "Dashboards",
        exportName: "DashboardsPage",
        routePath: "dashboards",
      },
      {
        type: "detailTab",
        id: "project-dashboards-tab",
        displayName: "Dashboard",
        exportName: "ProjectDashboardTab",
        entityTypes: ["project"],
      },
    ],
  },
};

export default manifest;
