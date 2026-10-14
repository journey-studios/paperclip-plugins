import { useMemo, useState, type FormEvent } from "react";
import {
  ProjectPicker,
  useHostNavigation,
  usePluginAction,
  usePluginData,
  type PluginDetailTabProps,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import type { ProjectHierarchy, ProjectNode, ProjectTree } from "../contracts.js";
import { ancestorIds, flattenTree } from "../tree.js";
import { styles } from "./styles.js";

/** Route segment of a project page; the host resolves the company prefix. */
export function projectPath(node: Pick<ProjectNode, "id" | "urlKey">): string {
  return `/projects/${encodeURIComponent(node.urlKey ?? node.id)}`;
}

/** Bridge failures arrive as plain `{ code, message }` objects, not Error instances. */
export function message(error: unknown): string {
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

function TreeIcon() {
  return (
    <svg className="jph-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="1.75" y="1.75" width="5" height="3.5" rx="1" />
      <rect x="9.25" y="6.25" width="5" height="3.5" rx="1" />
      <rect x="9.25" y="10.75" width="5" height="3.5" rx="1" />
      <path d="M4.25 5.25v7.25h5M4.25 8h5" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M3.5 2l3 3-3 3" />
    </svg>
  );
}

function State({ title, body }: { title: string; body?: string }) {
  return (
    <div className="jph-state">
      <strong>{title}</strong>
      {body ? <span>{body}</span> : null}
    </div>
  );
}

function ProjectLink({ node, className }: { node: ProjectNode; className?: string }) {
  const navigation = useHostNavigation();
  return (
    <a {...navigation.linkProps(projectPath(node))} className={className}>
      {node.name}
    </a>
  );
}

function StatusPill({ node }: { node: ProjectNode }) {
  if (node.archived) {
    return <span className="jph-pill">archived</span>;
  }
  return node.status ? <span className="jph-pill">{node.status.replaceAll("_", " ")}</span> : null;
}

function Dot({ node }: { node: ProjectNode }) {
  return <span className="jph-dot" style={node.color ? { background: node.color } : undefined} aria-hidden="true" />;
}

/** Calls the setParent action and reports failures inline instead of throwing into the host. */
function useMove(companyId: string, onDone: () => void) {
  const setParent = usePluginAction("setParent");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const move = async (projectId: string, parentProjectId: string | null): Promise<boolean> => {
    setPending(true);
    try {
      await setParent({ companyId, projectId, parentProjectId });
      setError(null);
      onDone();
      return true;
    } catch (failure) {
      setError(message(failure));
      return false;
    } finally {
      setPending(false);
    }
  };
  return { move, pending, error, setError };
}

export function SidebarLink({ context: _context }: PluginSidebarProps) {
  const navigation = useHostNavigation();
  return (
    <div className="jph">
      <style>{styles}</style>
      <a {...navigation.linkProps("/project-tree")} className="jph-nav">
        <TreeIcon />
        Project tree
      </a>
    </div>
  );
}

/**
 * Creates the project through the core REST API with the board user's session,
 * because the plugin worker has no host service that creates projects. The
 * plugin then links it; if linking fails, the project exists top-level and the
 * error says so.
 */
async function createProject(companyId: string, name: string): Promise<{ id: string }> {
  const response = await fetch(`/api/companies/${encodeURIComponent(companyId)}/projects`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, status: "planned" }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Project creation failed (${response.status})`);
  }
  return (await response.json()) as { id: string };
}

function CreateSubProject({ companyId, parentId, onCreated }: { companyId: string; parentId: string; onCreated: () => void }) {
  const setParent = usePluginAction("setParent");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || pending) {
      return;
    }
    setPending(true);
    try {
      const created = await createProject(companyId, trimmed);
      try {
        await setParent({ companyId, projectId: created.id, parentProjectId: parentId });
      } catch (failure) {
        setError(`Created "${trimmed}" but could not link it here: ${message(failure)}`);
        onCreated();
        return;
      }
      setName("");
      setError(null);
      onCreated();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <form className="jph-row" onSubmit={(event) => void submit(event)}>
      <input
        className="jph-field"
        aria-label="New sub-project name"
        placeholder="New sub-project name"
        value={name}
        disabled={pending}
        onChange={(event) => setName(event.target.value)}
      />
      <button type="submit" className="jph-btn" disabled={pending || !name.trim()}>
        {pending ? "Creating…" : "Create sub-project"}
      </button>
      {error ? (
        <span className="jph-error" role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
}

export function SubProjectsTab({ context }: PluginDetailTabProps) {
  const companyId = context.companyId;
  const projectId = context.entityId;
  const hierarchy = usePluginData<ProjectHierarchy>("project", { companyId, projectId });
  const { move, pending, error } = useMove(companyId ?? "", hierarchy.refresh);

  let body;
  if (!companyId) {
    body = <State title="Select a company to see sub-projects." />;
  } else if (hierarchy.error) {
    body = <State title="Could not load the project hierarchy" body={hierarchy.error.message} />;
  } else if (!hierarchy.data) {
    body = <State title="Loading…" />;
  } else {
    const { project, parent, ancestors, children, descendantCount } = hierarchy.data;
    body = (
      <div className="jph-stack">
        <section className="jph-section" aria-label="Location">
          <h2 className="jph-h2">Location</h2>
          <nav className="jph-path" aria-label="Project path">
            {ancestors.length === 0 ? <span className="jph-muted">Top-level project</span> : null}
            {ancestors.map((ancestor) => (
              <span key={ancestor.id} className="jph-path">
                <ProjectLink node={ancestor} />
                <span className="jph-sep" aria-hidden="true">
                  /
                </span>
              </span>
            ))}
            {ancestors.length > 0 ? <span className="jph-current">{project.name}</span> : null}
          </nav>
          <div className="jph-row">
            <span className="jph-muted jph-small">Parent project</span>
            <ProjectPicker
              companyId={companyId}
              value={parent?.id ?? ""}
              onChange={(nextParentId) => void move(projectId, nextParentId || null)}
              placeholder="Choose a parent project"
              noneLabel="No parent (top-level)"
            />
            {parent ? (
              <button type="button" className="jph-btn" disabled={pending} onClick={() => void move(projectId, null)}>
                Make top-level
              </button>
            ) : null}
          </div>
        </section>

        <section className="jph-section" aria-label="Sub-projects">
          <h2 className="jph-h2">
            Sub-projects <span className="jph-count">{children.length}{descendantCount > children.length ? ` direct · ${descendantCount} total` : ""}</span>
          </h2>
          {children.length > 0 ? (
            <div className="jph-card">
              {children.map((child) => (
                <div key={child.id} className="jph-item">
                  <Dot node={child} />
                  <ProjectLink node={child} className="jph-name" />
                  <StatusPill node={child} />
                  <button
                    type="button"
                    className="jph-btn"
                    disabled={pending}
                    aria-label={`Detach ${child.name}`}
                    onClick={() => void move(child.id, null)}
                  >
                    Detach
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <span className="jph-muted jph-small">No sub-projects yet.</span>
          )}
          <div className="jph-row">
            <ProjectPicker
              companyId={companyId}
              value=""
              onChange={(childId) => {
                if (childId) {
                  void move(childId, projectId);
                }
              }}
              placeholder="Add an existing project…"
              noneLabel="Add an existing project…"
            />
          </div>
          <CreateSubProject companyId={companyId} parentId={projectId} onCreated={hierarchy.refresh} />
        </section>
        {error ? (
          <span className="jph-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="jph" style={{ padding: 16 }}>
      <style>{styles}</style>
      {body}
    </div>
  );
}

function TreeRows({
  companyId,
  nodes,
  organize,
  onMoved,
}: {
  companyId: string;
  nodes: ProjectNode[];
  organize: boolean;
  onMoved: () => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const { move, error } = useMove(companyId, onMoved);
  const rows = flattenTree(nodes, collapsed);
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  return (
    <>
      <div className="jph-card" role="tree" aria-label="Projects">
        {rows.map(({ node, depth, childCount }) => {
          const expanded = !collapsed.has(node.id);
          return (
            <div
              key={node.id}
              className="jph-item"
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={childCount > 0 ? expanded : undefined}
              style={{ paddingLeft: 12 + depth * 22 }}
            >
              {childCount > 0 ? (
                <button
                  type="button"
                  className="jph-toggle"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${node.name}`}
                  onClick={() => toggle(node.id)}
                >
                  <Chevron />
                </button>
              ) : (
                <span className="jph-spacer" aria-hidden="true" />
              )}
              <Dot node={node} />
              <ProjectLink node={node} className="jph-name" />
              {childCount > 0 ? (
                <span className="jph-count">
                  {childCount} sub-project{childCount === 1 ? "" : "s"}
                </span>
              ) : null}
              <StatusPill node={node} />
              {organize ? (
                <ProjectPicker
                  companyId={companyId}
                  value={node.parentId ?? ""}
                  onChange={(parentId) => void move(node.id, parentId || null)}
                  placeholder="Parent"
                  noneLabel="No parent (top-level)"
                />
              ) : null}
            </div>
          );
        })}
      </div>
      {error ? (
        <span className="jph-error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

function SearchResults({ nodes, all }: { nodes: ProjectNode[]; all: ProjectNode[] }) {
  const byId = useMemo(() => new Map(all.map((node) => [node.id, node])), [all]);
  const parentOf = useMemo(() => new Map(all.filter((node) => node.parentId).map((node) => [node.id, node.parentId!])), [all]);
  if (nodes.length === 0) {
    return <State title="No projects match." />;
  }
  return (
    <div className="jph-card">
      {nodes.map((node) => {
        const path = ancestorIds(node.id, parentOf)
          .map((id) => byId.get(id)?.name)
          .filter(Boolean)
          .join(" / ");
        return (
          <div key={node.id} className="jph-item">
            <Dot node={node} />
            <ProjectLink node={node} className="jph-name" />
            {path ? <span className="jph-muted jph-small">{path}</span> : null}
            <StatusPill node={node} />
          </div>
        );
      })}
    </div>
  );
}

export function ProjectTreePage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const tree = usePluginData<ProjectTree>("tree", { companyId });
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [organize, setOrganize] = useState(false);

  const visible = useMemo(
    () => (tree.data?.projects ?? []).filter((node) => showArchived || !node.archived),
    [tree.data, showArchived],
  );
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? visible.filter((node) => node.name.toLowerCase().includes(needle)) : null;
  }, [query, visible]);

  let body;
  if (!companyId) {
    body = <State title="Select a company to see its projects." />;
  } else if (tree.error) {
    body = <State title="Could not load projects" body={tree.error.message} />;
  } else if (!tree.data) {
    body = <State title="Loading…" />;
  } else if (visible.length === 0) {
    body = <State title="No projects yet." />;
  } else if (matches) {
    body = <SearchResults nodes={matches} all={tree.data.projects} />;
  } else {
    body = <TreeRows companyId={companyId} nodes={visible} organize={organize} onMoved={tree.refresh} />;
  }

  return (
    <div className="jph jph-page">
      <style>{styles}</style>
      <h1 className="jph-title">Project tree</h1>
      <div className="jph-row">
        <input
          className="jph-field"
          type="search"
          aria-label="Filter projects"
          placeholder="Filter projects"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="jph-row jph-small">
          <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
          Show archived
        </label>
        <button type="button" className="jph-btn" aria-pressed={organize} onClick={() => setOrganize((value) => !value)}>
          {organize ? "Done organizing" : "Organize"}
        </button>
      </div>
      {body}
    </div>
  );
}
