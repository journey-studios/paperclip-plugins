// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDetailTabProps, PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import type { ChangelogEntry, ChangelogImportResult, ChangelogKind, ChangelogPage, DashboardSummary } from "../src/contracts.js";
import { normalizeSettings } from "../src/settings.js";
import { DashboardsPage, ProjectChangelogTab } from "../src/ui/index.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const host = vi.hoisted(() => ({
  search: "",
  data: new Map<string, unknown>(),
  actions: new Map<string, ReturnType<typeof vi.fn>>(),
  calls: [] as { key: string; params: Record<string, unknown> }[],
  refreshes: [] as string[],
}));

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  MarkdownBlock: ({ content }: { content: string }) => (globalThis as { __md?: (c: string) => unknown }).__md?.(content),
  useHostLocation: () => ({ pathname: "/ACME/dashboards", search: host.search, hash: "" }),
  useHostNavigation: () => ({
    resolveHref: (to: string) => `/ACME${to}`,
    navigate: vi.fn(),
    linkProps: (to: string) => ({ href: `/ACME${to}`, onClick: vi.fn() }),
  }),
  usePluginAction: (key: string) => {
    if (!host.actions.has(key)) {
      host.actions.set(key, vi.fn().mockResolvedValue({ ok: true }));
    }
    return host.actions.get(key);
  },
  usePluginData: (key: string, params: Record<string, unknown>) => {
    host.calls.push({ key, params });
    const value = host.data.get(key);
    return {
      data: typeof value === "function" ? value(params) : (value ?? null),
      loading: false,
      error: null,
      refresh: () => void host.refreshes.push(key),
    };
  },
}));

const entry = (overrides: Partial<ChangelogEntry> = {}): ChangelogEntry => ({
  id: `e-${Math.random().toString(36).slice(2)}`,
  projectId: PROJECT,
  projectName: "Acme Web App",
  kind: "feature",
  title: "Entry",
  body: null,
  version: null,
  refs: [],
  links: [],
  occurredAt: "2026-10-15T12:00:00.000Z",
  issueId: null,
  createdBy: { kind: "agent", id: "a", name: "Tracker" },
  updatedBy: { kind: "agent", id: "a", name: "Tracker" },
  createdAt: "2026-10-15T12:00:00.000Z",
  updatedAt: "2026-10-15T12:00:00.000Z",
  ...overrides,
});
const pageOf = (entries: ChangelogEntry[], nextCursor: string | null = null): ChangelogPage => ({ entries, nextCursor });

const baseContext = { companyId: COMPANY, companyPrefix: "ACME", projectId: PROJECT, entityId: PROJECT, entityType: "project", userId: null };
const tabProps: PluginDetailTabProps = { context: baseContext };
const pageProps: PluginPageProps = { context: { ...baseContext, projectId: null, entityId: null, entityType: null } };

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  host.search = "";
  host.data = new Map();
  host.actions = new Map();
  host.calls = [];
  host.refreshes = [];
  Object.assign(globalThis, { __md: (content: string) => createElement("div", { "data-md": "" }, content), IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  window.confirm = () => true;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const render = (node: Parameters<Root["render"]>[0]) => act(() => root.render(node));
const text = () => container.textContent ?? "";
const lastList = () => host.calls.filter((call) => call.key === "changelog.list").at(-1)?.params;
const button = (label: string | RegExp) =>
  [...container.querySelectorAll("button")].find((node) => (typeof label === "string" ? node.textContent === label : label.test(node.textContent ?? "")))!;
const click = (node: Element) => act(() => (node as HTMLElement).click());
const titles = () => [...container.querySelectorAll(".jpd-cl-title")].map((node) => node.textContent);

describe("timeline in the project tab", () => {
  const mixed = () => [
    entry({ id: "e1", kind: "release", title: "Checkout v2", version: "v2.0.0", body: "Faster **payments**", refs: ["ACME-12", "abc1234", "PR 7"], links: [{ label: "Pull request", url: "https://example.com/pr/7" }, { label: "Sneaky", url: "javascript:alert(1)" }], occurredAt: "2026-10-15T12:00:00.000Z" }),
    entry({ id: "e2", kind: "issue", title: "Fix the cart", body: "must not show", refs: ["ACME-9"], issueId: "i9", createdBy: { kind: "system", id: null, name: null }, occurredAt: "2026-10-02T12:00:00.000Z" }),
    entry({ id: "e3", kind: "incident", title: "Payments outage", occurredAt: "2026-09-20T12:00:00.000Z" }),
  ];

  it("groups entries by month and renders date, kind, title, version, body, refs, links and author", () => {
    host.data.set("changelog.list", pageOf(mixed()));
    render(createElement(ProjectChangelogTab, tabProps));
    expect(container.querySelector("h2.jpd-h2")?.textContent).toBe("Changelog");
    expect([...container.querySelectorAll(".jpd-cl-month-title")].map((node) => node.textContent)).toEqual(["October 2026", "September 2026"]);
    expect(titles()).toEqual(["Checkout v2", "Fix the cart", "Payments outage"]);
    const first = container.querySelector(".jpd-cl-entry")!;
    expect(first.querySelector(".jpd-cl-kind")?.textContent).toBe("Release");
    expect(first.querySelector(".jpd-cl-kind")?.className).toContain("jpd-tone-ok");
    expect(first.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-15T12:00:00.000Z");
    expect(first.querySelector("code.jpd-code")?.textContent).toBe("v2.0.0");
    expect(first.querySelector("[data-md]")?.textContent).toBe("Faster **payments**");
    expect(first.querySelector(".jpd-cl-foot")?.textContent).toContain("by agent Tracker");
    // The project is implied by the tab.
    expect(first.querySelector(".jpd-cl-project")).toBeNull();
  });

  it("turns issue identifiers into host links and shows other refs as code", () => {
    host.data.set("changelog.list", pageOf(mixed()));
    render(createElement(ProjectChangelogTab, tabProps));
    const refs = [...container.querySelectorAll(".jpd-cl-entry")][0]!.querySelectorAll(".jpd-cl-refs > *");
    expect([...refs].map((node) => [node.tagName, node.textContent])).toEqual([
      ["A", "ACME-12"],
      ["CODE", "abc1234"],
      ["CODE", "PR 7"],
      ["A", "Pull request"],
      ["SPAN", "Sneaky"],
    ]);
    expect(refs[0]?.getAttribute("href")).toBe("/ACME/issues/ACME-12");
    expect(refs[3]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(refs[3]?.getAttribute("target")).toBe("_blank");
    expect(container.querySelector("a[href^='javascript']")).toBeNull();
  });

  it("shows entries generated from issues compactly: no body, no author", () => {
    host.data.set("changelog.list", pageOf(mixed()));
    render(createElement(ProjectChangelogTab, tabProps));
    const generated = [...container.querySelectorAll(".jpd-cl-entry")][1]!;
    expect(generated.className).toContain("jpd-cl-compact");
    expect(generated.querySelector("[data-md]")).toBeNull();
    expect(generated.textContent).not.toContain("must not show");
    expect(generated.querySelector(".jpd-cl-kind")?.textContent).toBe("Issue");
    expect(generated.querySelector(".jpd-cl-kind")?.className).toContain("jpd-tone-muted");
    expect(generated.querySelector(".jpd-cl-foot")?.textContent).not.toContain("by ");
    expect(generated.querySelector(".jpd-cl-refs a")?.getAttribute("href")).toBe("/ACME/issues/ACME-9");
  });

  it("colors every kind by its tone", () => {
    const kinds: ChangelogKind[] = ["release", "feature", "milestone", "improvement", "decision", "fix", "incident", "note", "issue"];
    host.data.set("changelog.list", pageOf(kinds.map((kind, index) => entry({ id: `k${index}`, kind, issueId: kind === "issue" ? "i" : null, title: kind }))));
    render(createElement(ProjectChangelogTab, tabProps));
    const tones = Object.fromEntries([...container.querySelectorAll(".jpd-cl-entry")].map((node) => [node.querySelector(".jpd-cl-title")?.textContent, node.querySelector(".jpd-cl-kind")?.className.match(/jpd-tone-(\w+)/)?.[1]]));
    expect(tones).toEqual({ release: "ok", feature: "ok", milestone: "info", improvement: "info", decision: "info", fix: "warn", incident: "bad", note: "muted", issue: "muted" });
  });

  it("queries the project's changelog with a page size of 50 and issues included", () => {
    render(createElement(ProjectChangelogTab, tabProps));
    expect(lastList()).toEqual({ companyId: COMPANY, projectId: PROJECT, includeIssues: true, limit: 50 });
  });
});

describe("filters", () => {
  const data = () => pageOf([entry({ id: "a", kind: "fix", title: "A" }), entry({ id: "b", kind: "release", title: "B" }), entry({ id: "c", kind: "issue", issueId: "i", title: "C" })]);

  it("offers a chip per kind present and sends the selected kinds to the worker", () => {
    host.data.set("changelog.list", data());
    render(createElement(ProjectChangelogTab, tabProps));
    const group = container.querySelector("[role='group']")!;
    expect([...group.querySelectorAll("button")].map((node) => node.textContent)).toEqual(["All", "Release", "Fix", "Issue"]);
    expect(group.querySelector("button")?.getAttribute("aria-pressed")).toBe("true");
    click(button("Fix"));
    expect(lastList()).toMatchObject({ kinds: ["fix"] });
    expect(button("Fix").getAttribute("aria-pressed")).toBe("true");
    click(button("Release"));
    expect(lastList()).toMatchObject({ kinds: ["fix", "release"] });
    click(button("Fix"));
    expect(lastList()).toMatchObject({ kinds: ["release"] });
    click(button("All"));
    expect(lastList()).not.toHaveProperty("kinds");
  });

  it("keeps showing the other chips after the list narrows to one kind", () => {
    host.data.set("changelog.list", (params: Record<string, unknown>) => {
      const kinds = params.kinds as string[] | undefined;
      return pageOf(data().entries.filter((item) => !kinds || kinds.includes(item.kind)));
    });
    render(createElement(ProjectChangelogTab, tabProps));
    click(button("Fix"));
    expect(titles()).toEqual(["A"]);
    expect([...container.querySelectorAll("[role='group'] button")].map((node) => node.textContent)).toEqual(["All", "Release", "Fix", "Issue"]);
  });

  it("maps the issues toggle to includeIssues and hides the issue chip and selection", () => {
    host.data.set("changelog.list", data());
    render(createElement(ProjectChangelogTab, tabProps));
    click(button("Issue"));
    expect(lastList()).toMatchObject({ includeIssues: true, kinds: ["issue"] });
    const toggle = container.querySelector<HTMLInputElement>("input[type='checkbox']")!;
    expect(toggle.checked).toBe(true);
    expect(container.querySelector(`label[for='${toggle.id}']`)?.textContent).toBe("Include completed issues");
    click(toggle);
    expect(toggle.checked).toBe(false);
    expect(lastList()).toMatchObject({ includeIssues: false });
    expect(lastList()).not.toHaveProperty("kinds");
    expect([...container.querySelectorAll("[role='group'] button")].map((node) => node.textContent)).not.toContain("Issue");
  });

  it("explains an empty filtered result differently from an empty changelog", () => {
    host.data.set("changelog.list", pageOf([]));
    render(createElement(ProjectChangelogTab, tabProps));
    expect(text()).toContain("No changelog entries yet");
    click(container.querySelector("input[type='checkbox']")!);
    expect(text()).toContain("No entries match these filters.");
  });
});

describe("show more", () => {
  it("raises the page size by 50 up to 500 while another page exists", () => {
    host.data.set("changelog.list", pageOf([entry({ id: "a" })], "cursor"));
    render(createElement(ProjectChangelogTab, tabProps));
    for (const expected of [100, 150, 200, 250, 300, 350, 400, 450, 500]) {
      click(button("Show more"));
      expect(lastList()).toMatchObject({ limit: expected });
    }
    expect(button("Show more")).toBeUndefined();
  });

  it("is hidden when the list ends", () => {
    host.data.set("changelog.list", pageOf([entry({ id: "a" })], null));
    render(createElement(ProjectChangelogTab, tabProps));
    expect(button("Show more")).toBeUndefined();
  });
});

describe("actions", () => {
  it("imports completed issues for the project and reports the result", async () => {
    host.data.set("changelog.list", pageOf([]));
    render(createElement(ProjectChangelogTab, tabProps));
    const result: ChangelogImportResult = { scanned: 5, imported: 3, skipped: 2, truncated: false };
    host.actions.set("changelog.importIssues", vi.fn().mockResolvedValue(result));
    render(createElement(ProjectChangelogTab, tabProps));
    await act(async () => button("Import completed issues").click());
    expect(host.actions.get("changelog.importIssues")).toHaveBeenCalledWith({ companyId: COMPANY, projectId: PROJECT });
    expect(container.querySelector("[role='status']")?.textContent).toBe("Imported 3 of 5 completed issues.");
    expect(host.refreshes).toContain("changelog.list");
  });

  it("warns when the import was truncated and shows failures", async () => {
    render(createElement(ProjectChangelogTab, tabProps));
    host.actions.set("changelog.importIssues", vi.fn().mockResolvedValue({ scanned: 1000, imported: 10, skipped: 990, truncated: true }));
    render(createElement(ProjectChangelogTab, tabProps));
    await act(async () => button("Import completed issues").click());
    expect(container.querySelector("[role='status']")?.textContent).toContain("Only the first 1000 completed issues were scanned");
    host.actions.set("changelog.importIssues", vi.fn().mockRejectedValue(new Error("Project not found in this company")));
    render(createElement(ProjectChangelogTab, tabProps));
    await act(async () => button("Import completed issues").click());
    expect(text()).toContain("Action failed: Project not found in this company");
  });

  it("deletes an entry only after confirmation and refreshes the list", async () => {
    host.data.set("changelog.list", pageOf([entry({ id: "gone", title: "Remove me" })]));
    render(createElement(ProjectChangelogTab, tabProps));
    const remove = container.querySelector<HTMLButtonElement>("button[aria-label='Delete entry: Remove me']")!;
    window.confirm = () => false;
    await act(async () => remove.click());
    expect(host.actions.get("changelog.delete")).not.toHaveBeenCalled();
    window.confirm = () => true;
    await act(async () => remove.click());
    expect(host.actions.get("changelog.delete")).toHaveBeenCalledWith({ companyId: COMPANY, id: "gone" });
    expect(host.refreshes).toContain("changelog.list");
  });

  it("shows a deletion failure", async () => {
    host.data.set("changelog.list", pageOf([entry({ id: "x" })]));
    render(createElement(ProjectChangelogTab, tabProps));
    host.actions.set("changelog.delete", vi.fn().mockRejectedValue({ code: "WORKER_ERROR", message: "Changelog entry not found" }));
    render(createElement(ProjectChangelogTab, tabProps));
    await act(async () => container.querySelector<HTMLButtonElement>("button.jpd-btn-danger")!.click());
    expect(text()).toContain("Action failed: Changelog entry not found");
  });
});

describe("states and settings", () => {
  it("explains how entries appear when there are none", () => {
    render(createElement(ProjectChangelogTab, tabProps));
    expect(text()).toContain("No changelog entries yet");
    expect(text()).toContain("add_changelog_entry");
    expect(text()).toContain("Completed issues are added automatically");
  });

  it("uses the configured tab label and polls on the configured interval", () => {
    vi.useFakeTimers();
    host.data.set("settings.get", normalizeSettings({ changelogTabLabel: "Evolution", refreshIntervalSeconds: 10 }));
    host.data.set("changelog.list", pageOf([entry()]));
    render(createElement(ProjectChangelogTab, tabProps));
    expect(container.querySelector("h2.jpd-h2")?.textContent).toBe("Evolution");
    expect(host.refreshes.filter((key) => key === "changelog.list")).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(host.refreshes.filter((key) => key === "changelog.list")).toHaveLength(3);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });

  it("does not poll when automatic refresh is off", () => {
    vi.useFakeTimers();
    host.data.set("settings.get", normalizeSettings({ refreshIntervalSeconds: 0 }));
    render(createElement(ProjectChangelogTab, tabProps));
    act(() => {
      vi.advanceTimersByTime(3_600_000);
    });
    expect(host.refreshes).toEqual([]);
  });

  it("speaks Portuguese when the locale says so", () => {
    host.data.set("settings.get", normalizeSettings({ locale: "pt-BR", changelogTabLabel: "Evolução" }));
    host.data.set("changelog.list", pageOf([entry({ kind: "fix", title: "Corrigido", body: "x", occurredAt: "2026-10-15T12:00:00.000Z" })], "more"));
    render(createElement(ProjectChangelogTab, tabProps));
    expect(container.querySelector("h2.jpd-h2")?.textContent).toBe("Evolução");
    expect(container.querySelector(".jpd-cl-month-title")?.textContent).toBe("outubro de 2026");
    expect(container.querySelector(".jpd-cl-kind")?.textContent).toBe("Correção");
    expect(container.querySelector(".jpd-cl-foot")?.textContent).toContain("por o agente Tracker");
    expect(text()).toContain("Incluir issues concluídas");
    expect(text()).toContain("Importar issues concluídas");
    expect(text()).toContain("Mostrar mais");
    expect(container.querySelector("button[aria-label='Excluir entrada: Corrigido']")).not.toBeNull();
  });

  it("scopes its styles under .jpd- classes and a labelled filter group", () => {
    host.data.set("changelog.list", pageOf([entry({ kind: "note" })]));
    render(createElement(ProjectChangelogTab, tabProps));
    expect(container.querySelector("style")?.textContent).toContain(".jpd-cl-entry");
    expect(container.querySelector("[role='group']")?.getAttribute("aria-label")).toBe("Entry types");
    expect(container.querySelector("ol.jpd-cl-list")).not.toBeNull();
  });
});

describe("dashboards page with the changelog view", () => {
  const summary: DashboardSummary = { id: "d1", slug: "alpha", title: "Alpha", projectId: PROJECT, projectName: "Acme Web App", projectUrlKey: "acme-web-app", orphan: false, revision: 1, updatedAt: new Date().toISOString(), updatedBy: { kind: "system", id: null } };

  it("shows Dashboards | Changelog tabs and keeps the dashboard list as the default view", () => {
    host.data.set("dashboards.list", [summary]);
    render(createElement(DashboardsPage, pageProps));
    const tabs = [...container.querySelectorAll("nav.jpd-tabs a")];
    expect(tabs.map((node) => [node.textContent, node.getAttribute("href"), node.getAttribute("aria-current")])).toEqual([
      ["Dashboards", "/ACME/dashboards", "page"],
      ["Changelog", "/ACME/dashboards?view=changelog", null],
    ]);
    expect(container.querySelector("a.jpd-item")?.getAttribute("href")).toBe("/ACME/dashboards?d=alpha");
    expect(container.querySelector(".jpd-cl-wrap")).toBeNull();
  });

  it("switches to the company timeline with ?view=changelog", () => {
    host.search = "?view=changelog";
    host.data.set("projects.list", [{ id: PROJECT, name: "Acme Web App" }, { id: SECOND, name: "Internal Tools" }]);
    host.data.set("changelog.list", pageOf([entry({ id: "p1", title: "In Acme" }), entry({ id: "p2", title: "Elsewhere", projectId: SECOND, projectName: "Internal Tools", occurredAt: "2026-10-01T12:00:00.000Z" })]));
    render(createElement(DashboardsPage, pageProps));
    const tabs = [...container.querySelectorAll("nav.jpd-tabs a")];
    expect(tabs.map((node) => node.getAttribute("aria-current"))).toEqual([null, "page"]);
    expect(container.querySelector("h1")?.textContent).toBe("Dashboards");
    expect(container.querySelector("a.jpd-item")).toBeNull();
    // The company view names the project of every entry and offers no import.
    expect([...container.querySelectorAll(".jpd-cl-project")].map((node) => node.textContent)).toEqual(["Acme Web App", "Internal Tools"]);
    expect(button("Import completed issues")).toBeUndefined();
    expect(lastList()).toEqual({ companyId: COMPANY, includeIssues: true, limit: 50 });
  });

  it("filters the company timeline by project through an accessible select", () => {
    host.search = "?view=changelog";
    host.data.set("projects.list", [{ id: PROJECT, name: "Acme Web App" }, { id: SECOND, name: "Internal Tools" }]);
    host.data.set("changelog.list", pageOf([entry()]));
    render(createElement(DashboardsPage, pageProps));
    const select = container.querySelector<HTMLSelectElement>("select")!;
    expect(container.querySelector(`label[for='${select.id}']`)?.textContent).toBe("Project");
    expect([...select.options].map((option) => option.textContent)).toEqual(["All projects", "Acme Web App", "Internal Tools"]);
    act(() => {
      select.value = SECOND;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(lastList()).toEqual({ companyId: COMPANY, projectId: SECOND, includeIssues: true, limit: 50 });
    // The project is now implied, so it is not repeated on each entry.
    expect(container.querySelector(".jpd-cl-project")).toBeNull();
    act(() => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(lastList()).not.toHaveProperty("projectId");
    expect(container.querySelector(".jpd-cl-project")).not.toBeNull();
  });

  it("starts over at 50 entries when the project changes", () => {
    host.search = "?view=changelog";
    host.data.set("projects.list", [{ id: SECOND, name: "Internal Tools" }]);
    host.data.set("changelog.list", pageOf([entry()], "more"));
    render(createElement(DashboardsPage, pageProps));
    click(button("Show more"));
    expect(lastList()).toMatchObject({ limit: 100 });
    const select = container.querySelector<HTMLSelectElement>("select")!;
    act(() => {
      select.value = SECOND;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(lastList()).toMatchObject({ projectId: SECOND, limit: 50 });
  });

  it("never lets the view switch break a dashboard link", () => {
    host.search = "?d=alpha&view=changelog";
    render(createElement(DashboardsPage, pageProps));
    expect(host.calls.find((call) => call.key === "dashboard.get")?.params).toEqual({ companyId: COMPANY, slug: "alpha" });
    expect(container.querySelector("nav.jpd-tabs")).toBeNull();
    expect(container.querySelector(".jpd-cl-wrap")).toBeNull();
  });

  it("uses the configured labels for both tabs", () => {
    host.data.set("settings.get", normalizeSettings({ navLabel: "Painéis", changelogTabLabel: "Evolução" }));
    render(createElement(DashboardsPage, pageProps));
    expect([...container.querySelectorAll("nav.jpd-tabs a")].map((node) => node.textContent)).toEqual(["Painéis", "Evolução"]);
    expect(container.querySelector("nav.jpd-tabs")?.getAttribute("aria-label")).toBe("Views");
  });

  it("does not refetch the dashboard list while the changelog view is open", () => {
    vi.useFakeTimers();
    host.search = "?view=changelog";
    host.data.set("settings.get", normalizeSettings({ refreshIntervalSeconds: 10 }));
    render(createElement(DashboardsPage, pageProps));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(host.refreshes.filter((key) => key === "dashboards.list")).toHaveLength(0);
    expect(host.refreshes.filter((key) => key === "changelog.list")).toHaveLength(1);
  });
});
