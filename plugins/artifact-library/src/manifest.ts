import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "journeystudios.artifact-library";
export const DATABASE_NAMESPACE = "plugin_artifact_library_ca55530627";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.1",
  displayName: "Artifact Library",
  description:
    "Organize company artifacts with folders, tags, favorites and saved views.",
  author: "Journey Studios",
  categories: ["ui"],
  capabilities: [
    "artifacts.read",
    "companies.read",
    "projects.read",
    "agents.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "activity.log.write",
    "ui.sidebar.register",
    "ui.page.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: {
    namespaceSlug: "artifact_library",
    migrationsDir: "migrations",
    coreReadTables: ["companies"],
  },
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "artifact-library-sidebar",
        displayName: "Library",
        exportName: "SidebarLink",
        order: 36,
      },
      {
        type: "page",
        id: "artifact-library-page",
        displayName: "Artifact Library",
        exportName: "LibraryPage",
        routePath: "library",
      },
      {
        type: "routeSidebar",
        id: "artifact-library-route-sidebar",
        displayName: "Artifact Library",
        exportName: "LibraryRouteSidebar",
        routePath: "library",
      },
    ],
  },
};

export default manifest;
