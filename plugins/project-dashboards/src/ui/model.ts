import type {
  Aggregation,
  Dataset,
  DashboardSettings,
  DashboardSpec,
  Format,
  Primitive,
  Row,
  Tone,
  Value,
} from "../contracts.js";
import { BUILTIN_STATUS_TONES, normalizeToneKey } from "../settings.js";

/* ---------------------------------------------------------------- formatting */

export interface Formatter {
  locale: string;
  currency: string;
  format(value: Primitive | undefined, format?: Format): string;
  tick(value: number, format?: Format): string;
  date(value: Primitive | undefined): string;
  dateTime(value: Primitive | undefined): string;
  relative(iso: string, nowMs?: number): string;
}

export const EMPTY = "—";

export function formatDuration(seconds: number): string {
  const total = Math.round(Math.abs(seconds));
  const sign = seconds < 0 ? "-" : "";
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) {
    return `${sign}${d}d ${h}h`;
  }
  if (h > 0) {
    return `${sign}${h}h ${m}m`;
  }
  if (m > 0) {
    return `${sign}${m}m ${s}s`;
  }
  return `${sign}${s}s`;
}

function parseDate(value: Primitive | undefined): { date: Date; dateOnly: boolean } | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : { date, dateOnly: value.length === 10 };
}

export function createFormatter(locale: string, currency: string): Formatter {
  const int = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const money = new Intl.NumberFormat(locale, { style: "currency", currency });
  const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  const dateOnly = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  const dateLocal = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  const formatter: Formatter = {
    locale,
    currency,
    format(value, format = "raw") {
      if (value === null || value === undefined) {
        return EMPTY;
      }
      if (format === "raw" || typeof value !== "number") {
        return String(value);
      }
      switch (format) {
        case "int":
          return int.format(value);
        case "decimal":
          return decimal.format(value);
        case "pct":
          return pct.format(value);
        case "currency":
          return money.format(value);
        case "duration":
          return formatDuration(value);
        default:
          return String(value);
      }
    },
    tick(value, format = "int") {
      if (format === "pct") {
        return pct.format(value);
      }
      if (format === "currency") {
        return new Intl.NumberFormat(locale, { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(value);
      }
      if (format === "duration") {
        return formatDuration(value);
      }
      return Math.abs(value) >= 10_000 ? compact.format(value) : decimal.format(value);
    },
    date(value) {
      const parsed = parseDate(value);
      if (!parsed) {
        return value === null || value === undefined ? EMPTY : String(value);
      }
      return (parsed.dateOnly ? dateOnly : dateLocal).format(parsed.date);
    },
    dateTime(value) {
      const parsed = parseDate(value);
      if (!parsed) {
        return value === null || value === undefined ? EMPTY : String(value);
      }
      return parsed.dateOnly ? dateOnly.format(parsed.date) : dateTime.format(parsed.date);
    },
    relative(iso, nowMs = Date.now()) {
      const time = Date.parse(iso);
      if (Number.isNaN(time)) {
        return iso;
      }
      const seconds = Math.round((time - nowMs) / 1000);
      const steps: [Intl.RelativeTimeFormatUnit, number][] = [
        ["year", 31_536_000],
        ["month", 2_592_000],
        ["day", 86_400],
        ["hour", 3600],
        ["minute", 60],
      ];
      for (const [unit, size] of steps) {
        if (Math.abs(seconds) >= size) {
          return relative.format(Math.round(seconds / size), unit);
        }
      }
      return relative.format(seconds, "second");
    },
  };
  return formatter;
}

export function formatterFor(settings: Pick<DashboardSettings, "locale" | "currency">): Formatter {
  try {
    return createFormatter(settings.locale, settings.currency);
  } catch {
    return createFormatter("en-US", "USD");
  }
}

/* ------------------------------------------------------------- value resolve */

export function aggregate(values: number[], agg: Aggregation): number | null {
  if (agg === "count") {
    return values.length;
  }
  if (values.length === 0) {
    return agg === "sum" ? 0 : null;
  }
  switch (agg) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    default:
      return null;
  }
}

export function resolveValue(value: Value, datasets: Record<string, Dataset>): Primitive {
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }
  const dataset = datasets[value.dataset];
  if (!dataset) {
    return null;
  }
  const where = value.where ? Object.entries(value.where) : [];
  const rows = dataset.rows.filter((row) => where.every(([key, expected]) => row[key] === expected));
  if (value.agg) {
    if (value.agg === "count") {
      return rows.length;
    }
    const numbers = rows.map((row) => row[value.field]).filter((cell): cell is number => typeof cell === "number");
    return aggregate(numbers, value.agg);
  }
  return rows[value.row ?? 0]?.[value.field] ?? null;
}

/* ------------------------------------------------------------------ tones */

export function buildToneMap(settings: Pick<DashboardSettings, "defaultStatusTones">, spec: Pick<DashboardSpec, "statusTones">): Record<string, Tone> {
  const merged: Record<string, Tone> = { ...BUILTIN_STATUS_TONES, ...settings.defaultStatusTones };
  for (const [key, tone] of Object.entries(spec.statusTones ?? {})) {
    merged[normalizeToneKey(key)] = tone;
  }
  return merged;
}

export function toneFor(value: Primitive | undefined, tones: Record<string, Tone>): Tone {
  if (value === null || value === undefined) {
    return "muted";
  }
  return tones[normalizeToneKey(String(value))] ?? "muted";
}

/* --------------------------------------------------------- tables / filters */

export interface RowFilter {
  chip?: { field: string; value: string } | null;
  selects?: Record<string, string>;
  search?: string;
  searchFields?: string[];
}

function cellText(value: Primitive | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

export function filterRows(rows: Row[], filter: RowFilter): Row[] {
  const needle = (filter.search ?? "").trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.chip && cellText(row[filter.chip.field]) !== filter.chip.value) {
      return false;
    }
    for (const [field, selected] of Object.entries(filter.selects ?? {})) {
      if (selected && cellText(row[field]) !== selected) {
        return false;
      }
    }
    if (needle) {
      const fields = filter.searchFields ?? Object.keys(row);
      return fields.some((field) => cellText(row[field]).toLowerCase().includes(needle));
    }
    return true;
  });
}

export function countBy(rows: Row[], field: string): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = cellText(row[field]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([value, count]) => ({ value, count }));
}

export function distinctValues(rows: Row[], field: string): string[] {
  return [...new Set(rows.map((row) => cellText(row[field])).filter((v) => v !== ""))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

export function sortRows(rows: Row[], sort: { field: string; dir: "asc" | "desc" } | undefined, locale: string): Row[] {
  if (!sort) {
    return rows;
  }
  const factor = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = a[sort.field];
    const right = b[sort.field];
    if (left === null || left === undefined) {
      return right === null || right === undefined ? 0 : 1;
    }
    if (right === null || right === undefined) {
      return -1;
    }
    if (typeof left === "number" && typeof right === "number") {
      return (left - right) * factor;
    }
    return String(left).localeCompare(String(right), locale, { numeric: true }) * factor;
  });
}

/** Only absolute http(s) URLs may become links. */
export function safeHref(value: Primitive | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- charts */

export const DEFAULT_PALETTE = {
  light: ["#2563eb", "#d97706", "#059669", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#65a30d"],
  dark: ["#60a5fa", "#fbbf24", "#34d399", "#f87171", "#a78bfa", "#22d3ee", "#f472b6", "#a3e635"],
};

/** Eight colors: operator overrides first, built-in per slot otherwise. */
export function resolvePalette(override: string[], dark: boolean): string[] {
  const base = dark ? DEFAULT_PALETTE.dark : DEFAULT_PALETTE.light;
  return base.map((fallback, index) => (override[index] ? override[index] : fallback));
}

/** Same values as the status dots (see styles.ts), as literals for SVG fills. */
export const TONE_COLORS: Record<"light" | "dark", Record<Tone, string>> = {
  light: { ok: "#15803d", warn: "#b45309", bad: "#b91c1c", info: "#1d4ed8", muted: "#737373" },
  dark: { ok: "#4ade80", warn: "#fbbf24", bad: "#f87171", info: "#60a5fa", muted: "#a3a3a3" },
};

function isToneName(value: string): value is Tone {
  return value in TONE_COLORS.light;
}

/**
 * One color per y field. Explicit seriesColors win; otherwise, when every
 * series name is a known status/priority value, tone colors are used;
 * otherwise the categorical palette.
 */
export function seriesColorsFor(
  keys: string[],
  seriesColors: Record<string, string> | undefined,
  tones: Record<string, Tone>,
  palette: string[],
  dark: boolean,
): string[] {
  const toneColors = dark ? TONE_COLORS.dark : TONE_COLORS.light;
  const fallback = (index: number) => palette[index % palette.length] ?? "#888888";
  if (seriesColors) {
    return keys.map((key, index) => {
      const chosen = seriesColors[key];
      if (chosen === undefined) {
        return fallback(index);
      }
      return isToneName(chosen) ? toneColors[chosen] : chosen;
    });
  }
  const known = keys.map((key) => tones[normalizeToneKey(key)]);
  if (known.length > 0 && known.every((tone) => tone !== undefined)) {
    return known.map((tone) => (tone ? toneColors[tone] : "#888888"));
  }
  return keys.map((_, index) => fallback(index));
}

export interface Series {
  key: string;
  label: string;
  values: number[];
}
export interface SeriesData {
  categories: string[];
  series: Series[];
  rows: Row[];
}

function num(value: Primitive | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function buildSeries(
  rows: Row[],
  x: string,
  y: string | string[],
  seriesLabels: Record<string, string> | undefined,
): SeriesData {
  const keys = typeof y === "string" ? [y] : y;
  return {
    categories: rows.map((row) => cellText(row[x])),
    series: keys.map((key) => ({
      key,
      label: seriesLabels?.[key] ?? key,
      values: rows.map((row) => num(row[key])),
    })),
    rows,
  };
}

export interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

/** "Nice" linear scale that always includes zero. */
export function niceScale(lo: number, hi: number, target = 5): Scale {
  const min = Math.min(0, lo);
  const max = Math.max(0, hi);
  const span = max - min || 1;
  const rough = span / Math.max(1, target);
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step || step;
  const ticks: number[] = [];
  for (let value = niceMin; value <= niceMax + step / 2; value += step) {
    ticks.push(Math.round(value / step) * step);
  }
  return { min: niceMin, max: niceMax, ticks };
}

export function stackedTotals(series: Series[], count: number): number[] {
  return Array.from({ length: count }, (_, index) => series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0));
}

/** Fence long enough that fenced content can never close it. */
export function mermaidFence(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}mermaid\n${code}\n${fence}`;
}
