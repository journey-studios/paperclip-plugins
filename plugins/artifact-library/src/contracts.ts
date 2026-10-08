import type { PluginContext } from "@paperclipai/plugin-sdk";
// Derived from the pinned SDK artifacts.list return contract.
type CompanyArtifact = Awaited<ReturnType<PluginContext["artifacts"]["list"]>>["artifacts"][number];

export interface LibraryFilters {
  q?: string;
  projectId?: string;
  agentId?: string;
  taskId?: string;
  kind?: "all" | "image" | "video" | "text" | "document" | "file";
  /** null selects unfiled artifacts; omission selects every folder. */
  folderId?: string | null;
  tagId?: string;
  starred?: boolean;
}
export interface LibraryFolder {
  id: string;
  name: string;
  parentId: string | null;
}
export interface LibraryTag {
  id: string;
  name: string;
  color: string;
}
export interface LibraryView {
  id: string;
  name: string;
  filters: LibraryFilters;
  layout: "grid" | "list";
}
export interface ArtifactMetadata {
  folderId: string | null;
  tagIds: string[];
  starred: boolean;
}
export interface LibraryArtifact extends CompanyArtifact {
  metadata: ArtifactMetadata;
}
export interface LibraryNavigation {
  companyId: string;
  folders: LibraryFolder[];
  tags: LibraryTag[];
  views: LibraryView[];
  projects: { id: string; name: string }[];
  agents: { id: string; name: string }[];
}
export interface LibraryResponse extends LibraryNavigation {
  queryKey: string | null;
  artifacts: LibraryArtifact[];
  nextCursor: string | null;
}
