// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectHierarchy, ProjectNode, ProjectTree } from "../src/contracts.js";
import { ProjectListTree, ProjectTreePage, SubProjectsTab } from "../src/ui/index.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const host = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  actions: [] as { key: string; params: Record<string, unknown> }[],
  actionError: null as string | null,
  pickerChoice: "" as string,
  refreshes: [] as string[],
}));

vi.mock("@paperclipai/plugin-sdk/ui", async () => {
  const { createElement: h } = await import("react");
  return {
    useHostNavigation: () => ({
      resolveHref: (to: string) => `/ACME${to}`,
      navigate: () => {},
      linkProps: (to: string) => ({ href: `/ACME${to}`, onClick: () => {} }),
    }),
    usePluginData: (key: string) => ({
      data: host.data.get(key) ?? null,
      loading: false,
      error: null,
      refresh: () => void host.refreshes.push(key),
    }),
    usePluginAction: (key: string) => async (params: Record<string, unknown>) => {
      host.actions.push({ key, params });
      if (host.actionError) {
        // The real bridge rejects with a plain PluginBridgeError object, not an Error instance.
        throw { code: "WORKER_ERROR", message: host.actionError };
      }
      return {};
    },
    // A button stands in for the host picker: clicking it "selects" host.pickerChoice.
    ProjectPicker: ({ placeholder, value, onChange }: { placeholder?: string; value: string; onChange: (id: string) => void }) =>
      h("button", { type: "button", "data-picker": placeholder, "data-value": value, onClick: () => onChange(host.pickerChoice) }, placeholder),
  };
});

const node = (id: string, name: string, parentId: string | null = null, archived = false): ProjectNode => ({
  id,
  name,
  urlKey: name.toLowerCase().replaceAll(" ", "-"),
  status: "in_progress",
  color: null,
  archived,
  parentId,
});

const platform = node("p-platform", "Platform");
const api = node("p-api", "Platform API", "p-platform");
const billing = node("p-billing", "Billing", "p-api");
const growth = node("p-growth", "Growth");
const old = node("p-old", "Old Site", null, true);

let root: Root;
let container: HTMLDivElement;
const text = () => container.textContent ?? "";
const click = (element: Element | null | undefined) =>
  act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
const picker = (placeholder: string) => container.querySelector(`[data-picker="${placeholder}"]`);
const button = (label: string) => [...container.querySelectorAll("button")].find((element) => element.textContent === label);

async function render(element: ReturnType<typeof createElement>) {
  await act(async () => {
    root.render(element);
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host.data = new Map();
  host.actions = [];
  host.actionError = null;
  host.pickerChoice = "";
  host.refreshes = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const tabContext = { companyId: COMPANY, companyPrefix: "ACME", projectId: api.id, entityId: api.id, entityType: "project", userId: null };
const pageContext = { companyId: COMPANY, companyPrefix: "ACME", projectId: null, entityId: null, entityType: null, userId: null };

describe("SubProjectsTab", () => {
  beforeEach(() => {
    const hierarchy: ProjectHierarchy = {
      companyId: COMPANY,
      project: api,
      parent: platform,
      ancestors: [platform],
      children: [billing],
      descendantCount: 1,
    };
    host.data.set("project", hierarchy);
  });

  it("shows the path, the parent and the direct sub-projects with links", async () => {
    await render(createElement(SubProjectsTab, { context: tabContext } as never));
    expect(text()).toContain("Platform/Platform API");
    const links = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(links).toEqual(["/ACME/projects/platform", "/ACME/projects/billing"]);
    expect(picker("Choose a parent project")?.getAttribute("data-value")).toBe(platform.id);
  });

  it("changes the parent through the plugin action and refreshes", async () => {
    await render(createElement(SubProjectsTab, { context: tabContext } as never));
    host.pickerChoice = growth.id;
    await click(picker("Choose a parent project"));
    expect(host.actions).toEqual([{ key: "setParent", params: { companyId: COMPANY, projectId: api.id, parentProjectId: growth.id } }]);
    expect(host.refreshes).toEqual(["project"]);
  });

  it("detaches a sub-project and makes the project top-level", async () => {
    await render(createElement(SubProjectsTab, { context: tabContext } as never));
    await click(container.querySelector('[aria-label="Detach Billing"]'));
    await click(button("Make top-level"));
    expect(host.actions.map((call) => call.params)).toEqual([
      { companyId: COMPANY, projectId: billing.id, parentProjectId: null },
      { companyId: COMPANY, projectId: api.id, parentProjectId: null },
    ]);
  });

  it("adds an existing project as a sub-project", async () => {
    await render(createElement(SubProjectsTab, { context: tabContext } as never));
    host.pickerChoice = growth.id;
    await click(picker("Add an existing project…"));
    expect(host.actions[0]?.params).toEqual({ companyId: COMPANY, projectId: growth.id, parentProjectId: api.id });
  });

  it("shows the server's rejection instead of failing silently", async () => {
    host.actionError = '"Billing" is a sub-project of "Platform API"; moving it there would create a cycle';
    await render(createElement(SubProjectsTab, { context: tabContext } as never));
    host.pickerChoice = billing.id;
    await click(picker("Choose a parent project"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("would create a cycle");
  });

  it("creates a sub-project through the core API, then links it", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "p-new" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await render(createElement(SubProjectsTab, { context: tabContext } as never));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="New sub-project name"]')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, "Invoices");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/companies/${COMPANY}/projects`,
      expect.objectContaining({ method: "POST", credentials: "include", body: JSON.stringify({ name: "Invoices", status: "planned" }) }),
    );
    expect(host.actions).toEqual([{ key: "setParent", params: { companyId: COMPANY, projectId: "p-new", parentProjectId: api.id } }]);
  });
});

describe("ProjectTreePage", () => {
  beforeEach(() => {
    const tree: ProjectTree = { companyId: COMPANY, projects: [billing, growth, old, platform, api] };
    host.data.set("tree", tree);
  });

  it("renders the hierarchy with depth and hides archived projects by default", async () => {
    await render(createElement(ProjectTreePage, { context: pageContext } as never));
    const items = [...container.querySelectorAll('[role="treeitem"]')].map(
      (item) => `${item.getAttribute("aria-level")}:${item.querySelector("a")?.textContent}`,
    );
    expect(items).toEqual(["1:Growth", "1:Platform", "2:Platform API", "3:Billing"]);
    expect(text()).not.toContain("Old Site");
  });

  it("collapses a branch", async () => {
    await render(createElement(ProjectTreePage, { context: pageContext } as never));
    await click(container.querySelector('[aria-label="Collapse Platform"]'));
    expect(text()).not.toContain("Platform API");
    expect(container.querySelector('[aria-label="Expand Platform"]')).not.toBeNull();
  });

  it("moves a project from organize mode", async () => {
    await render(createElement(ProjectTreePage, { context: pageContext } as never));
    await click(button("Organize"));
    host.pickerChoice = "";
    const parentPickers = container.querySelectorAll('[data-picker="Parent"]');
    expect(parentPickers).toHaveLength(4);
    await click(parentPickers[2]);
    expect(host.actions[0]?.params).toEqual({ companyId: COMPANY, projectId: api.id, parentProjectId: null });
  });
});

describe("ProjectListTree", () => {
  /** The core Projects list: a card made only of project row links. */
  function renderCoreList(urlKeys: string[]): HTMLElement {
    const card = document.createElement("div");
    card.setAttribute("data-slot", "card");
    for (const key of urlKeys) {
      const row = document.createElement("a");
      row.setAttribute("href", `/ACME/projects/${key}`);
      row.textContent = key;
      card.appendChild(row);
    }
    document.body.appendChild(card);
    return card;
  }

  const flushFrames = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  beforeEach(() => {
    host.data.set("tree", { companyId: COMPANY, projects: [platform, api, billing, growth] });
    window.history.pushState({}, "", "/ACME/projects");
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
  });

  afterEach(() => {
    window.history.pushState({}, "", "/");
    document.querySelectorAll('[data-slot="card"]').forEach((card) => card.remove());
  });

  it("keeps the core list flat where focus order cannot follow the visual order", async () => {
    vi.stubGlobal("CSS", { supports: () => false });
    const card = renderCoreList(["billing", "growth", "platform", "platform-api"]);
    await render(createElement(ProjectListTree, { context: pageContext } as never));
    await flushFrames();
    expect(card.hasAttribute("data-jph-tree")).toBe(false);
    expect(host.refreshes).toEqual([]);
  });

  it("nests the core list where reading-flow is supported and refreshes once per visit", async () => {
    vi.stubGlobal("CSS", { supports: (property: string, value: string) => property === "reading-flow" && value === "flex-visual" });
    const card = renderCoreList(["billing", "growth", "platform", "platform-api"]);
    await render(createElement(ProjectListTree, { context: pageContext } as never));
    await flushFrames();
    expect(card.hasAttribute("data-jph-tree")).toBe(true);
    const order = (Array.from(card.children) as HTMLElement[])
      .sort((a, b) => Number(a.style.order) - Number(b.style.order))
      .map((row) => `${row.getAttribute("data-jph-depth")}:${row.textContent}`);
    expect(order).toEqual(["0:growth", "0:platform", "1:platform-api", "2:billing"]);
    expect(host.refreshes).toEqual(["tree"]);

    // Further DOM churn on the same page must not refetch.
    document.body.appendChild(document.createElement("span"));
    await flushFrames();
    expect(host.refreshes).toEqual(["tree"]);
  });
});
