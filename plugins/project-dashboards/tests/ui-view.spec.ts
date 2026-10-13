// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDetailTabProps, PluginPageProps, PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import type { DashboardRecord, DashboardSettings, DashboardSpec, DashboardSummary } from "../src/contracts.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings.js";
import { validateSpec } from "../src/spec.js";
import { DashboardsPage, ProjectDashboardTab, SidebarLink } from "../src/ui/index.js";
import { createTranslator } from "../src/ui/i18n.js";
import { formatterFor } from "../src/ui/model.js";
import { DashboardView, createEnv } from "../src/ui/view.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const host = vi.hoisted(() => ({
  search: "",
  data: new Map<string, unknown>(),
  actions: new Map<string, ReturnType<typeof vi.fn>>(),
  calls: [] as { key: string; params: Record<string, unknown> }[],
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
    return { data: host.data.get(key) ?? null, loading: false, error: null, refresh: vi.fn() };
  },
}));

const exampleSpec = (() => {
  const result = validateSpec(JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../examples/project-dashboard.example.json"), "utf8")));
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  return result.spec;
})();

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  host.search = "";
  host.data = new Map();
  host.actions = new Map();
  host.calls = [];
  // Mimic the host: Markdown is rendered as inert text by react-markdown (no raw HTML).
  Object.assign(globalThis, {
    __md: (content: string) => createElement("div", { "data-md": "" }, content),
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderSpec(spec: DashboardSpec, settings: DashboardSettings = DEFAULT_SETTINGS) {
  const env = createEnv(spec, settings, formatterFor(settings), createTranslator(settings.locale), false);
  act(() => {
    root.render(
      createElement(DashboardView, {
        env,
        revision: 4,
        updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
        updatedBy: { kind: "agent", id: "a", name: "Tracker" },
      }),
    );
  });
}

const text = () => container.textContent ?? "";

describe("DashboardView with the example fixture", () => {
  it("renders header, KPIs, tables, charts, status list, sources and footer", () => {
    renderSpec(exampleSpec);
    expect(container.querySelector("h1")?.textContent).toBe("Acme Web App — delivery status");
    expect(text()).toContain("Revision 4 · updated 1 hour ago by agent Tracker");
    // KPIs resolved from datasets.
    const kpis = [...container.querySelectorAll(".jpd-kpi")];
    expect(kpis.length).toBe(5);
    expect(kpis[0]?.textContent).toContain("2");
    expect(kpis[0]?.textContent).toContain("of 5");
    expect(kpis[1]?.textContent).toContain("29");
    expect(kpis[1]?.textContent).toContain("of 51");
    expect(kpis[4]?.textContent).toContain("71%");
    // Tables
    const rows = container.querySelectorAll("table.jpd-table tbody tr");
    expect(rows.length).toBe(5 + 10 + 3);
    // Charts: svg charts present with role=img, plus the progress chart
    const charts = [...container.querySelectorAll("svg[role='img'][viewBox]")].filter((svg) => svg.closest(".jpd-chart"));
    expect(charts.length).toBeGreaterThanOrEqual(4);
    expect(container.querySelector("[role='progressbar']")).not.toBeNull();
    expect(container.querySelectorAll(".jpd-chart table.jpd-sr").length).toBeGreaterThanOrEqual(5);
    expect(container.querySelectorAll("rect.jpd-bar[tabindex='0']").length).toBeGreaterThan(5);
    // Status list
    expect(container.querySelectorAll(".jpd-statusitem").length).toBe(6);
    // Mermaid goes through the host markdown renderer as a fence
    expect([...container.querySelectorAll("[data-md]")].some((node) => node.textContent?.startsWith("```mermaid\nflowchart LR"))).toBe(true);
    // Sources panel lists each dataset with origin
    const sources = container.querySelector("details.jpd-sources");
    expect(sources?.querySelectorAll(".jpd-source").length).toBe(Object.keys(exampleSpec.datasets).length);
    expect(sources?.textContent).toContain("Origin: https://example.com/acme/roadmap");
    // Footer markdown
    expect(text()).toContain("A passing gate shows the criteria were met");
  });

  it("maps status values to accessible tones", () => {
    renderSpec(exampleSpec);
    const firstTable = container.querySelector("table.jpd-table");
    const statuses = [...firstTable!.querySelectorAll("td[data-label='Status'] svg")].map((svg) => svg.getAttribute("aria-label"));
    expect(statuses).toEqual(["ok", "ok", "warning", "warning", "pending"]);
    // The status list shows its detail field, not a literal field name.
    expect(container.querySelector(".jpd-statusitem .jpd-card-note")?.textContent).toBe("Uptime, last 30 days");
    const priorities = [...container.querySelectorAll(".jpd-prio")].map((node) => node.className.match(/jpd-tone-(\w+)/)?.[1]);
    expect(new Set(priorities)).toEqual(new Set(["bad", "warn", "muted"]));
  });

  it("opens external links safely and never creates javascript: links", () => {
    const spec: DashboardSpec = structuredClone(exampleSpec);
    spec.datasets.releases!.rows[0]!.link = "javascript:alert(1)";
    renderSpec(spec);
    const anchors = [...container.querySelectorAll("a.jpd-link")];
    expect(anchors.length).toBe(2);
    for (const anchor of anchors) {
      expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
      expect(anchor.getAttribute("href")).toMatch(/^https:\/\//);
    }
    expect(text()).toContain("javascript:alert(1)");
  });
});

describe("table filters", () => {
  const pendingTable = () => [...container.querySelectorAll(".jpd-table-wrap")].find((wrap) => wrap.querySelector(".jpd-tools"))!;
  const bodyRows = () => pendingTable().querySelectorAll("tbody tr");

  it("narrows rows with chips, selects and search", () => {
    renderSpec(exampleSpec);
    expect(bodyRows().length).toBe(10);
    const chip = [...pendingTable().querySelectorAll("button.jpd-chip")].find((b) => b.textContent?.startsWith("todo"))!;
    act(() => (chip as HTMLButtonElement).click());
    expect(bodyRows().length).toBe(5);
    expect(chip.getAttribute("aria-pressed")).toBe("true");

    const select = pendingTable().querySelector("select[aria-label='Type']") as HTMLSelectElement;
    act(() => {
      select.value = "Bug";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(bodyRows().length).toBe(0);
    expect(pendingTable().textContent).toContain("Nothing matches these filters.");

    act(() => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const input = pendingTable().querySelector("input[type='search']") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, "flags");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(bodyRows().length).toBe(1);
    expect(pendingTable().querySelector(".jpd-count")?.textContent).toBe("1 of 10");
  });
});

describe("untrusted values", () => {
  it("renders dataset values containing HTML as text everywhere", () => {
    const payload = '<img src=x onerror="window.__pwned=1">';
    const spec: DashboardSpec = {
      version: 1,
      title: payload,
      datasets: {
        d: { title: payload, source: payload, description: payload, rows: [{ name: payload, status: payload, n: 3, link: payload }] },
      },
      sections: [
        {
          id: "s",
          title: payload,
          blocks: [
            { type: "kpis", items: [{ label: payload, value: { dataset: "d", field: "name" }, caption: payload }] },
            { type: "table", dataset: "d", rowKey: "name", columns: [{ field: "name", label: payload }, { field: "status", label: "S", format: "status" }, { field: "link", label: "L", format: "link" }] },
            { type: "statusList", dataset: "d", labelField: "name", valueField: "name", statusField: "status", detailField: "name" },
            { type: "chart", chart: "bar", dataset: "d", x: "name", y: "n" },
            { type: "chart", chart: "donut", dataset: "d", x: "name", y: "n" },
            { type: "chart", chart: "progress", dataset: "d", x: "name", y: "n" },
            { type: "chart", chart: "horizontalBar", dataset: "d", x: "name", y: "n" },
          ],
        },
      ],
    };
    renderSpec(spec);
    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(text()).toContain(payload);
    // Open the sources panel content (rendered even when collapsed) as text as well.
    expect(container.querySelector("details.jpd-sources")?.textContent).toContain(payload);
  });
});

describe("series colors and goal marker", () => {
  const base = (block: object, rows: object[] = [{ t: "Bug", P0: 2, P1: 1, other: 4 }]): DashboardSpec => {
    const result = validateSpec({
      version: 1,
      title: "T",
      datasets: { d: { title: "D", rows } },
      sections: [{ id: "s", blocks: [block] }],
    });
    if (!result.ok) {
      throw new Error(result.errors.join("\n"));
    }
    return result.spec;
  };
  const fills = () => [...container.querySelectorAll(".jpd-chart svg g rect")].map((r) => r.getAttribute("fill"));
  const swatches = () => [...container.querySelectorAll(".jpd-legend .jpd-swatch")].map((n) => (n as HTMLElement).style.background);

  it("colors status/priority series by tone, in bars and legend", () => {
    renderSpec(base({ type: "chart", chart: "stackedBar", dataset: "d", x: "t", y: ["P0", "P1"] }));
    expect(fills()).toEqual(["#b91c1c", "#b45309"]);
    expect(swatches()).toEqual(["rgb(185, 28, 28)", "rgb(180, 83, 9)"]);
  });

  it("uses the categorical palette when a series is not a known status", () => {
    renderSpec(base({ type: "chart", chart: "stackedBar", dataset: "d", x: "t", y: ["P0", "other"] }));
    expect(fills()).toEqual(["#2563eb", "#d97706"]);
  });

  it("honors seriesColors (tone or hex) and spec statusTones", () => {
    renderSpec(base({ type: "chart", chart: "bar", dataset: "d", x: "t", y: ["P0", "other"], seriesColors: { P0: "ok", other: "#123456" } }));
    expect(fills()).toEqual(["#15803d", "#123456"]);
    const spec = base({ type: "chart", chart: "bar", dataset: "d", x: "t", y: ["P0", "other"] });
    spec.statusTones = { other: "info" };
    renderSpec(spec);
    expect(fills()).toEqual(["#b91c1c", "#1d4ed8"]);
  });

  it("draws a goal marker only when values exceed the goal", () => {
    const progress = (goal: number) => base({ type: "chart", chart: "progress", dataset: "d", x: "t", y: "other", goal }, [{ t: "A", other: 4 }, { t: "B", other: 10 }]);
    renderSpec(progress(5));
    expect(container.querySelector(".jpd-goal")).not.toBeNull();
    renderSpec(progress(10));
    expect(container.querySelector(".jpd-goal")).toBeNull();
  });

  it("tables are their own containers and cells do not wrap", () => {
    renderSpec(exampleSpec);
    expect(container.querySelector(".jpd-card")?.className).toContain("jpd-card");
    expect(container.querySelectorAll("td.jpd-nw").length).toBeGreaterThan(0);
  });
});

describe("locale and settings switching", () => {
  it("renders pt-BR strings and number formats from settings", () => {
    const settings = normalizeSettings({ locale: "pt-BR", currency: "BRL" });
    const spec: DashboardSpec = {
      version: 1,
      title: "Painel",
      datasets: { d: { title: "D", rows: [{ v: 1234.5, k: 0.5 }] } },
      sections: [
        {
          id: "s",
          blocks: [
            { type: "kpis", items: [{ label: "Receita", value: { dataset: "d", field: "v" }, format: "currency", of: 2000 }, { label: "Meta", value: { dataset: "d", field: "k" }, format: "pct" }] },
          ],
        },
      ],
    };
    renderSpec(spec, settings);
    const normalized = text().replace(/[  ]/g, " ");
    expect(normalized).toContain("R$ 1.234,50");
    expect(normalized).toContain("de R$ 2.000,00");
    expect(normalized).toContain("50%");
    expect(normalized).toContain("Revisão 4 · atualizado há 1 hora por o agente Tracker");
    expect(normalized).toContain("Fontes");
  });

  it("uses a custom palette and tone defaults from settings", () => {
    const settings = normalizeSettings({ palette: ["#010203"], defaultStatusTones: { review: "info" } });
    const spec: DashboardSpec = {
      version: 1,
      title: "T",
      datasets: { d: { title: "D", rows: [{ a: "x", n: 2, s: "review" }] } },
      sections: [
        {
          id: "s",
          blocks: [
            { type: "chart", chart: "bar", dataset: "d", x: "a", y: "n" },
            { type: "table", dataset: "d", rowKey: "a", columns: [{ field: "s", label: "S", format: "status" }] },
          ],
        },
      ],
    };
    renderSpec(spec, settings);
    expect(container.querySelector("svg g rect")?.getAttribute("fill")).toBe("#010203");
    expect(container.querySelector("td svg")?.getAttribute("class")).toContain("jpd-tone-info");
  });
});

describe("slots", () => {
  const record = (spec: DashboardSpec, projectId: string | null = "p1"): DashboardRecord => ({
    id: "d1",
    companyId: COMPANY,
    slug: "acme",
    title: spec.title,
    projectId,
    projectName: projectId ? "Acme Web App" : null,
    revision: 2,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedBy: { kind: "agent", id: "a", name: "Tracker" },
    spec,
    specErrors: [],
  });
  const summary = (title: string, projectName: string | null): DashboardSummary => ({
    id: `id-${title}`,
    slug: title.toLowerCase(),
    title,
    projectId: projectName ? "p1" : null,
    projectName,
    revision: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: { kind: "system", id: null },
  });
  const baseContext = { companyId: COMPANY, companyPrefix: "ACME", projectId: null, entityId: null, entityType: null, userId: null };

  it("sidebar uses the configured label", () => {
    host.data.set("settings.get", normalizeSettings({ navLabel: "Boards" }));
    act(() => root.render(createElement(SidebarLink, { context: baseContext } satisfies PluginSidebarProps)));
    expect(container.querySelector("a")?.textContent).toBe("Boards");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/ACME/dashboards");
  });

  it("page lists dashboards grouped by project and explains the empty state", () => {
    const props: PluginPageProps = { context: baseContext };
    act(() => root.render(createElement(DashboardsPage, props)));
    expect(text()).toContain("No dashboards yet");
    expect(text()).toContain("upsert_dashboard");

    host.data.set("dashboards.list", [summary("Alpha", "Acme Web App"), summary("Beta", null)]);
    act(() => root.render(createElement(DashboardsPage, props)));
    expect([...container.querySelectorAll(".jpd-group-title")].map((n) => n.textContent)).toEqual(["Acme Web App", "Company-level"]);
    expect(container.querySelector("a.jpd-item")?.getAttribute("href")).toBe("/ACME/dashboards?d=alpha");
  });

  it("page opens a dashboard from the query parameter", () => {
    host.search = "?d=acme";
    host.data.set("dashboard.get", record(exampleSpec));
    act(() => root.render(createElement(DashboardsPage, { context: baseContext })));
    expect(host.calls.find((call) => call.key === "dashboard.get")?.params).toEqual({ companyId: COMPANY, slug: "acme" });
    expect(container.querySelector("h1")?.textContent).toContain("Acme Web App");
  });

  it("project tab filters by project and selects between several dashboards", () => {
    const context = { ...baseContext, projectId: "p1", entityId: "p1", entityType: "project" };
    const props: PluginDetailTabProps = { context };
    act(() => root.render(createElement(ProjectDashboardTab, props)));
    expect(text()).toContain("This project has no dashboard yet");
    expect(host.calls.find((call) => call.key === "dashboards.list")?.params).toEqual({ companyId: COMPANY, projectId: "p1" });

    host.data.set("dashboards.list", [summary("Alpha", "Acme Web App"), summary("Beta", "Acme Web App")]);
    host.data.set("dashboard.get", record(exampleSpec));
    host.data.set("settings.get", normalizeSettings({ projectTabLabel: "Tracking" }));
    act(() => root.render(createElement(ProjectDashboardTab, props)));
    expect(container.querySelector("select")?.querySelectorAll("option").length).toBe(2);
    expect(container.querySelector("h2.jpd-h2")?.textContent).toBe("Tracking");
    expect(container.querySelector("h1")?.textContent).toContain("Acme Web App");
  });

  it("shows a clear message when a stored spec no longer validates", () => {
    host.search = "?d=acme";
    host.data.set("dashboard.get", { ...record(exampleSpec), spec: null, specErrors: ["sections: must be an array"] });
    act(() => root.render(createElement(DashboardsPage, { context: baseContext })));
    expect(text()).toContain("no longer validates");
    expect(text()).toContain("sections: must be an array");
  });
});
