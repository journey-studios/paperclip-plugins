import type { ProjectNode } from "../contracts.js";
import { flattenTree } from "../tree.js";

/**
 * Turns the core Projects list into a tree without touching core. Paperclip
 * offers no plugin slot on that page, so the app-shell overlay marks the
 * rows the core already rendered: a CSS `order` and a depth. It never moves,
 * adds or removes nodes React owns. If core markup changes, nothing matches
 * and the list simply stays flat.
 *
 * CSS `order` alone moves rows only visually; Tab and screen readers would
 * still follow the DOM. `reading-flow: flex-visual` makes both follow the
 * visual order, so the tree is shown only where the browser supports it.
 * Elsewhere the list stays flat and the Project tree page carries the tree.
 */

export const TREE_ATTR = "data-jph-tree";
const DEPTH_ATTR = "data-jph-depth";
const LAST_ATTR = "data-jph-last";
const STYLE_ID = "journeystudios-project-hierarchy-list-tree";
const MAX_INDENT_DEPTH = 8;

// The core Card's base classes include flex gap utilities that its "block"
// override keeps inert; switching to flex for `order` must zero the gap again.
export const LIST_TREE_CSS = `
[${TREE_ATTR}]{display:flex!important;flex-direction:column!important;gap:0!important;reading-flow:flex-visual}
[${TREE_ATTR}]>a[${DEPTH_ATTR}]{border-bottom-width:1px!important;border-bottom-style:solid!important}
[${TREE_ATTR}]>a[${LAST_ATTR}]{border-bottom-width:0!important}
[${TREE_ATTR}]>a[${DEPTH_ATTR}]:not([${DEPTH_ATTR}="0"])::before{content:"└";flex:none;box-sizing:border-box;width:calc(var(--jph-depth,1) * 20px);padding-right:2px;margin-right:-4px;text-align:right;color:var(--muted-foreground);font-size:12px;line-height:1}
`;

/** Whether focus and reading order can follow the visual tree order in this browser. */
export function supportsVisualReadingOrder(css: { supports?(property: string, value: string): boolean } | undefined): boolean {
  return Boolean(css?.supports?.("reading-flow", "flex-visual"));
}

/** True on the company's Projects list route, e.g. /JOU/projects. */
export function isProjectListPath(pathname: string, companyPrefix: string | null | undefined): boolean {
  const match = /^\/([^/]+)\/projects\/?$/.exec(pathname);
  if (!match) {
    return false;
  }
  return !companyPrefix || match[1]!.toLowerCase() === companyPrefix.toLowerCase();
}

/** The project reference (urlKey or id) a native list row links to, or null for any other link. */
export function projectRefOf(row: HTMLAnchorElement): string | null {
  const href = row.getAttribute("href");
  if (!href) {
    return null;
  }
  const path = href.split(/[?#]/)[0]!;
  const match = /^\/[^/]+\/projects\/([^/]+)\/?$/.exec(path);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1]!;
  }
}

function setAttr(element: Element, name: string, value: string | null): void {
  if (value === null) {
    if (element.hasAttribute(name)) {
      element.removeAttribute(name);
    }
  } else if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

function setStyle(element: HTMLElement, property: string, value: string | null): void {
  if (value === null) {
    element.style.removeProperty(property);
  } else if (element.style.getPropertyValue(property) !== value) {
    element.style.setProperty(property, value);
  }
}

function clear(container: HTMLElement): void {
  if (!container.hasAttribute(TREE_ATTR)) {
    return;
  }
  setAttr(container, TREE_ATTR, null);
  for (const row of Array.from(container.children)) {
    if (row instanceof HTMLElement && row.hasAttribute(DEPTH_ATTR)) {
      setAttr(row, DEPTH_ATTR, null);
      setAttr(row, LAST_ATTR, null);
      setStyle(row, "order", null);
      setStyle(row, "--jph-depth", null);
    }
  }
}

/**
 * Mark every native project list under `root` with tree order and depth.
 * Sibling order follows the DOM, so the list's own sort still applies within
 * each level. Returns how many lists now show a hierarchy.
 */
export function enhanceProjectLists(root: ParentNode, projects: readonly ProjectNode[]): number {
  const byRef = new Map<string, ProjectNode>();
  for (const project of projects) {
    byRef.set(project.id, project);
    if (project.urlKey) {
      byRef.set(project.urlKey, project);
    }
  }

  let enhanced = 0;
  for (const container of Array.from(root.querySelectorAll<HTMLElement>('[data-slot="card"]'))) {
    const children = Array.from(container.children);
    const rows = children.filter(
      (child): child is HTMLAnchorElement => child instanceof HTMLAnchorElement && projectRefOf(child) !== null,
    );
    // Only a card made purely of project rows is the list; leave every other card alone.
    if (rows.length === 0 || rows.length !== children.length) {
      clear(container);
      continue;
    }

    const rowById = new Map<string, HTMLAnchorElement>();
    const nodes = rows.map((row) => {
      const ref = projectRefOf(row)!;
      const project = byRef.get(ref);
      const id = project?.id ?? `unknown:${ref}`;
      rowById.set(id, row);
      return { id, parentId: project?.parentId ?? null };
    });
    const flat = flattenTree(nodes);
    if (!flat.some((entry) => entry.depth > 0)) {
      clear(container);
      continue;
    }

    setAttr(container, TREE_ATTR, "");
    flat.forEach((entry, index) => {
      const row = rowById.get(entry.node.id)!;
      setAttr(row, DEPTH_ATTR, String(entry.depth));
      setAttr(row, LAST_ATTR, index === flat.length - 1 ? "" : null);
      setStyle(row, "order", String(index));
      setStyle(row, "--jph-depth", String(Math.min(entry.depth, MAX_INDENT_DEPTH)));
    });
    enhanced += 1;
  }
  return enhanced;
}

/** Inject the stylesheet once per document. */
export function ensureListTreeStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = LIST_TREE_CSS;
  doc.head.appendChild(style);
}
