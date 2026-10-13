import { describe, expect, it } from "vitest";
import type { DashboardRecord, DashboardSpec } from "../src/contracts.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings.js";
import { computeFreshness, computeLiveStatus, computeStatus } from "../src/status.js";
import { validateSpec } from "../src/spec.js";

const NOW = new Date("2026-10-11T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function specWith(datasets: Record<string, object>): DashboardSpec {
  const result = validateSpec({
    version: 1,
    title: "T",
    datasets: Object.fromEntries(Object.entries(datasets).map(([id, extra]) => [id, { title: id.toUpperCase(), rows: [{ a: 1 }], ...extra }])),
    sections: [{ id: "s", blocks: [{ type: "markdown", content: "x" }, { type: "markdown", content: "y" }] }],
  });
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  return result.spec;
}

describe("computeFreshness", () => {
  it("never marks datasets stale with the default threshold of 0", () => {
    const result = computeFreshness(specWith({ a: { updatedAt: hoursAgo(5000) }, b: {} }), DEFAULT_SETTINGS, NOW);
    expect(result.staleCount).toBe(0);
    expect(result.health).toBe("fresh");
    expect(result.datasets[0]).toMatchObject({ id: "a", stale: false, staleAfterHours: null, ageMinutes: 5000 * 60 });
    expect(result.sections).toBe(1);
    expect(result.blocks).toBe(2);
    expect(result.checkedAt).toBe(NOW.toISOString());
  });

  it("uses the settings default and lets datasets override it", () => {
    const settings = normalizeSettings({ defaultStaleAfterHours: 24 });
    const result = computeFreshness(
      specWith({
        old: { updatedAt: hoursAgo(30) },
        fresh: { updatedAt: hoursAgo(2) },
        strict: { updatedAt: hoursAgo(3), staleAfterHours: 1 },
        lenient: { updatedAt: hoursAgo(30), staleAfterHours: 100 },
      }),
      settings,
      NOW,
    );
    const byId = Object.fromEntries(result.datasets.map((d) => [d.id, d]));
    expect(byId.old).toMatchObject({ stale: true, staleAfterHours: 24 });
    expect(byId.fresh).toMatchObject({ stale: false, staleAfterHours: 24 });
    expect(byId.strict).toMatchObject({ stale: true, staleAfterHours: 1 });
    expect(byId.lenient).toMatchObject({ stale: false, staleAfterHours: 100 });
    expect(result.staleCount).toBe(2);
    expect(result.health).toBe("stale");
  });

  it("treats a missing updatedAt as stale only when a threshold applies", () => {
    const withThreshold = computeFreshness(specWith({ a: { staleAfterHours: 2 } }), DEFAULT_SETTINGS, NOW);
    expect(withThreshold.datasets[0]).toMatchObject({ updatedAt: null, ageMinutes: null, stale: true });
    expect(withThreshold.health).toBe("stale");
    const without = computeFreshness(specWith({ a: {} }), DEFAULT_SETTINGS, NOW);
    expect(without.datasets[0]?.stale).toBe(false);
    expect(without.health).toBe("unknown");
  });

  it("is exactly at the boundary fresh and just past it stale; future dates have age 0", () => {
    const edge = computeFreshness(specWith({ a: { updatedAt: hoursAgo(24), staleAfterHours: 24 } }), DEFAULT_SETTINGS, NOW);
    expect(edge.datasets[0]?.stale).toBe(false);
    const past = computeFreshness(specWith({ a: { updatedAt: hoursAgo(24.01), staleAfterHours: 24 } }), DEFAULT_SETTINGS, NOW);
    expect(past.datasets[0]?.stale).toBe(true);
    const future = computeFreshness(specWith({ a: { updatedAt: hoursAgo(-3), staleAfterHours: 1 } }), DEFAULT_SETTINGS, NOW);
    expect(future.datasets[0]).toMatchObject({ ageMinutes: 0, stale: false });
  });

  it("reports unknown for no datasets or an unreadable spec", () => {
    expect(computeFreshness(specWith({}), DEFAULT_SETTINGS, NOW).health).toBe("unknown");
    expect(computeFreshness(null, DEFAULT_SETTINGS, NOW)).toMatchObject({ health: "unknown", datasets: [], sections: 0, blocks: 0 });
  });

  it("builds the REST status and the cheap live status from a record", () => {
    const spec = specWith({ a: { updatedAt: hoursAgo(10), staleAfterHours: 5 } });
    const record: DashboardRecord = {
      id: "i", companyId: "c", slug: "s", title: "T", projectId: null, projectName: null, projectUrlKey: null, orphan: true, revision: 3,
      updatedAt: hoursAgo(1), createdAt: hoursAgo(9), updatedBy: { kind: "agent", id: "x", name: "N" }, spec, specErrors: [],
    };
    const status = computeStatus(record, DEFAULT_SETTINGS, NOW, "/ACME/dashboards?d=s");
    expect(status).toMatchObject({ id: "i", slug: "s", revision: 3, viewPath: "/ACME/dashboards?d=s", health: "stale", staleCount: 1, orphan: true });
    expect(status).not.toHaveProperty("spec");
    expect(status).not.toHaveProperty("projectUrlKey");
    expect(status).not.toHaveProperty("companyId");
    expect(computeLiveStatus(record, DEFAULT_SETTINGS, NOW)).toEqual({ projectId: null, projectName: null, projectUrlKey: null, orphan: true, revision: 3, updatedAt: record.updatedAt, health: "stale", staleCount: 1, datasetCount: 1 });
  });

  it("validates staleAfterHours in specs", () => {
    for (const bad of [0, -1, 8761, "3", Number.NaN]) {
      const result = validateSpec({ version: 1, title: "T", datasets: { a: { title: "A", rows: [], staleAfterHours: bad } }, sections: [] });
      expect(result.ok, String(bad)).toBe(false);
    }
    expect(validateSpec({ version: 1, title: "T", datasets: { a: { title: "A", rows: [], staleAfterHours: 8760 } }, sections: [] }).ok).toBe(true);
  });
});

describe("new settings", () => {
  it("defaults and clamps staleness and refresh interval", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ defaultStaleAfterHours: 0, refreshIntervalSeconds: 30 });
    expect(normalizeSettings({ refreshIntervalSeconds: 0 }).refreshIntervalSeconds).toBe(0);
    expect(normalizeSettings({ refreshIntervalSeconds: 2 }).refreshIntervalSeconds).toBe(5);
    expect(normalizeSettings({ refreshIntervalSeconds: 99999 }).refreshIntervalSeconds).toBe(3600);
    expect(normalizeSettings({ refreshIntervalSeconds: -3 }).refreshIntervalSeconds).toBe(30);
    expect(normalizeSettings({ refreshIntervalSeconds: 1.5 }).refreshIntervalSeconds).toBe(30);
    expect(normalizeSettings({ defaultStaleAfterHours: 9999 }).defaultStaleAfterHours).toBe(8760);
    expect(normalizeSettings({ defaultStaleAfterHours: -1 }).defaultStaleAfterHours).toBe(0);
    expect(normalizeSettings({ defaultStaleAfterHours: "6" }).defaultStaleAfterHours).toBe(0);
    expect(normalizeSettings({ defaultStaleAfterHours: 12 }).defaultStaleAfterHours).toBe(12);
  });
});
