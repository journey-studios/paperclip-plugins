import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "journeystudios.evolution";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Org Tracker",
  description: "Track operational changes, diffs, evidence, runs, metrics, and conclusions across Paperclip agents and skills.",
  author: "Journey Studios",
  categories: ["automation", "ui"],
  capabilities: [
    "events.subscribe",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "ui.sidebar.register",
    "ui.page.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  database: {
    namespaceSlug: "evolution",
    migrationsDir: "migrations",
    coreReadTables: [
      "companies",
      "agents",
      "issues",
      "projects",
      "goals",
      "heartbeat_runs",
      "cost_events",
      "activity_log",
      "agent_config_revisions",
      "company_skills",
      "company_skill_versions"
    ]
  },
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "evolution-sidebar-link",
        displayName: "Org Tracker",
        exportName: "EvolutionSidebarLink",
        order: 56
      },
      {
        type: "page",
        id: "evolution-page",
        displayName: "Org Tracker",
        exportName: "EvolutionPage",
        routePath: "evolution"
      }
    ]
  }
};

export default manifest;
