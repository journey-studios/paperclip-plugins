// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardRecord, DashboardSpec, LiveStatus } from "../src/contracts.js";
import { normalizeSettings } from "../src/settings.js";
import { DashboardsPage } from "../src/ui/index.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const host = vi.hoisted(() => ({
  search: "?d=acme",
  data: new Map<string, unknown>(),
  refreshes: [] as string[],
  copied: [] as string[],
  copyFails: false,
}));

vi.mock("@paperclipai/plugin-sdk/ui", async () => {
  const { useState, createElement: h } = await import("react");
  return {
    MarkdownBlock: ({ content }: { content: string }) => h("div", null, content),
    copyTextToClipboard: async (text: string) => {
      if (host.copyFails) {
        throw new Error("denied");
      }
      host.copied.push(text);
    },
    useHostLocation: () => ({ pathname: "/ACME/dashboards", search: host.search, hash: "" }),
    useHostNavigation: () => ({
      resolveHref: (to: string) => `/ACME${to}`,
      navigate: () => {},
      linkProps: (to: string) => ({ href: `/ACME${to}`, onClick: () => {} }),
    }),
    usePluginAction: () => async () => ({ ok: true }),
    usePluginData: (key: string) => {
      const [, setTick] = useState(0);
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

const spec = (stale = false): DashboardSpec => ({
  version: 1,
  title: "Live board",
  datasets: {
    d: {
      title: "Metrics",
      rows: [{ n: 1 }],
      ...(stale ? { updatedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(), staleAfterHours: 1 } : {}),
    },
  },
  sections: [{ id: "s", blocks: [{ type: "markdown", content: "hello" }] }],
});
const record = (revision: number, updatedAt: string, withStale = false): DashboardRecord => ({
  id: "d1", companyId: COMPANY, slug: "acme", title: "Live board", projectId: "p1", projectName: "Acme Web App", projectUrlKey: "acme-web-app", orphan: false, revision, updatedAt,
  createdAt: updatedAt, updatedBy: { kind: "agent", id: "a", name: "Tracker" }, spec: spec(withStale), specErrors: [],
});
const live = (revision: number, updatedAt: string): LiveStatus => ({ projectId: "p1", projectName: "Acme Web App", projectUrlKey: "acme-web-app", orphan: false, revision, updatedAt, health: "unknown", staleCount: 0, datasetCount: 1 });
const T0 = "2026-10-11T10:00:00.000Z";
const T1 = "2026-10-11T10:05:00.000Z";
const context = { companyId: COMPANY, companyPrefix: "ACME", projectId: null, entityId: null, entityType: null, userId: null };

let root: Root;
let container: HTMLDivElement;
const setVisibility = (state: "visible" | "hidden") => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
const text = () => container.textContent ?? "";
const count = (key: string) => host.refreshes.filter((entry) => entry === key).length;
const advance = (ms: number) => act(async () => {
  vi.advanceTimersByTime(ms);
});

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-11T10:10:00Z") });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host.search = "?d=acme";
  host.data = new Map<string, unknown>([
    ["settings.get", normalizeSettings({ refreshIntervalSeconds: 10 })],
    ["dashboard.get", record(2, T0)],
    ["dashboard.status", live(2, T0)],
  ]);
  host.refreshes = [];
  host.copied = [];
  host.copyFails = false;
  setVisibility("visible");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(createElement(DashboardsPage, { context })));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("polling", () => {
  it("checks the cheap status on the interval and does not refetch when unchanged", async () => {
    await advance(10_000);
    await advance(10_000);
    expect(count("dashboard.status")).toBe(2);
    expect(count("dashboard.get")).toBe(0);
    expect(text()).toContain("Live · checked 0s ago");
    await advance(3_000);
    expect(text()).toContain("Live · checked 3s ago");
  });

  it("refetches the record once when revision or updatedAt changes and shows a notice", async () => {
    host.data.set("dashboard.status", live(3, T1));
    await advance(10_000);
    expect(count("dashboard.get")).toBe(1);
    await advance(10_000);
    expect(count("dashboard.get")).toBe(1);
    expect(text()).not.toContain("Updated to revision");
    host.data.set("dashboard.get", record(3, T1));
    act(() => (container.querySelector("button.jpd-btn") as HTMLButtonElement).click());
    expect(text()).toContain("Revision 3");
    expect(text()).toContain("Updated to revision 3");
    await advance(7_000);
    expect(text()).not.toContain("Updated to revision 3");
  });

  it("refetches when only updatedAt changes", async () => {
    host.data.set("dashboard.status", live(2, T1));
    await advance(10_000);
    expect(count("dashboard.get")).toBe(1);
  });

  it("pauses while the page is hidden and checks again when it becomes visible", async () => {
    setVisibility("hidden");
    await advance(60_000);
    expect(count("dashboard.status")).toBe(0);
    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(count("dashboard.status")).toBe(1);
  });

  it("is off when the interval is 0", async () => {
    host.data.set("settings.get", normalizeSettings({ refreshIntervalSeconds: 0 }));
    act(() => root.render(createElement(DashboardsPage, { context })));
    await advance(3_600_000);
    expect(count("dashboard.status")).toBe(0);
    expect(text()).toContain("Automatic refresh is off");
  });

  it("localizes the indicator and cleans up timers on unmount", async () => {
    host.data.set("settings.get", normalizeSettings({ refreshIntervalSeconds: 10, locale: "pt-BR" }));
    act(() => root.render(createElement(DashboardsPage, { context })));
    expect(text()).toContain("Ao vivo · verificado há 0s");
    host.data.set("settings.get", normalizeSettings({ refreshIntervalSeconds: 0, locale: "pt-BR" }));
    act(() => root.render(createElement(DashboardsPage, { context })));
    expect(text()).toContain("Atualização automática desligada");
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});

describe("sharing and freshness", () => {
  it("copies the absolute link to the dashboard", async () => {
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Copy link")!;
    await act(async () => button.click());
    expect(host.copied).toEqual([`${window.location.origin}/ACME/dashboards?d=acme`]);
    expect(text()).toContain("Link copied");
    host.copyFails = true;
    await act(async () => button.click());
    expect(text()).toContain("Could not copy the link");
  });

  it("warns about stale sources and badges them in the Sources panel", () => {
    host.data.set("dashboard.get", record(2, T0, true));
    act(() => root.render(createElement(DashboardsPage, { context })));
    expect(container.querySelector(".jpd-stale-banner")?.textContent).toBe("1 stale source");
    expect(container.querySelector(".jpd-source .jpd-badge-stale")?.textContent).toContain("Stale");
  });

  it("does not warn when nothing is stale", () => {
    expect(container.querySelector(".jpd-stale-banner")).toBeNull();
    expect(container.querySelector(".jpd-badge-stale")).toBeNull();
  });

  it("honours ?d=<slug> on direct load", () => {
    expect(container.querySelector("h1")?.textContent).toBe("Live board");
  });
});

describe("revision history", () => {
  const revision = (n: number) => ({ revision: n, createdAt: T0, updatedBy: { kind: "agent", id: "a" } });
  const restoreButtons = () => [...container.querySelectorAll<HTMLButtonElement>(".jpd-history button")].filter((b) => b.textContent === "Restore");

  it("refreshes the revision list after a restore so the current revision loses its button", async () => {
    window.confirm = () => true;
    host.data.set("dashboard.revisions", [revision(2), revision(1)]);
    const details = [...container.querySelectorAll("details.jpd-sources")].find((d) => d.textContent?.startsWith("Revision history"))!;
    await act(async () => {
      (details as HTMLDetailsElement).open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(restoreButtons()).toHaveLength(1);

    // The worker would now hold revision 3 (a restore creates a new revision).
    host.data.set("dashboard.get", record(3, T1));
    host.data.set("dashboard.status", live(3, T1));
    host.data.set("dashboard.revisions", [revision(3), revision(2), revision(1)]);
    await act(async () => restoreButtons()[0]!.click());
    expect(count("dashboard.revisions")).toBe(1);
    expect(count("dashboard.get")).toBe(1);
    expect(restoreButtons()).toHaveLength(2);
    expect(container.querySelector(".jpd-history")?.textContent).toContain("#3");
  });
});
