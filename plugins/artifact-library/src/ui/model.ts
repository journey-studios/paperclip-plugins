import type { LibraryArtifact, LibraryFilters } from "../contracts.js";

export type Layout = "grid" | "list";
const kinds = new Set(["all", "image", "video", "text", "document", "file"]);

export function readLocation(search: string): {
  filters: LibraryFilters;
  layout: Layout;
  viewId?: string;
} {
  const params = new URLSearchParams(search);
  const filters: LibraryFilters = {};
  for (const key of ["q", "projectId", "agentId", "taskId", "tagId"] as const) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }
  if (params.has("folderId")) filters.folderId = params.get("folderId") || null;
  if (params.get("starred") === "true") filters.starred = true;
  const kind = params.get("kind");
  if (kind && kinds.has(kind)) filters.kind = kind as LibraryFilters["kind"];
  return {
    filters,
    layout: params.get("layout") === "list" ? "list" : "grid",
    viewId: params.get("viewId") || undefined,
  };
}

export function libraryPath(
  filters: LibraryFilters = {},
  layout: Layout = "grid",
  viewId?: string,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (key === "folderId" && value === null) params.set(key, "");
    else if (
      value !== undefined &&
      value !== "" &&
      value !== false &&
      value !== "all"
    )
      params.set(key, String(value));
  }
  if (layout !== "grid") params.set("layout", layout);
  if (viewId) params.set("viewId", viewId);
  return `/library${params.size ? `?${params}` : ""}`;
}

export function safeLink(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\"))
    return value;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function folderLabel(
  id: string,
  folders: Array<{ id: string; name: string; parentId: string | null }>,
): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let current = folders.find((folder) => folder.id === id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = folders.find((folder) => folder.id === current?.parentId);
  }
  return names.join(" / ");
}

/** Keep earlier pages current after the server accepts a metadata change. */
export function updateLoadedMetadata(
  artifacts: LibraryArtifact[],
  input: Record<string, unknown>,
  filters: LibraryFilters,
): LibraryArtifact[] {
  return artifacts.flatMap((artifact) => {
    if (artifact.id !== input.artifactId) return [artifact];
    const metadata = { ...artifact.metadata };
    if (input.folderId === null || typeof input.folderId === "string")
      metadata.folderId = input.folderId;
    if (typeof input.starred === "boolean") metadata.starred = input.starred;
    const tagIds = new Set(metadata.tagIds);
    if (typeof input.addTagId === "string") tagIds.add(input.addTagId);
    if (typeof input.removeTagId === "string") tagIds.delete(input.removeTagId);
    metadata.tagIds = [...tagIds];
    if (
      (filters.starred && !metadata.starred) ||
      (filters.folderId !== undefined && filters.folderId !== metadata.folderId) ||
      (filters.tagId && !metadata.tagIds.includes(filters.tagId))
    )
      return [];
    return [{ ...artifact, metadata }];
  });
}
