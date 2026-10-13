/** DashboardSpec v1 and the records exchanged between worker and UI. */

export type Primitive = string | number | boolean | null;
export type Row = Record<string, Primitive>;

export const TONES = ["ok", "warn", "bad", "muted", "info"] as const;
export type Tone = (typeof TONES)[number];

export const FORMATS = ["int", "decimal", "pct", "currency", "duration", "raw"] as const;
export type Format = (typeof FORMATS)[number];

export const CELL_FORMATS = ["status", "priority", "date", "link", "code", "muted", "strong"] as const;
export type CellFormat = Format | (typeof CELL_FORMATS)[number];

export const AGGREGATIONS = ["sum", "count", "avg", "min", "max"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export const CHART_KINDS = [
  "bar",
  "horizontalBar",
  "stackedBar",
  "line",
  "area",
  "donut",
  "progress",
] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export type Where = Record<string, string | number | boolean>;

export interface ValueRef {
  dataset: string;
  field: string;
  where?: Where;
  row?: number;
  agg?: Aggregation;
}
export type Value = number | string | ValueRef;

export interface Dataset {
  title: string;
  description?: string;
  source?: string;
  updatedAt?: string;
  /** Hours after updatedAt at which the dataset counts as stale (0 < n <= 8760). */
  staleAfterHours?: number;
  columns?: string[];
  rows: Row[];
}

export interface KpiItem {
  label: string;
  value: Value;
  of?: Value;
  caption?: string;
  format?: Format;
  tone?: Tone;
}

export interface TableColumn {
  field: string;
  label: string;
  format?: CellFormat;
  wide?: boolean;
}

export interface TableFilters {
  chips?: string;
  selects?: string[];
  search?: boolean;
}

export interface BlockCommon {
  id?: string;
  title?: string;
  note?: string;
  span?: 1 | 2 | 3 | 4;
}

export interface MarkdownBlockSpec extends BlockCommon {
  type: "markdown";
  content: string;
}
export interface MermaidBlockSpec extends BlockCommon {
  type: "mermaid";
  code: string;
}
export interface CalloutBlockSpec extends BlockCommon {
  type: "callout";
  tone: Tone;
  content: string;
}
export interface KpisBlockSpec extends BlockCommon {
  type: "kpis";
  items: KpiItem[];
}
export interface ChartBlockSpec extends BlockCommon {
  type: "chart";
  chart: ChartKind;
  dataset: string;
  x: string;
  y: string | string[];
  seriesLabels?: Record<string, string>;
  format?: Format;
  tooltip?: string[];
  goal?: number;
  /** Series field to a tone name or "#rrggbb"; overrides tone/palette colors. */
  seriesColors?: Record<string, Tone | string>;
}
export interface TableBlockSpec extends BlockCommon {
  type: "table";
  dataset: string;
  rowKey: string;
  columns: TableColumn[];
  filters?: TableFilters;
  sort?: { field: string; dir: "asc" | "desc" };
  emptyText?: string;
}
export interface StatusListBlockSpec extends BlockCommon {
  type: "statusList";
  dataset: string;
  labelField: string;
  valueField: string;
  statusField: string;
  detailField?: string;
  format?: Format;
}

export type Block =
  | MarkdownBlockSpec
  | MermaidBlockSpec
  | CalloutBlockSpec
  | KpisBlockSpec
  | ChartBlockSpec
  | TableBlockSpec
  | StatusListBlockSpec;

export interface Section {
  id: string;
  title?: string;
  note?: string;
  columns?: 1 | 2 | 3 | 4;
  blocks: Block[];
}

export interface DashboardSpec {
  version: 1;
  title: string;
  summary?: string;
  meta?: string;
  datasets: Record<string, Dataset>;
  statusTones?: Record<string, Tone>;
  sections: Section[];
}

export type ActorKind = "agent" | "user" | "system";

export interface Actor {
  kind: ActorKind;
  id: string | null;
  name?: string | null;
}

export interface DashboardSummary {
  id: string;
  slug: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  /** The host's project route segment, for links. */
  projectUrlKey: string | null;
  /** True when the dashboard has no project (created before projects were required, or its project was deleted). */
  orphan: boolean;
  revision: number;
  updatedAt: string;
  updatedBy: Actor;
}

export interface DashboardRecord extends DashboardSummary {
  companyId: string;
  createdAt: string;
  /** Null only when a stored spec no longer validates; see specErrors. */
  spec: DashboardSpec | null;
  specErrors: string[];
}

export interface RevisionSummary {
  revision: number;
  createdAt: string;
  updatedBy: Actor;
}

/** Effective (defaulted and validated) company settings. */
export interface DashboardSettings {
  locale: string;
  currency: string;
  maxRevisions: number;
  maxSpecBytes: number;
  navLabel: string;
  projectTabLabel: string;
  palette: string[];
  defaultStatusTones: Record<string, Tone>;
  /** 0 = datasets never go stale unless they set staleAfterHours. */
  defaultStaleAfterHours: number;
  /** 0 = no automatic refresh; otherwise 5..3600. */
  refreshIntervalSeconds: number;
}

export type Health = "fresh" | "stale" | "unknown";

export interface DatasetStatus {
  id: string;
  title: string;
  rows: number;
  updatedAt: string | null;
  ageMinutes: number | null;
  staleAfterHours: number | null;
  stale: boolean;
}

export interface Freshness {
  checkedAt: string;
  health: Health;
  staleCount: number;
  datasets: DatasetStatus[];
  sections: number;
  blocks: number;
}

/** Summary plus the viewPath used by the REST API. */
export interface ApiSummary extends Omit<DashboardSummary, "projectUrlKey" | "orphan"> {
  viewPath: string;
}

export interface DashboardStatus extends ApiSummary, Freshness {
  orphan: boolean;
}

/** Cheap poll result: no spec, only what the viewer needs to decide on a refetch. */
export interface LiveStatus {
  projectId: string | null;
  projectName: string | null;
  projectUrlKey: string | null;
  orphan: boolean;
  revision: number;
  updatedAt: string;
  health: Health;
  staleCount: number;
  datasetCount: number;
}
