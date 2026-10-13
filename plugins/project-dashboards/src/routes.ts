/** Route table shared by the manifest (declaration) and the API module (dispatch). */
export const API_ROUTES = [
  { routeKey: "dashboards-list", method: "GET", path: "/dashboards" },
  { routeKey: "dashboard-get", method: "GET", path: "/dashboards/:slug" },
  { routeKey: "dashboard-status", method: "GET", path: "/dashboards/:slug/status" },
  { routeKey: "dashboard-upsert", method: "POST", path: "/dashboards" },
  { routeKey: "dataset-update", method: "POST", path: "/dashboards/:slug/datasets/:datasetId" },
  { routeKey: "spec-validate", method: "POST", path: "/validate" },
] as const;

export type ApiRouteKey = (typeof API_ROUTES)[number]["routeKey"];
