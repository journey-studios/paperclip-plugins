const apiRoute = (routeKey, path) => ({
  routeKey,
  method: "GET",
  path,
  auth: "board",
  capability: "api.routes.register",
  companyResolution: { from: "query", key: "companyId" },
});

const mcpApiRoute = (method) => ({
  routeKey: method === "POST" ? "mcp" : "mcp-get",
  method,
  path: "/mcp",
  auth: "board",
  capability: "api.routes.register",
  companyResolution: { from: "query", key: "companyId" },
});

const manifest = {
  id: "journey-studios.agent-observatory",
  apiVersion: 1,
  version: "0.2.0",
  displayName: "Agent Observatory",
  description: "Read-only observability for agent runs, costs, failures, and suspected anomalies.",
  author: "Journey Studios",
  categories: ["ui", "automation"],
  capabilities: [
    "database.namespace.read",
    "events.subscribe",
    "events.emit",
    "database.namespace.migrate",
    "api.routes.register",
    "ui.sidebar.register",
    "ui.page.register",
    "agent.tools.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: {
    namespaceSlug: "agent_observatory",
    migrationsDir: "migrations",
    coreReadTables: ["agents", "heartbeat_runs", "cost_events", "companies", "delivery_revisions", "delivery_evaluations", "run_execution_profiles"],
  },
  apiRoutes: [
    mcpApiRoute("POST"),
    mcpApiRoute("GET"),
    apiRoute("quality", "/quality"),
    apiRoute("overview", "/overview"),
    apiRoute("agents", "/agents"),
    apiRoute("agent", "/agent"),
    apiRoute("failures", "/failures"),
    apiRoute("anomalies", "/anomalies"),
    apiRoute("trace", "/trace"),
    apiRoute("tools", "/tools"),
    apiRoute("monthly-costs", "/monthly-costs"),
  ],
  tools: [
    {
      name: "observatory_delivery_quality",
      displayName: "Agent Delivery Quality",
      description: "Read reviewed delivery quality by agent, rubric and execution context, with feedback samples and partial coverage.",
      parametersSchema: { type: "object", properties: { agentId: { type: "string", format: "uuid" }, days: { type: "integer", minimum: 1, maximum: 365 }, environment: { type: "string", enum: ["production", "skill_test"] } }, additionalProperties: false },
    },
    {
      name: "observatory_overview",
      displayName: "Agent Observatory Overview",
      description: "Read a bounded, company-scoped summary of agent runs, failures, costs, and suspected anomalies.",
      parametersSchema: {
        type: "object",
        properties: { windowHours: { type: "integer", minimum: 1, maximum: 168 } },
        additionalProperties: false,
      },
    },
    {
      name: "observatory_monthly_costs",
      displayName: "Monthly Agent Costs",
      description: "Read spend by API and organization group for a calendar month; includes unpriced coverage.",
      parametersSchema: {
        type: "object",
        properties: { period: { type: "string", pattern: "^[12][0-9]{3}-(0[1-9]|1[0-2])$" } },
        additionalProperties: false,
      },
    },
    {
      name: "observatory_trace",
      displayName: "Agent Run Trace",
      description: "Read safe lifecycle timestamps and retry links for one heartbeat run in the current company.",
      parametersSchema: {
        type: "object",
        properties: { runId: { type: "string", format: "uuid" } },
        required: ["runId"],
        additionalProperties: false,
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "agent-observatory-sidebar",
        displayName: "Observatory",
        exportName: "SidebarLink",
        order: 38,
      },
      {
        type: "page",
        id: "observatory",
        displayName: "Agent Observatory",
        exportName: "ObservatoryPage",
        routePath: "observatory",
      },
    ],
  },
};

export default manifest;
