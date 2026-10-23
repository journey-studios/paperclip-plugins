import { PLUGIN_ID } from "./contract.js";
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = { type: "string" };
const secret = object({ type: { const: "secret_ref", type: "string" }, secretId: { type: "string", format: "uuid" } }, ["type", "secretId"]);
export const TOOLS = [
  { name: "request_review", displayName: "Request performance review", description: "Queue a configured target for an on-demand ephemeral Lighthouse review. Returns immediately with a run ID; does not wait for the browser.", parametersSchema: object({ targetKey: text, requestKey: text }, ["targetKey", "requestKey"]) },
  { name: "list_runs", displayName: "List performance runs", description: "List review summaries and cold/warm numbers in this company (default 20). For older pages pass the last row's created_at and id as before/beforeId. get_run returns individual samples. Failed runs remain visible.", parametersSchema: object({ targetKey: text, environment: { enum: ["prod", "staging", "test"], type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 }, before: text, beforeId: { type: "string", format: "uuid" } }) },
  { name: "get_run", displayName: "Get performance review", description: "Get one company-scoped run, all six sanitized samples, arithmetic means and quality gates.", parametersSchema: object({ runId: { type: "string", format: "uuid" } }, ["runId"]) },
  { name: "list_targets", displayName: "List performance targets", description: "List configured environments, scenarios and collection intervals without exposing credentials or private URLs.", parametersSchema: object({}) },
];
export default {
  id: PLUGIN_ID, apiVersion: 1, version: "0.1.2", displayName: "Performance Observatory", author: "Journey Studios",
  description: "Private on-demand and scheduled Lighthouse reviews, ephemeral executors, environment-separated charts and queryable metrics.",
  categories: ["ui", "automation"],
  capabilities: ["agent.tools.register", "api.routes.register", "companies.read", "projects.read", "http.outbound", "secrets.read-ref", "jobs.schedule", "database.namespace.migrate", "database.namespace.read", "database.namespace.write", "ui.sidebar.register", "ui.page.register", "ui.detailTab.register"],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: { namespaceSlug: "performance_observatory", migrationsDir: "migrations", coreReadTables: ["companies", "projects"] },
  jobs: [{ jobKey: "collect", schedule: "* * * * *", displayName: "Collect and reconcile performance reviews" }],
  tools: TOOLS,
  apiRoutes: [
    { routeKey: "runs-list", method: "GET", path: "/runs" },
    { routeKey: "run-get", method: "GET", path: "/runs/:runId" },
    { routeKey: "review-request", method: "POST", path: "/reviews" },
    { routeKey: "targets-list", method: "GET", path: "/targets" },
  ].map((route) => ({ ...route, auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } })),
  instanceConfigSchema: object({
    controllerUrl: { type: "string", format: "uri", title: "Private executor controller URL" },
    controllerTokenRef: { ...secret, title: "Controller bearer token" },
    targets: { type: "array", maxItems: 40, title: "Review targets", items: object({
      key: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" }, title: text,
      projectId: { type: "string", format: "uuid" }, url: { type: "string", format: "uri" }, startUrl: text,
      environment: { type: "string", enum: ["prod", "staging", "test"] }, scenario: { type: "string", enum: ["reload", "home-to-chat", "page"] },
      profile: { type: "string", enum: ["mobile", "desktop"], default: "mobile" },
      authProfile: { type: "string", enum: ["public", "prod", "staging", "test"], default: "public" },
      enabled: { type: "boolean", default: false }, intervalMinutes: { type: "integer", minimum: 15, maximum: 10080, default: 360 },
      selectors: object({ ready: text, history: text, click: text, conversation: text }),
    }, ["key", "projectId", "url", "environment"]) },
  }),
  ui: { slots: [
    { type: "sidebar", id: "performance-nav", displayName: "Performance", exportName: "SidebarLink", order: 38 },
    { type: "page", id: "performance-page", displayName: "Performance", exportName: "PerformancePage", routePath: "performance" },
    { type: "detailTab", id: "performance-project", displayName: "Performance", exportName: "ProjectPerformanceTab", entityTypes: ["project"], order: 25 },
  ] },
};
