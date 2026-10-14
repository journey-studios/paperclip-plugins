/** Route table shared by the manifest (declaration) and the API module (dispatch). */
export const API_ROUTES = [
  { routeKey: "tree", method: "GET", path: "/tree" },
  { routeKey: "project-get", method: "GET", path: "/projects/:projectId" },
  { routeKey: "project-set-parent", method: "POST", path: "/projects/:projectId/parent" },
] as const;

export type ApiRouteKey = (typeof API_ROUTES)[number]["routeKey"];
