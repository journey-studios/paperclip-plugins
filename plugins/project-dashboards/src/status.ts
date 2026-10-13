import type { DashboardRecord, DashboardSettings, DashboardSpec, DashboardStatus, Freshness, LiveStatus } from "./contracts.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Pure freshness rules shared by the REST status route, the agent tool and the UI.
 * A dataset is stale when its threshold (own staleAfterHours, else the default
 * setting; 0 or unset means never) is set and updatedAt is missing or older
 * than the threshold. Health is "stale" if any dataset is stale, "unknown" if
 * no dataset has an updatedAt, otherwise "fresh".
 */
export function computeFreshness(spec: DashboardSpec | null, settings: Pick<DashboardSettings, "defaultStaleAfterHours">, now: Date): Freshness {
  const checkedAt = now.toISOString();
  if (!spec) {
    return { checkedAt, health: "unknown", staleCount: 0, datasets: [], sections: 0, blocks: 0 };
  }
  const datasets = Object.entries(spec.datasets).map(([id, dataset]) => {
    const parsed = dataset.updatedAt ? Date.parse(dataset.updatedAt) : Number.NaN;
    const hasDate = !Number.isNaN(parsed);
    const ageMs = hasDate ? Math.max(0, now.getTime() - parsed) : null;
    const threshold = dataset.staleAfterHours ?? settings.defaultStaleAfterHours;
    const active = threshold > 0;
    const stale = active && (ageMs === null || ageMs > threshold * HOUR_MS);
    return {
      id,
      title: dataset.title,
      rows: dataset.rows.length,
      updatedAt: hasDate ? dataset.updatedAt ?? null : null,
      ageMinutes: ageMs === null ? null : Math.floor(ageMs / MINUTE_MS),
      staleAfterHours: active ? threshold : null,
      stale,
    };
  });
  const staleCount = datasets.filter((dataset) => dataset.stale).length;
  let health: Freshness["health"] = "fresh";
  if (staleCount > 0) {
    health = "stale";
  } else if (!datasets.some((dataset) => dataset.updatedAt !== null)) {
    health = "unknown";
  }
  return {
    checkedAt,
    health,
    staleCount,
    datasets,
    sections: spec.sections.length,
    blocks: spec.sections.reduce((sum, section) => sum + section.blocks.length, 0),
  };
}

export function computeStatus(record: DashboardRecord, settings: Pick<DashboardSettings, "defaultStaleAfterHours">, now: Date, viewPath: string): DashboardStatus {
  const { spec: _spec, specErrors: _errors, companyId: _companyId, createdAt: _createdAt, projectUrlKey: _urlKey, ...summary } = record;
  return { ...summary, viewPath, ...computeFreshness(record.spec, settings, now) };
}

export function computeLiveStatus(record: DashboardRecord, settings: Pick<DashboardSettings, "defaultStaleAfterHours">, now: Date): LiveStatus {
  const freshness = computeFreshness(record.spec, settings, now);
  return {
    projectId: record.projectId,
    projectName: record.projectName,
    projectUrlKey: record.projectUrlKey,
    orphan: record.orphan,
    revision: record.revision,
    updatedAt: record.updatedAt,
    health: freshness.health,
    staleCount: freshness.staleCount,
    datasetCount: freshness.datasets.length,
  };
}
