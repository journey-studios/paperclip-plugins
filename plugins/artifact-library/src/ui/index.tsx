import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  usePluginData,
  type PluginPageProps,
  type PluginRouteSidebarProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import type { LibraryArtifact, LibraryFilters } from "../contracts.js";
import {
  folderLabel,
  libraryPath,
  readLocation,
  safeLink,
  updateLoadedMetadata,
  type Layout,
} from "./model.js";

type Folder = { id: string; name: string; parentId: string | null };
type Tag = { id: string; name: string; color: string };
type View = {
  id: string;
  name: string;
  filters: LibraryFilters;
  layout: Layout;
};
type Navigation = {
  companyId: string;
  folders: Folder[];
  tags: Tag[];
  views: View[];
  projects: { id: string; name: string }[];
  agents: { id: string; name: string }[];
};
type Library = Navigation & {
  queryKey: string | null;
  artifacts: LibraryArtifact[];
  nextCursor: string | null;
};
type Editor = {
  type: "folder" | "tag" | "view";
  id?: string;
  name: string;
  parentId?: string;
  color?: string;
};
const CHANGED = "artifact-library-changed";
const styles = `
.jal{color:var(--foreground);font:inherit}.jal *{box-sizing:border-box}.jal button,.jal input,.jal select{font:inherit}.jal button,.jal a{touch-action:manipulation}.jal button,.jal .button{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;border:1px solid var(--border);border-radius:.4rem;background:var(--background);color:var(--foreground);padding:.5rem .75rem;font-size:.8125rem;text-decoration:none;cursor:pointer;white-space:nowrap}.jal button:hover,.jal .button:hover{background:var(--accent)}.jal button:disabled{opacity:.45;cursor:wait}.jal button:focus-visible,.jal a:focus-visible,.jal input:focus-visible,.jal select:focus-visible{outline:2px solid var(--ring);outline-offset:2px}.jal button.active,.jal .primary{background:var(--foreground);color:var(--background)}.jal svg{width:1rem;height:1rem;flex-shrink:0}.jal h1,.jal h2,.jal p{margin:0}.jal h1{font-size:1.75rem;font-weight:600;letter-spacing:-.04em}.jal .muted{color:var(--muted-foreground)}.jal .eyebrow{font-size:.65rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted-foreground)}.jal .header{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1.5rem}.jal .subtitle{font-size:.8125rem;margin-top:.4rem;color:var(--muted-foreground)}.jal .actions{display:flex;flex-wrap:wrap;gap:.5rem}.jal .toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem;padding:1rem 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}.jal input,.jal select{background:var(--background);color:var(--foreground);border:1px solid var(--border);border-radius:.35rem;padding:.5rem .65rem;min-width:0;font-size:.8125rem}.jal .search{flex:1;min-width:12rem}.jal .content{display:flex;gap:1.5rem;align-items:flex-start;margin-top:1rem}.jal .results{flex:1;min-width:0}.jal .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(13rem,1fr));gap:1rem}.jal .card{border:1px solid var(--border);border-radius:.5rem;overflow:hidden;background:var(--card);position:relative}.jal .card.selected{outline:2px solid var(--ring);outline-offset:2px}.jal .preview{aspect-ratio:16/10;width:100%;display:flex;align-items:center;justify-content:center;background:var(--muted);overflow:hidden;position:relative;color:var(--muted-foreground)}.jal .preview img,.jal .preview video{width:100%;height:100%;object-fit:contain}.jal .preview p{padding:1rem;align-self:flex-start;font-size:.8125rem;white-space:pre-wrap;overflow:hidden;max-height:100%}.jal .card-body{padding:.85rem}.jal .card-title{font-size:.875rem;font-weight:550;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:.35rem;overflow-wrap:anywhere}.jal .card-meta{display:flex;gap:.5rem;font-size:.7rem;color:var(--muted-foreground);align-items:center;flex-wrap:wrap}.jal .card-footer{display:flex;justify-content:space-between;align-items:center;margin-top:.75rem;gap:.5rem}.jal .icon-button{padding:.4rem}.jal .favorite{color:var(--primary)}.jal .favorite svg{fill:var(--primary)}.jal .tags{display:flex;gap:.3rem;flex-wrap:wrap;margin-top:.5rem}.jal .tag{font-size:.65rem;padding:.15rem .4rem;background:var(--secondary);border-radius:.25rem;color:var(--secondary-foreground)}.jal .list{width:100%;border-collapse:collapse;font-size:.8125rem}.jal .list th{text-align:left;font-weight:400;color:var(--muted-foreground);font-size:.7rem;padding:.75rem}.jal .list td{padding:.75rem;border-top:1px solid var(--border);vertical-align:middle}.jal .list .list-title{font-weight:550;color:var(--foreground);display:block;border:0;background:transparent;padding:0;text-align:left;white-space:normal}.jal .panel{width:19rem;flex-shrink:0;border:1px solid var(--border);border-radius:.5rem;padding:1rem;background:var(--card)}.jal .panel h2{font-size:1rem;font-weight:600;margin:1rem 0}.jal .field{display:flex;flex-direction:column;gap:.4rem;margin-top:1rem;font-size:.75rem}.jal .field select,.jal .field input{width:100%}.jal .check{display:flex;align-items:center;gap:.5rem;margin:.65rem 0;font-size:.8125rem}.jal .check input{width:auto}.jal .empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.75rem;text-align:center;min-height:16rem;border:1px dashed var(--border);border-radius:.5rem;padding:2rem}.jal .error{padding:.85rem;border:1px solid var(--destructive);border-radius:.4rem;color:var(--destructive);font-size:.8125rem;margin:1rem 0}.jal .notice{font-size:.75rem;padding:.75rem 0;color:var(--muted-foreground)}.jal .editor{border:1px solid var(--border);border-radius:.5rem;padding:1rem;margin:1rem 0;background:var(--card)}.jal .editor h2{font-size:1rem}.jal .editor-fields{display:flex;align-items:flex-end;gap:1rem;flex-wrap:wrap}.jal .editor-fields .field{flex:1;min-width:10rem}.jal .editor-footer{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-top:1rem}.jal .load{display:flex;justify-content:center;padding:1.5rem}.jal-nav{padding:.75rem}.jal-nav .nav-group{margin:1.5rem 0}.jal-nav .nav-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem}.jal-nav a.nav-link{display:flex;align-items:center;gap:.55rem;padding:.55rem .65rem;border-radius:.35rem;text-decoration:none;color:var(--muted-foreground);font-size:.8125rem;min-width:0}.jal-nav a.nav-link:hover,.jal-nav a.nav-link[aria-current=page]{color:var(--foreground);background:var(--accent)}.jal-nav .nav-link span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.jal-nav .nav-note{font-size:.75rem;color:var(--muted-foreground);padding:.5rem .65rem}.jal .skeleton{height:15rem;background:var(--muted);border-radius:.5rem;animation:jal-pulse 1.5s ease-in-out infinite}@keyframes jal-pulse{50%{opacity:.5}}@media(prefers-reduced-motion:reduce){.jal .skeleton{animation:none}}@media(max-width:900px){.jal .content{flex-direction:column}.jal .panel{width:100%}.jal .hide-small{display:none}.jal .header{align-items:flex-start;flex-direction:column}}`;

function Icon({
  name,
}: {
  name:
    | "folder"
    | "star"
    | "library"
    | "grid"
    | "list"
    | "file"
    | "tag"
    | "refresh";
}) {
  const paths: Record<string, ReactNode> = {
    folder: <path d="M3 7h6l2 2h10v11H3zM3 7V4h6l2 3" />,
    star: <path d="m12 3 3 6 6 1-4.5 4.5 1 6.5L12 18l-5.5 3 1-6.5L3 10l6-1z" />,
    library: (
      <>
        <path d="M4 3h4v18H4zM10 3h4v18h-4zM17 3l4 1-2 17-4-1z" />
      </>
    ),
    grid: <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />,
    list: <path d="M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1" />,
    file: <path d="M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h6" />,
    tag: (
      <>
        <path d="m3 3 8 0 10 10-8 8L3 11z" />
        <circle cx="7" cy="7" r="1" />
      </>
    ),
    refresh: (
      <path d="M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 14-1l1 6M4 12l1 6a8 8 0 0 0 14-1" />
    ),
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

function useRefreshOnChange(refresh: () => void) {
  useEffect(() => {
    window.addEventListener(CHANGED, refresh);
    return () => window.removeEventListener(CHANGED, refresh);
  }, [refresh]);
}

function Preview({ artifact }: { artifact: LibraryArtifact }) {
  const [failed, setFailed] = useState(false);
  const src = safeLink(artifact.contentPath);
  if (!failed && src && artifact.mediaKind === "image")
    return (
      <div className="preview">
        <img
          src={src}
          alt={artifact.title}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </div>
    );
  if (!failed && src && artifact.mediaKind === "video")
    return (
      <div className="preview">
        <video
          src={src}
          controls
          preload="metadata"
          playsInline
          onError={() => setFailed(true)}
        />
      </div>
    );
  if (artifact.previewText)
    return (
      <div className="preview">
        <p>{artifact.previewText.slice(0, 700)}</p>
      </div>
    );
  return (
    <div className="preview">
      <Icon name="file" />
      <span>{artifact.mediaKind}</span>
    </div>
  );
}

export function SidebarLink(_: PluginSidebarProps) {
  const navigation = useHostNavigation();
  return (
    <div className="jal">
      <style>{styles}</style>
      <a
        {...navigation.linkProps("/library")}
        className="button"
        style={{ border: 0, width: "100%", justifyContent: "flex-start" }}
      >
        <Icon name="library" />
        Library
      </a>
    </div>
  );
}

export function LibraryRouteSidebar({ context }: PluginRouteSidebarProps) {
  const navigation = useHostNavigation();
  const location = useHostLocation();
  const current = readLocation(location.search);
  const query = usePluginData<Navigation>("navigation", {
    companyId: context.companyId,
  });
  useRefreshOnChange(query.refresh);
  const data = query.data?.companyId === context.companyId ? query.data : null;
  const link = (
    label: string,
    href: string,
    active: boolean,
    icon: Parameters<typeof Icon>[0]["name"],
    depth = 0,
  ) => (
    <a
      key={href}
      {...navigation.linkProps(href)}
      className="nav-link"
      aria-current={active ? "page" : undefined}
      style={{ paddingLeft: `${0.65 + depth * 0.7}rem` }}
    >
      <Icon name={icon} />
      <span>{label}</span>
    </a>
  );
  const folders = (
    parentId: string | null,
    depth = 0,
    seen = new Set<string>(),
  ): ReactNode =>
    depth > 30
      ? null
      : data?.folders
          .filter(
            (folder) => folder.parentId === parentId && !seen.has(folder.id),
          )
          .map((folder) => (
            <div key={folder.id}>
              {link(
                folder.name,
                libraryPath({ folderId: folder.id }),
                current.filters.folderId === folder.id,
                "folder",
                depth,
              )}
              {folders(folder.id, depth + 1, new Set([...seen, folder.id]))}
            </div>
          ));
  return (
    <nav className="jal jal-nav" aria-label="Artifact Library">
      <style>{styles}</style>
      <a {...navigation.linkProps("/dashboard")} className="nav-link">
        ← {context.companyPrefix ?? "Company"}
      </a>
      <div className="nav-group">
        <div className="nav-heading">
          <span className="eyebrow">Library</span>
        </div>
        {link(
          "All artifacts",
          libraryPath(),
          !Object.keys(current.filters).length && !current.viewId,
          "library",
        )}
        {link(
          "Favorites",
          libraryPath({ starred: true }),
          !!current.filters.starred,
          "star",
        )}
        {link(
          "Unfiled",
          libraryPath({ folderId: null }),
          current.filters.folderId === null,
          "folder",
        )}
      </div>
      {query.error && (
        <p className="error" role="alert">
          {query.error.message}
        </p>
      )}
      {query.loading && !data && <p className="nav-note">Loading library…</p>}
      <div className="nav-group">
        <div className="nav-heading">
          <span className="eyebrow">Folders</span>
          <a
            {...navigation.linkProps("/library?manage=folder")}
            aria-label="Create folder"
            className="nav-link"
          >
            +
          </a>
        </div>
        {folders(null)}
        {data?.folders.length === 0 && (
          <p className="nav-note">Create your first folder.</p>
        )}
      </div>
      <div className="nav-group">
        <div className="nav-heading">
          <span className="eyebrow">Tags</span>
          <a
            {...navigation.linkProps("/library?manage=tag")}
            aria-label="Create tag"
            className="nav-link"
          >
            +
          </a>
        </div>
        {data?.tags.map((tag) =>
          link(
            tag.name,
            libraryPath({ tagId: tag.id }),
            current.filters.tagId === tag.id,
            "tag",
          ),
        )}
      </div>
      <div className="nav-group">
        <div className="nav-heading">
          <span className="eyebrow">Saved views</span>
        </div>
        {data?.views.map((view) =>
          link(
            view.name,
            libraryPath(view.filters, view.layout, view.id),
            current.viewId === view.id,
            "list",
          ),
        )}
        {data?.views.length === 0 && (
          <p className="nav-note">Save filters as a view.</p>
        )}
      </div>
    </nav>
  );
}

export function LibraryPage({ context }: PluginPageProps) {
  const navigation = useHostNavigation();
  const location = useHostLocation();
  const current = useMemo(
    () => readLocation(location.search),
    [location.search],
  );
  const [draftSearch, setDraftSearch] = useState(current.filters.q ?? "");
  const [pagination, setPagination] = useState<{
    scope: string;
    cursor?: string;
    previous: LibraryArtifact[];
  }>({ scope: "", previous: [] });
  const scope = JSON.stringify({
    companyId: context.companyId,
    filters: current.filters,
  });
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const cursor = pagination.scope === scope ? pagination.cursor : undefined;
  const previous = useMemo(
    () => (pagination.scope === scope ? pagination.previous : []),
    [pagination, scope],
  );
  const resetPagination = () => setPagination({ scope, previous: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const query = usePluginData<Library>("library", {
    companyId: context.companyId,
    filters: current.filters,
    queryKey: scope,
    cursor,
    limit: 30,
  });
  const updateArtifact = usePluginAction("artifact-update");
  const saveFolder = usePluginAction("folder-save");
  const deleteFolder = usePluginAction("folder-delete");
  const saveTag = usePluginAction("tag-save");
  const deleteTag = usePluginAction("tag-delete");
  const saveView = usePluginAction("view-save");
  const deleteView = usePluginAction("view-delete");
  const data =
    query.data?.companyId === context.companyId &&
    query.data?.queryKey === scope
      ? query.data
      : null;
  const artifacts = useMemo(
    () => [
      ...new Map(
        [...previous, ...(data?.artifacts ?? [])].map((artifact) => [
          artifact.id,
          artifact,
        ]),
      ).values(),
    ],
    [previous, data],
  );
  const selected = artifacts.find((artifact) => artifact.id === selectedId);
  const activeFolder = data?.folders.find(
    (folder) => folder.id === current.filters.folderId,
  );
  const activeTag = data?.tags.find((tag) => tag.id === current.filters.tagId);
  const activeView = data?.views.find((view) => view.id === current.viewId);
  const title =
    activeView?.name ??
    activeFolder?.name ??
    (activeTag
      ? `#${activeTag.name}`
      : current.filters.starred
        ? "Favorites"
        : current.filters.folderId === null
          ? "Unfiled"
          : "Artifact Library");
  const navigateFilters = (filters: LibraryFilters, replace = false) =>
    navigation.navigate(libraryPath(filters, current.layout), { replace });

  useEffect(() => {
    setDraftSearch(current.filters.q ?? "");
  }, [current.filters.q]);
  useEffect(() => {
    resetPagination();
    setSelectedId(null);
    setActionError(null);
  }, [location.search, context.companyId]);
  useEffect(() => {
    const manage = new URLSearchParams(location.search).get("manage");
    if (manage === "folder" || manage === "tag")
      setEditor({ type: manage, name: "" });
  }, [location.search]);
  useEffect(() => {
    if (draftSearch.trim() === (current.filters.q ?? "")) return;
    const timeout = window.setTimeout(
      () =>
        navigateFilters(
          { ...current.filters, q: draftSearch.trim() || undefined },
          true,
        ),
      300,
    );
    return () => window.clearTimeout(timeout);
  }, [draftSearch, current.filters, current.layout]);
  useRefreshOnChange(query.refresh);

  const mutate = async (
    action: ReturnType<typeof usePluginAction>,
    input: Record<string, unknown>,
    success = "Library updated.",
  ) => {
    setBusy(true);
    setActionError(null);
    setMessage("");
    try {
      await action({ ...input, companyId: context.companyId });
      if (currentScope.current !== scope) return false;
      if (action === updateArtifact) {
        setPagination((state) =>
          state.scope === scope
            ? {
                ...state,
                previous: updateLoadedMetadata(
                  state.previous,
                  input,
                  current.filters,
                ),
              }
            : state,
        );
      } else resetPagination();
      query.refresh();
      window.dispatchEvent(new Event(CHANGED));
      setMessage(success);
      return true;
    } catch (error) {
      if (currentScope.current !== scope) return false;
      setActionError(
        error instanceof Error ? error.message : "Could not save this change.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  const favorite = (artifact: LibraryArtifact) =>
    void mutate(updateArtifact, {
      artifactId: artifact.id,
      issueId: artifact.issue.id,
      starred: !artifact.metadata.starred,
    });
  const submitEditor = async (event: FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    const input = { id: editor.id, name: editor.name.trim() };
    const result = await mutate(
      editor.type === "folder"
        ? saveFolder
        : editor.type === "tag"
          ? saveTag
          : saveView,
      editor.type === "folder"
        ? { ...input, parentId: editor.parentId || null }
        : editor.type === "tag"
          ? { ...input, color: editor.color || "slate" }
          : { ...input, filters: current.filters, layout: current.layout },
      "Saved.",
    );
    if (result) {
      setEditor(null);
      if (new URLSearchParams(location.search).has("manage"))
        navigateFilters(current.filters, true);
    }
  };
  const removeEditor = async () => {
    if (!editor?.id) return;
    const result = await mutate(
      editor.type === "folder"
        ? deleteFolder
        : editor.type === "tag"
          ? deleteTag
          : deleteView,
      { id: editor.id },
      "Removed from the library.",
    );
    if (result) {
      setEditor(null);
      navigateFilters({});
    }
  };
  const favoriteButton = (artifact: LibraryArtifact) => (
    <button
      className={`icon-button ${artifact.metadata.starred ? "favorite" : ""}`}
      disabled={busy}
      onClick={() => favorite(artifact)}
      aria-label={`${artifact.metadata.starred ? "Unfavorite" : "Favorite"} ${artifact.title}`}
      aria-pressed={artifact.metadata.starred}
    >
      <Icon name="star" />
    </button>
  );
  const open = (artifact: LibraryArtifact) =>
    safeLink(artifact.openPath) || safeLink(artifact.href);
  const tagBadges = (artifact: LibraryArtifact) => (
    <div className="tags">
      {artifact.metadata.tagIds.map((id) => {
        const tag = data?.tags.find((tag) => tag.id === id);
        return tag ? (
          <span className="tag" key={id}>
            #{tag.name}
          </span>
        ) : null;
      })}
    </div>
  );

  if (!context.companyId)
    return (
      <div className="jal">
        <style>{styles}</style>
        <div className="empty">
          Select a company to open its Artifact Library.
        </div>
      </div>
    );
  return (
    <div className="jal">
      <style>{styles}</style>
      <header className="header">
        <div>
          <p className="eyebrow">Artifact Library</p>
          <h1>{title}</h1>
          <p className="subtitle">Keep the work. Find the right artifact.</p>
        </div>
        <div className="actions">
          <button
            onClick={() =>
              setEditor({
                type: "folder",
                name: "",
                parentId: activeFolder?.id,
              })
            }
          >
            <Icon name="folder" />
            New folder
          </button>
          <button onClick={() => setEditor({ type: "tag", name: "" })}>
            <Icon name="tag" />
            New tag
          </button>
          <button
            className="primary"
            onClick={() =>
              setEditor({
                type: "view",
                name: title === "Artifact Library" ? "" : title,
              })
            }
          >
            Save view
          </button>
        </div>
      </header>
      {editor && (
        <form
          className="editor"
          onSubmit={submitEditor}
          aria-label={`${editor.id ? "Edit" : "Create"} ${editor.type}`}
        >
          <h2>
            {editor.id ? "Edit" : "New"}{" "}
            {editor.type === "view" ? "saved view" : editor.type}
          </h2>
          <div className="editor-fields">
            <label className="field">
              Name
              <input
                autoFocus
                required
                maxLength={editor.type === "tag" ? 50 : 100}
                value={editor.name}
                onChange={(event) =>
                  setEditor({ ...editor, name: event.target.value })
                }
              />
            </label>
            {editor.type === "folder" && (
              <label className="field">
                Parent folder
                <select
                  value={editor.parentId || ""}
                  onChange={(event) =>
                    setEditor({ ...editor, parentId: event.target.value })
                  }
                >
                  <option value="">Library root</option>
                  {data?.folders
                    .filter((folder) => folder.id !== editor.id)
                    .map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {folderLabel(folder.id, data.folders)}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {editor.type === "tag" && (
              <label className="field">
                Color
                <select
                  value={editor.color || "slate"}
                  onChange={(event) =>
                    setEditor({ ...editor, color: event.target.value })
                  }
                >
                  {["slate", "blue", "green", "amber", "rose", "violet"].map(
                    (color) => (
                      <option key={color} value={color}>
                        {color[0].toUpperCase() + color.slice(1)}
                      </option>
                    ),
                  )}
                </select>
              </label>
            )}
          </div>
          {editor.id && editor.type !== "view" && (
            <p className="notice">
              Removing a {editor.type} keeps the original artifacts. Folder
              contents return to Unfiled.
            </p>
          )}
          <div className="editor-footer">
            <div className="actions">
              <button
                type="button"
                onClick={() => {
                  setEditor(null);
                  if (new URLSearchParams(location.search).has("manage"))
                    navigateFilters(current.filters, true);
                }}
              >
                Cancel
              </button>
              {editor.id && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void removeEditor()}
                >
                  Remove {editor.type}
                </button>
              )}
            </div>
            <button
              className="primary"
              type="submit"
              disabled={busy || !editor.name.trim()}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}
      <div className="toolbar">
        <input
          className="search"
          aria-label="Search artifacts"
          maxLength={160}
          placeholder="Search artifacts…"
          value={draftSearch}
          onChange={(event) => setDraftSearch(event.target.value)}
        />
        <select
          aria-label="Artifact type"
          value={current.filters.kind || "all"}
          onChange={(event) =>
            navigateFilters({
              ...current.filters,
              kind: event.target.value as LibraryFilters["kind"],
            })
          }
        >
          {["all", "image", "video", "document", "text", "file"].map((kind) => (
            <option value={kind} key={kind}>
              {kind === "all"
                ? "All types"
                : kind[0].toUpperCase() + kind.slice(1)}
            </option>
          ))}
        </select>
        <select
          aria-label="Project"
          value={current.filters.projectId || ""}
          onChange={(event) =>
            navigateFilters({
              ...current.filters,
              projectId: event.target.value || undefined,
            })
          }
        >
          <option value="">All projects</option>
          {data?.projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Agent"
          value={current.filters.agentId || ""}
          onChange={(event) =>
            navigateFilters({
              ...current.filters,
              agentId: event.target.value || undefined,
            })
          }
        >
          <option value="">All agents</option>
          {data?.agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Task"
          value={current.filters.taskId || ""}
          onChange={(event) =>
            navigateFilters({
              ...current.filters,
              taskId: event.target.value || undefined,
            })
          }
        >
          <option value="">All tasks</option>
          {[
            ...new Map(
              artifacts.map((artifact) => [artifact.issue.id, artifact.issue]),
            ).values(),
          ].map((issue) => (
            <option key={issue.id} value={issue.id}>
              {issue.identifier} · {issue.title}
            </option>
          ))}
        </select>
        <button
          className={
            current.layout === "grid" ? "active icon-button" : "icon-button"
          }
          aria-label="Grid view"
          aria-pressed={current.layout === "grid"}
          onClick={() =>
            navigation.navigate(
              libraryPath(current.filters, "grid", current.viewId),
            )
          }
        >
          <Icon name="grid" />
        </button>
        <button
          className={
            current.layout === "list" ? "active icon-button" : "icon-button"
          }
          aria-label="List view"
          aria-pressed={current.layout === "list"}
          onClick={() =>
            navigation.navigate(
              libraryPath(current.filters, "list", current.viewId),
            )
          }
        >
          <Icon name="list" />
        </button>
        <button
          className="icon-button"
          aria-label="Refresh library"
          onClick={() => {
            resetPagination();
            query.refresh();
          }}
        >
          <Icon name="refresh" />
        </button>
      </div>
      <div className="actions" style={{ marginTop: ".75rem" }}>
        {Object.keys(current.filters).length > 0 && (
          <button onClick={() => navigateFilters({})}>Clear filters</button>
        )}
        {activeFolder && (
          <button
            onClick={() =>
              setEditor({
                type: "folder",
                ...activeFolder,
                parentId: activeFolder.parentId || "",
              })
            }
          >
            Edit folder
          </button>
        )}
        {activeTag && (
          <button onClick={() => setEditor({ type: "tag", ...activeTag })}>
            Edit tag
          </button>
        )}
        {activeView && (
          <button onClick={() => setEditor({ type: "view", ...activeView })}>
            Update saved view
          </button>
        )}
      </div>
      {actionError && (
        <p role="alert" className="error">
          {actionError}
        </p>
      )}
      <p role="status" aria-live="polite" className="notice">
        {message ||
          `${artifacts.length} artifacts loaded${data?.nextCursor ? " · more available" : ""}`}
      </p>
      {query.error ? (
        <div className="error" role="alert">
          {query.error.message}{" "}
          <button onClick={query.refresh}>Try again</button>
        </div>
      ) : (
        <div className="content">
          <main className="results" aria-busy={query.loading}>
            {query.loading && !artifacts.length ? (
              <div className="grid">
                {[1, 2, 3].map((key) => (
                  <div key={key} className="skeleton" />
                ))}
              </div>
            ) : !artifacts.length && data?.nextCursor ? (
              <div className="empty">
                <Icon name="library" />
                <h2>No matches in recent artifacts</h2>
                <p className="muted">Older artifacts have not been searched yet.</p>
              </div>
            ) : !artifacts.length ? (
              <div className="empty">
                <Icon name="library" />
                <h2>No artifacts here yet</h2>
                <p className="muted">
                  Try another folder or clear the filters to see more work.
                </p>
                <button onClick={() => navigateFilters({})}>
                  Browse all artifacts
                </button>
              </div>
            ) : current.layout === "grid" ? (
              <div className="grid">
                {artifacts.map((artifact) => (
                  <article
                    className={`card ${selectedId === artifact.id ? "selected" : ""}`}
                    key={artifact.id}
                  >
                    <Preview artifact={artifact} />
                    <div className="card-body">
                      <div className="card-title">{artifact.title}</div>
                      <div className="card-meta">
                        <span>{artifact.issue.identifier}</span>
                        <span>·</span>
                        <span>
                          {artifact.project?.name ?? artifact.mediaKind}
                        </span>
                      </div>
                      {tagBadges(artifact)}
                      <div className="card-footer">
                        <button onClick={() => setSelectedId(artifact.id)}>
                          Organize
                        </button>
                        <div className="actions">
                          {open(artifact) && (
                            <a
                              className="button icon-button"
                              href={open(artifact)}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`Open ${artifact.title}`}
                            >
                              ↗
                            </a>
                          )}
                          {favoriteButton(artifact)}
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <table className="list">
                <thead>
                  <tr>
                    <th>Artifact</th>
                    <th className="hide-small">Project / Task</th>
                    <th className="hide-small">Updated</th>
                    <th>Favorite</th>
                  </tr>
                </thead>
                <tbody>
                  {artifacts.map((artifact) => (
                    <tr key={artifact.id}>
                      <td>
                        <button
                          className="list-title"
                          onClick={() => setSelectedId(artifact.id)}
                        >
                          {artifact.title}
                        </button>
                        {tagBadges(artifact)}
                      </td>
                      <td className="hide-small">
                        <span>{artifact.project?.name ?? "—"}</span>
                        <br />
                        <span className="muted">
                          {artifact.issue.identifier}
                        </span>
                      </td>
                      <td className="hide-small muted">
                        {new Date(artifact.updatedAt).toLocaleDateString()}
                      </td>
                      <td>{favoriteButton(artifact)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {data?.nextCursor && (
              <div className="load">
                <button
                  disabled={query.loading}
                  onClick={() => {
                    setPagination({
                      scope,
                      previous: artifacts,
                      cursor: data.nextCursor || undefined,
                    });
                  }}
                >
                  {query.loading ? "Loading…" : "Load more artifacts"}
                </button>
              </div>
            )}
          </main>
          {selected && (
            <aside className="panel" aria-label={`Organize ${selected.title}`}>
              <div
                className="actions"
                style={{ justifyContent: "space-between" }}
              >
                <span className="eyebrow">Organize artifact</span>
                <button
                  className="icon-button"
                  aria-label="Close artifact details"
                  onClick={() => setSelectedId(null)}
                >
                  ×
                </button>
              </div>
              <h2>{selected.title}</h2>
              <p className="subtitle">
                {selected.issue.identifier} ·{" "}
                {selected.createdByAgent?.name ?? selected.source}
              </p>
              <label className="field">
                Folder
                <select
                  disabled={busy}
                  value={selected.metadata.folderId ?? ""}
                  onChange={(event) =>
                    void mutate(updateArtifact, {
                      artifactId: selected.id,
                      issueId: selected.issue.id,
                      folderId: event.target.value || null,
                    })
                  }
                >
                  <option value="">Unfiled</option>
                  {data?.folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folderLabel(folder.id, data.folders)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={selected.metadata.starred}
                  onChange={() => favorite(selected)}
                />
                Favorite
              </label>
              <p className="eyebrow" style={{ marginTop: "1rem" }}>
                Tags
              </p>
              {data?.tags.map((tag) => (
                <label className="check" key={tag.id}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={selected.metadata.tagIds.includes(tag.id)}
                    onChange={(event) =>
                      void mutate(updateArtifact, {
                        artifactId: selected.id,
                        issueId: selected.issue.id,
                        [event.target.checked ? "addTagId" : "removeTagId"]:
                          tag.id,
                      })
                    }
                  />
                  {tag.name}
                </label>
              ))}
              {data?.tags.length === 0 && (
                <p className="notice">
                  Create a tag to organize this artifact.
                </p>
              )}
              <div className="actions" style={{ marginTop: "1rem" }}>
                {open(selected) && (
                  <a
                    className="button"
                    href={open(selected)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open artifact ↗
                  </a>
                )}
                {safeLink(selected.downloadPath) && (
                  <a
                    className="button"
                    href={safeLink(selected.downloadPath)}
                    download
                  >
                    Download
                  </a>
                )}
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
