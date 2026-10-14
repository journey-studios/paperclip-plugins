// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectNode } from "../src/contracts.js";
import { TREE_ATTR, enhanceProjectLists, ensureListTreeStyle, isProjectListPath, projectRefOf } from "../src/ui/list-tree.js";

const node = (id: string, name: string, parentId: string | null = null): ProjectNode => ({
  id,
  name,
  urlKey: name.toLowerCase().replaceAll(" ", "-"),
  status: "in_progress",
  color: null,
  archived: false,
  parentId,
});

const tessel = node("p-tessel", "Tessel");
const growth = node("p-growth", "Tessel Growth", "p-tessel");
const product = node("p-product", "Tessel Product", "p-tessel");
const palantir = node("p-palantir", "Palantir", "p-product");
const indie = node("p-indie", "Indie Brazil");
const projects = [tessel, growth, product, palantir, indie];

/** The core Projects list markup: a card whose children are only EntityRow links. */
function renderList(urlKeys: string[]): HTMLElement {
  const card = document.createElement("div");
  card.setAttribute("data-slot", "card");
  card.className = "block py-0 overflow-hidden divide-y divide-border";
  for (const key of urlKeys) {
    const row = document.createElement("a");
    row.setAttribute("href", `/JOU/projects/${key}`);
    row.className = "flex items-center gap-3 border-b last:border-b-0";
    row.textContent = key;
    card.appendChild(row);
  }
  document.body.appendChild(card);
  return card;
}

/** Rows as the CSS order shows them: "depth:urlKey". */
function visual(card: HTMLElement): string[] {
  return Array.from(card.children)
    .map((row) => row as HTMLElement)
    .sort((a, b) => Number(a.style.order) - Number(b.style.order))
    .map((row) => `${row.getAttribute("data-jph-depth")}:${row.textContent}`);
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("enhanceProjectLists", () => {
  it("orders sub-projects under their parent and records depth, keeping the DOM untouched", () => {
    const card = renderList(["indie-brazil", "palantir", "tessel", "tessel-growth", "tessel-product"]);
    const before = Array.from(card.children);

    expect(enhanceProjectLists(document, projects)).toBe(1);

    expect(card.hasAttribute(TREE_ATTR)).toBe(true);
    expect(visual(card)).toEqual(["0:indie-brazil", "0:tessel", "1:tessel-growth", "1:tessel-product", "2:palantir"]);
    expect(Array.from(card.children)).toEqual(before);
    expect(card.querySelectorAll("[data-jph-last]")).toHaveLength(1);
    expect(card.querySelector("[data-jph-last]")?.textContent).toBe("palantir");
  });

  it("keeps the list's own sort order among siblings", () => {
    const card = renderList(["tessel", "tessel-product", "tessel-growth"]);
    enhanceProjectLists(document, projects);
    expect(visual(card)).toEqual(["0:tessel", "1:tessel-product", "1:tessel-growth"]);
  });

  it("leaves a list without any sub-project untouched", () => {
    const card = renderList(["indie-brazil", "tessel"]);
    expect(enhanceProjectLists(document, projects)).toBe(0);
    expect(card.hasAttribute(TREE_ATTR)).toBe(false);
    expect((card.children[0] as HTMLElement).style.order).toBe("");
  });

  it("shows a sub-project as a root when its parent is in another section", () => {
    const mine = renderList(["tessel-growth", "indie-brazil"]);
    const other = renderList(["tessel"]);
    expect(enhanceProjectLists(document, projects)).toBe(0);
    expect(mine.hasAttribute(TREE_ATTR)).toBe(false);
    expect(other.hasAttribute(TREE_ATTR)).toBe(false);
  });

  it("never touches cards that are not pure project lists", () => {
    const card = renderList(["tessel", "tessel-growth"]);
    card.appendChild(document.createElement("button"));
    expect(enhanceProjectLists(document, projects)).toBe(0);
    expect(card.hasAttribute(TREE_ATTR)).toBe(false);
  });

  it("matches rows by id when the core links a project by id", () => {
    const card = renderList(["tessel", "p-growth"]);
    enhanceProjectLists(document, projects);
    expect(visual(card)).toEqual(["0:tessel", "1:p-growth"]);
  });

  it("clears its marks when the hierarchy goes away", () => {
    const card = renderList(["tessel", "tessel-growth"]);
    enhanceProjectLists(document, projects);
    enhanceProjectLists(document, [tessel, { ...growth, parentId: null }]);
    expect(card.hasAttribute(TREE_ATTR)).toBe(false);
    for (const row of Array.from(card.children) as HTMLElement[]) {
      expect(row.hasAttribute("data-jph-depth")).toBe(false);
      expect(row.style.order).toBe("");
    }
  });

  it("is idempotent", () => {
    const card = renderList(["tessel", "tessel-growth"]);
    enhanceProjectLists(document, projects);
    const snapshot = card.outerHTML;
    enhanceProjectLists(document, projects);
    expect(card.outerHTML).toBe(snapshot);
  });
});

describe("helpers", () => {
  it("recognizes only the company's Projects list route", () => {
    expect(isProjectListPath("/JOU/projects", "JOU")).toBe(true);
    expect(isProjectListPath("/jou/projects/", "JOU")).toBe(true);
    expect(isProjectListPath("/JOU/projects/tessel", "JOU")).toBe(false);
    expect(isProjectListPath("/ACME/projects", "JOU")).toBe(false);
  });

  it("reads project references only from project row links", () => {
    const link = (href: string) => Object.assign(document.createElement("a"), { href }) as HTMLAnchorElement;
    const row = document.createElement("a");
    row.setAttribute("href", "/JOU/projects/palantir-v2-ui-gerativa-df0e70e2");
    expect(projectRefOf(row)).toBe("palantir-v2-ui-gerativa-df0e70e2");
    const issues = document.createElement("a");
    issues.setAttribute("href", "/JOU/projects/tessel/issues");
    expect(projectRefOf(issues)).toBeNull();
    expect(projectRefOf(link(""))).toBeNull();
  });

  it("injects the stylesheet once", () => {
    ensureListTreeStyle(document);
    ensureListTreeStyle(document);
    expect(document.head.querySelectorAll("style")).toHaveLength(1);
  });
});
