import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "journeystudios.evolution";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.3.0",
  displayName: "Org Tracker",
  description: "Track operational changes, diffs, evidence, runs, metrics, and conclusions across Paperclip agents and skills.",
  author: "Journey Studios",
  categories: ["automation", "ui"],
  capabilities: [
    "api.routes.register",
    "events.subscribe",
    "jobs.schedule",
    "agent.tools.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "ui.sidebar.register",
    "ui.page.register"
  ],
  jobs: [{
    jobKey: "refresh-assessments",
    displayName: "Refresh Org Tracker evaluations",
    description: "Reconcile bounded run evidence and observational assessments hourly.",
    schedule: "11 * * * *"
  }],
  tools: [
    {
      name: "org_tracker_list_changes",
      displayName: "Org Tracker Changes",
      description: "List a bounded selection of Change Sets and their observational assessments in the invoking agent's company.",
      parametersSchema: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
        additionalProperties: false
      }
    },
    {
      name: "org_tracker_change_summary",
      displayName: "Org Tracker Change Summary",
      description: "Read a company-scoped Change Set, affected entities, metrics, evidence counts, and its latest assessment without exposing configuration snapshots.",
      parametersSchema: {
        type: "object",
        properties: { changeSetId: { type: "string", format: "uuid" } },
        required: ["changeSetId"],
        additionalProperties: false
      }
    },
    {
      name: "org_tracker_delivery_quality",
      displayName: "Org Tracker Delivery Quality",
      description: "Compare eligible human-reviewed delivery quality before and after a change, by agent and execution cohort. Results are observational associations.",
      parametersSchema: {
        type: "object",
        properties: { changeSetId: { type: "string", format: "uuid" } },
        required: ["changeSetId"],
        additionalProperties: false
      }
    },
    {
      name: "org_tracker_evaluate_change",
      displayName: "Org Tracker Evaluate Change",
      description: "Refresh observational metrics, auto-associated run evidence, and an assessment for a Change Set in the invoking agent's company. Does not mark a change as proven.",
      parametersSchema: {
        type: "object",
        properties: { changeSetId: { type: "string", format: "uuid" } },
        required: ["changeSetId"],
        additionalProperties: false
      }
    }
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
      "company_skill_versions",
      "delivery_revisions",
      "delivery_evaluations",
      "run_execution_profiles"
    ] as unknown as NonNullable<PaperclipPluginManifestV1["database"]>["coreReadTables"]
  },
  apiRoutes: [
    ...(["POST", "GET"] as const).map((method) => ({
      routeKey: method === "POST" ? "mcp" : "mcp-get",
      method,
      path: "/mcp",
      auth: "board" as const,
      capability: "api.routes.register" as const,
      companyResolution: { from: "query" as const, key: "companyId" },
    })),
  ],
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
