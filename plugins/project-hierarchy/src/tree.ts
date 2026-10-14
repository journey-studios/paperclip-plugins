/**
 * Pure hierarchy helpers shared by the worker and the UI bundle. Every walk is
 * cycle-guarded: the worker rejects cycles, but a stale or concurrent write
 * must never hang a renderer or a request.
 */

type TreeNode = { id: string; parentId: string | null };

/** Ancestors from the top-level project down to the direct parent. */
export function ancestorIds(projectId: string, parentOf: ReadonlyMap<string, string>): string[] {
  const ancestors: string[] = [];
  const seen = new Set([projectId]);
  let cursor = parentOf.get(projectId);
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    ancestors.unshift(cursor);
    cursor = parentOf.get(cursor);
  }
  return ancestors;
}

/** Would placing `projectId` under `parentId` close a loop? */
export function wouldCycle(projectId: string, parentId: string, parentOf: ReadonlyMap<string, string>): boolean {
  return parentId === projectId || ancestorIds(parentId, parentOf).includes(projectId);
}

/** Ids of every node below `projectId`, at any depth. */
export function descendantIds(projectId: string, nodes: readonly TreeNode[]): Set<string> {
  const childrenOf = groupChildren(nodes);
  const found = new Set<string>();
  const pending = [...(childrenOf.get(projectId) ?? [])];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (next.id === projectId || found.has(next.id)) {
      continue;
    }
    found.add(next.id);
    pending.push(...(childrenOf.get(next.id) ?? []));
  }
  return found;
}

export interface TreeRow<T extends TreeNode> {
  node: T;
  depth: number;
  childCount: number;
}

/**
 * Depth-annotated rows: each parent is followed by its sub-projects. Sibling
 * order follows the input order. A node whose parent is not in the input is a
 * root, so filtered views (archived hidden, search) never drop rows.
 */
export function flattenTree<T extends TreeNode>(nodes: readonly T[], collapsed: ReadonlySet<string> = new Set()): TreeRow<T>[] {
  const ids = new Set(nodes.map((node) => node.id));
  const childrenOf = groupChildren(nodes, ids);
  const roots = nodes.filter((node) => !node.parentId || node.parentId === node.id || !ids.has(node.parentId));

  // Members of a stored cycle have no root; promote one per cycle. Reachability
  // ignores collapse, so rows hidden under a collapsed parent stay hidden.
  const reachable = new Set<string>();
  const mark = (node: T) => {
    if (reachable.has(node.id)) {
      return;
    }
    reachable.add(node.id);
    for (const child of childrenOf.get(node.id) ?? []) {
      mark(child);
    }
  };
  roots.forEach(mark);
  for (const node of nodes) {
    if (!reachable.has(node.id)) {
      roots.push(node);
      mark(node);
    }
  }

  const rows: TreeRow<T>[] = [];
  const visited = new Set<string>();
  const visit = (node: T, depth: number) => {
    if (visited.has(node.id)) {
      return;
    }
    visited.add(node.id);
    const children = childrenOf.get(node.id) ?? [];
    rows.push({ node, depth, childCount: children.length });
    if (collapsed.has(node.id)) {
      return;
    }
    for (const child of children) {
      visit(child, depth + 1);
    }
  };
  roots.forEach((root) => visit(root, 0));
  return rows;
}

function groupChildren<T extends TreeNode>(nodes: readonly T[], ids?: ReadonlySet<string>): Map<string, T[]> {
  const childrenOf = new Map<string, T[]>();
  for (const node of nodes) {
    if (!node.parentId || node.parentId === node.id || (ids && !ids.has(node.parentId))) {
      continue;
    }
    childrenOf.set(node.parentId, [...(childrenOf.get(node.parentId) ?? []), node]);
  }
  return childrenOf;
}
