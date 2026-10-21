/** Who changed a link; recorded so the audit trail survives plugin upgrades. */
export interface Actor {
  kind: "agent" | "user" | "system";
  id: string | null;
}

/** A project as the hierarchy views show it. */
export interface ProjectNode {
  id: string;
  name: string;
  urlKey: string | null;
  status: string | null;
  color: string | null;
  archived: boolean;
  /** Parent within the same company; null for top-level projects. */
  parentId: string | null;
}

/** Every project of a company with its resolved parent, in name order. */
export interface ProjectTree {
  companyId: string;
  projects: ProjectNode[];
}

/** One project with its position in the hierarchy. */
export interface ProjectHierarchy {
  companyId: string;
  project: ProjectNode;
  parent: ProjectNode | null;
  /** From the top-level project down to the direct parent. */
  ancestors: ProjectNode[];
  /** Direct sub-projects, in name order. */
  children: ProjectNode[];
  /** Sub-projects at any depth. */
  descendantCount: number;
}
