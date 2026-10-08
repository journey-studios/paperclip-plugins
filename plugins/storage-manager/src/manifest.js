const apiRoute = (routeKey, path) => ({
  routeKey,
  method: "GET",
  path,
  auth: "board",
  capability: "api.routes.register",
  companyResolution: { from: "query", key: "companyId" },
});

const manifest = {
  id: "journey-studios.storage-manager",
  apiVersion: 1,
  version: "0.1.1",
  displayName: "Storage Manager",
  description: "Read-only host storage metrics from operator-provided snapshots; no Docker socket or cleanup access.",
  author: "Journey Studios",
  categories: ["ui", "automation"],
  capabilities: ["local.folders", "api.routes.register", "agent.tools.register", "ui.sidebar.register", "ui.page.register"],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  localFolders: [
    {
      folderKey: "storage-snapshot",
      displayName: "Storage Collector snapshots (read only)",
      description: "Configure the dedicated read-only host mount containing snapshot.json. Never select /, /var/lib/docker or a general workspace.",
      access: "read",
      requiredFiles: ["snapshot.json"],
    },
  ],
  apiRoutes: [apiRoute("overview", "/overview"), apiRoute("hotspots", "/hotspots"), apiRoute("tools", "/tools")],
  tools: [
    {
      name: "storage_overview",
      displayName: "Storage Manager overview",
      description: "Read the latest collected host disk capacity, Docker accounting, freshness and coverage (no cleanup).",
      parametersSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "storage_hotspots",
      displayName: "Storage Manager hotspots",
      description: "Read the largest measured host disk directories. Nested paths and Docker shared layers are not additive.",
      parametersSchema: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
        additionalProperties: false,
      },
    },
  ],
  ui: {
    slots: [
      { type: "sidebar", id: "storage-manager-sidebar", displayName: "Storage", exportName: "StorageSidebar", order: 39 },
      { type: "page", id: "storage-manager-page", displayName: "Storage Manager", exportName: "StoragePage", routePath: "storage" },
    ],
  },
};
export default manifest;
