// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDetailTabProps, PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import type { DashboardRecord, DashboardSpec, DashboardSummary } from "../src/contracts.js";
import { normalizeSettings } from "../src/settings.js";
import { DashboardsPage, ProjectDashboardTab } from "../src/ui/index.js";
import { groupDashboards } from "../src/ui/model.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const host = vi.hoisted(() => ({
  search: "",
  data: new Map<string, unknown>(),
  actionCalls: [] as { key: string; params: Record<string, unknown> }[],
  actionFails: false,
  pickChoice: "p-new",
  refreshes: [] as string[],
  copied: [] as string[],
  dataCalls: [] as { key: string; params: Record<string, unknown> }[],
}));

vi.mock("@paperclipai/plugin-sdk/ui", async () => {
  const { useState, createElement: h } = await import("react");
  return {
    MarkdownBlock: ({ content }: { content: string }) => h("div", null, content),
    ProjectPicker: ({ placeholder, onChange }: { placeholder: string; onChange: (id: string) => void }) =>
      h("button", { type: "button", "data-picker": "", onClick: () => onChange(host.pickChoice) }, placeholder),
    copyTextToClipboard: async (text: string) => void host.copied.push(text),
    useHostLocation: () => ({ pathname: "/ACME/dashboards", search: host.search, hash: "" }),
    useHostNavigation: () => ({
      resolveHref: (to: string) => `/ACME${to}`,
      navigate: () => {},
      linkProps: (to: string) => ({ href: `/ACME${to}`, onClick: () => {} }),
    }),
    usePluginAction: (key: string) => async (params: Record<string, unknown>) => {
      host.actionCalls.push({ key, params });
      if (host.actionFails) {
        throw new Error("project_archived: no");
      }
      return { ok: true };
    },
    usePluginData: (key: string, params: Record<string, unknown>) => {
      const [, setTick] = useState(0);
      host.dataCalls.push({ key, params });
      return {
        data: host.data.get(key) ?? null,
        loading: false,
        error: null,
        refresh: () => {
          host.refreshes.push(key);
          setTick((n) => n + 1);
        },
      };
    },
  };
});

const NOW = new Date().toISOString();
const summary = (title: string, project: string | null, extra: Partial<DashboardSummary> = {}): DashboardSummary => ({
  id: `id-${title}`,
  slug: title.toLowerCase().replaceAll(" ", "-"),
  title,
  projectId: project ? `p-${project.toLowerCase()}` : null,
  projectName: project,
  projectUrlKey: project ? `${project.toLowerCase()}-key` : null,
  orphan: project === null,
  revision: 1,
  updatedAt: NOW,
  updatedBy: { kind: "system", id: null },
  ...extra,
});
const spec: DashboardSpec = {
  version: 1,
  title: "Board",
  datasets: {},
  sections: [{ id: "s", blocks: [{ type: "markdown", content: "hello" }] }],
};
const record = (project: string | null): DashboardRecord => ({
  ...summary("Board", project),
  companyId: COMPANY,
  createdAt: NOW,
  spec,
  specErrors: [],
});
const context = { companyId: COMPANY, companyPrefix: "ACME", projectId: null, entityId: null, entityType: null, userId: null };

let root: Root;
let container: HTMLDivElement;
const text = () => container.textContent ?? "";

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host.search = "";
  host.data = new Map<string, unknown>([["settings.get", normalizeSettings({ refreshIntervalSeconds: 0 })]]);
  host.actionCalls = [];
  host.actionFails = false;
  host.refreshes = [];
  host.copied = [];
  host.dataCalls = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("groupDashboards", () => {
  it("orders projects by name and titles within, with projectless dashboards apart", () => {
    const groups = groupDashboards(
      [summary("Zed", "Beta"), summary("alpha board", "Beta"), summary("Lost", null), summary("Only", "alpha"), summary("Another lost", null), summary("Item 10", "Gamma"), summary("Item 2", "Gamma")],
      "en-US",
    );
    expect(groups.projects.map((g) => g.name)).toEqual(["alpha", "Beta", "Gamma"]);
    expect(groups.projects[1]?.items.map((i) => i.title)).toEqual(["alpha board", "Zed"]);
    expect(groups.projects[2]?.items.map((i) => i.title)).toEqual(["Item 2", "Item 10"]);
    expect(groups.orphans.map((i) => i.title)).toEqual(["Another lost", "Lost"]);
    expect(groups.projects[0]).toMatchObject({ projectId: "p-alpha", urlKey: "alpha-key" });
  });
});

describe("dashboards page", () => {
  const props: PluginPageProps = { context };

  it("renders one section per project in name order with project links and counts", () => {
    host.data.set("dashboards.list", [summary("Two", "Zeta"), summary("One", "Alpha"), summary("Three", "Alpha")]);
    act(() => root.render(createElement(DashboardsPage, props)));
    const groups = [...container.querySelectorAll("section.jpd-group")];
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Alpha", "Zeta"]);
    const link = groups[0]!.querySelector("a.jpd-project-link");
    expect(link?.getAttribute("href")).toBe("/ACME/projects/alpha-key");
    expect(groups[0]!.querySelector(".jpd-group-count")?.textContent).toBe("2 dashboards");
    expect(groups[1]!.querySelector(".jpd-group-count")?.textContent).toBe("1 dashboard");
    expect([...groups[0]!.querySelectorAll(".jpd-item-title")].map((n) => n.textContent)).toEqual(["One", "Three"]);
    expect(container.querySelector(".jpd-orphans")).toBeNull();
    expect(container.querySelector(".jpd-divider")).toBeNull();
  });

  it("falls back to the project id when the url key is unknown", () => {
    host.data.set("dashboards.list", [summary("One", "Alpha", { projectUrlKey: null })]);
    act(() => root.render(createElement(DashboardsPage, props)));
    expect(container.querySelector("a.jpd-project-link")?.getAttribute("href")).toBe("/ACME/projects/p-alpha");
  });

  it("puts projectless dashboards in a collapsible area after a divider, last", () => {
    host.data.set("dashboards.list", [summary("Lost", null), summary("One", "Alpha")]);
    act(() => root.render(createElement(DashboardsPage, props)));
    const children = [...container.querySelector(".jpd-list")!.children];
    expect(children.map((c) => c.tagName)).toEqual(["SECTION", "HR", "DETAILS"]);
    const area = container.querySelector("details.jpd-orphans") as HTMLDetailsElement;
    expect(area.open).toBe(true);
    expect(area.querySelector("summary")?.textContent).toContain("No project");
    expect(area.querySelector("summary")?.textContent).toContain("1 dashboard");
    expect(area.textContent).toContain("Move each one to a project");
    expect(area.querySelector("[data-picker]")?.textContent).toBe("Move to project");
    expect(container.querySelector("section.jpd-group")?.textContent).not.toContain("Lost");
  });

  it("moves a projectless dashboard through the board action and refreshes the list", async () => {
    host.data.set("dashboards.list", [summary("Lost", null)]);
    act(() => root.render(createElement(DashboardsPage, props)));
    await act(async () => (container.querySelector("[data-picker]") as HTMLButtonElement).click());
    expect(host.actionCalls).toEqual([{ key: "dashboard.setProject", params: { companyId: COMPANY, id: "id-Lost", projectId: "p-new" } }]);
    expect(host.refreshes).toContain("dashboards.list");
  });

  it("shows move errors without refreshing", async () => {
    host.actionFails = true;
    host.data.set("dashboards.list", [summary("Lost", null)]);
    act(() => root.render(createElement(DashboardsPage, props)));
    await act(async () => (container.querySelector("[data-picker]") as HTMLButtonElement).click());
    expect(container.querySelector("[role='alert']")?.textContent).toBe("Could not move the dashboard: project_archived: no");
    expect(host.refreshes).not.toContain("dashboards.list");
  });

  it("localizes the area and controls", () => {
    host.data.set("settings.get", normalizeSettings({ refreshIntervalSeconds: 0, locale: "pt-BR" }));
    host.data.set("dashboards.list", [summary("Lost", null), summary("One", "Alpha")]);
    act(() => root.render(createElement(DashboardsPage, props)));
    expect(container.querySelector("summary")?.textContent).toContain("Sem projeto");
    expect(container.querySelector("[data-picker]")?.textContent).toBe("Mover para projeto");
    expect(text()).not.toContain("Da empresa");
  });
});

describe("viewer header", () => {
  it("links to the project", () => {
    host.search = "?d=board";
    host.data.set("dashboard.get", record("Alpha"));
    act(() => root.render(createElement(DashboardsPage, { context })));
    const line = container.querySelector(".jpd-project-line")!;
    expect(line.textContent).toContain("Project:");
    expect(line.querySelector("a")?.getAttribute("href")).toBe("/ACME/projects/alpha-key");
    expect(line.querySelector("a")?.textContent).toBe("Alpha");
    expect(container.querySelector(".jpd-orphan-warning")).toBeNull();
  });

  it("warns for projectless dashboards and offers the move control", async () => {
    host.search = "?d=board";
    host.data.set("dashboard.get", record(null));
    act(() => root.render(createElement(DashboardsPage, { context })));
    const warning = container.querySelector(".jpd-orphan-warning")!;
    expect(warning.textContent).toContain("belongs to no project");
    expect(container.querySelector(".jpd-project-line")).toBeNull();
    await act(async () => (warning.querySelector("[data-picker]") as HTMLButtonElement).click());
    expect(host.actionCalls[0]).toEqual({ key: "dashboard.setProject", params: { companyId: COMPANY, id: "id-Board", projectId: "p-new" } });
    expect(host.refreshes).toEqual(expect.arrayContaining(["dashboard.get", "dashboard.status"]));
  });
});

describe("project tab", () => {
  const tab = (entityId: string): PluginDetailTabProps => ({ context: { ...context, projectId: entityId, entityId, entityType: "project" } });

  it("asks the worker for this project's dashboards only", () => {
    host.data.set("dashboards.list", [summary("One", "Alpha")]);
    host.data.set("dashboard.get", record("Alpha"));
    act(() => root.render(createElement(ProjectDashboardTab, tab("p-alpha"))));
    expect(host.dataCalls.find((c) => c.key === "dashboards.list")?.params).toEqual({ companyId: COMPANY, projectId: "p-alpha" });
    expect(container.querySelector("select")).toBeNull();
  });

  it("offers a selector with several dashboards", () => {
    host.data.set("dashboards.list", [summary("One", "Alpha"), summary("Two", "Alpha")]);
    host.data.set("dashboard.get", record("Alpha"));
    act(() => root.render(createElement(ProjectDashboardTab, tab("p-alpha"))));
    expect([...container.querySelectorAll("select option")].map((o) => o.textContent)).toEqual(["One", "Two"]);
  });

  it("explains how dashboards are created and shows the copyable project id", async () => {
    host.data.set("dashboards.list", []);
    act(() => root.render(createElement(ProjectDashboardTab, tab("p-alpha"))));
    expect(text()).toContain("upsert_dashboard");
    expect(text()).toContain("paperclipUpsertDashboard");
    expect(container.querySelector("code.jpd-code")?.textContent).toBe("p-alpha");
    const copy = [...container.querySelectorAll("button")].find((b) => b.textContent === "Copy ID")!;
    await act(async () => copy.click());
    expect(host.copied).toEqual(["p-alpha"]);
    expect(text()).toContain("ID copied");
  });
});
