import { TONES, type DashboardSettings, type Tone } from "./contracts.js";
import { dict, isReservedKey } from "./keys.js";

export const SETTINGS_LIMITS = {
  maxRevisions: { min: 1, max: 200, default: 20 },
  maxSpecBytes: { min: 1024, max: 8 * 1024 * 1024, default: 512 * 1024 },
  staleAfterHours: { min: 0, max: 8760, default: 0 },
  refreshIntervalSeconds: { min: 5, max: 3600, default: 30 },
  label: { max: 40 },
  palette: { max: 8 },
} as const;

/**
 * Built-in value heuristics. Keys are normalized (see normalizeToneKey).
 * Settings and each spec's own statusTones are merged on top of these.
 */
export const BUILTIN_STATUS_TONES: Record<string, Tone> = {
  done: "ok",
  complete: "ok",
  completed: "ok",
  ok: "ok",
  success: "ok",
  passed: "ok",
  shipped: "ok",
  pronto: "ok",
  concluido: "ok",
  in_progress: "warn",
  partial: "warn",
  at_risk: "warn",
  parcial: "warn",
  em_andamento: "warn",
  blocked: "bad",
  failed: "bad",
  error: "bad",
  falhou: "bad",
  bloqueado: "bad",
  todo: "muted",
  pending: "muted",
  open: "muted",
  planned: "muted",
  pendente: "muted",
  warn: "warn",
  warning: "warn",
  bad: "bad",
  critical: "bad",
  info: "info",
  p0: "bad",
  p1: "warn",
  p2: "muted",
};

export function normalizeToneKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export const DEFAULT_SETTINGS: DashboardSettings = {
  locale: "en-US",
  currency: "USD",
  maxRevisions: SETTINGS_LIMITS.maxRevisions.default,
  maxSpecBytes: SETTINGS_LIMITS.maxSpecBytes.default,
  navLabel: "Dashboards",
  projectTabLabel: "Dashboard",
  palette: [],
  defaultStatusTones: {},
  defaultStaleAfterHours: SETTINGS_LIMITS.staleAfterHours.default,
  refreshIntervalSeconds: SETTINGS_LIMITS.refreshIntervalSeconds.default,
};

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validLocale(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const [canonical] = Intl.getCanonicalLocales(value.trim());
    return canonical ?? null;
  } catch {
    return null;
  }
}

function validCurrency(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    return null;
  }
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency: code });
    return code;
  } catch {
    return null;
  }
}

function boundedInt(value: unknown, limits: { min: number; max: number; default: number }): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return limits.default;
  }
  return Math.min(limits.max, Math.max(limits.min, value));
}

/** 0 means off; any other value is clamped to the allowed polling range. */
function refreshInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return SETTINGS_LIMITS.refreshIntervalSeconds.default;
  }
  if (value === 0) {
    return 0;
  }
  return Math.min(
    SETTINGS_LIMITS.refreshIntervalSeconds.max,
    Math.max(SETTINGS_LIMITS.refreshIntervalSeconds.min, value),
  );
}

function label(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= SETTINGS_LIMITS.label.max ? trimmed : fallback;
}

function isTone(value: unknown): value is Tone {
  return typeof value === "string" && (TONES as readonly string[]).includes(value);
}

/**
 * Turn raw operator configuration into effective settings. Invalid values never
 * throw: each falls back to its default so a typo cannot break dashboards.
 * `palette` keeps its slots: an invalid entry becomes "" and the UI uses the
 * built-in color for that slot.
 */
export function normalizeSettings(raw: unknown): DashboardSettings {
  const input = isRecord(raw) ? raw : {};
  const palette = Array.isArray(input.palette)
    ? input.palette
        .slice(0, SETTINGS_LIMITS.palette.max)
        .map((entry) => (typeof entry === "string" && HEX_COLOR.test(entry.trim()) ? entry.trim() : ""))
    : [];
  const defaultStatusTones = dict<Tone>();
  if (isRecord(input.defaultStatusTones)) {
    for (const [key, tone] of Object.entries(input.defaultStatusTones)) {
      const normalized = normalizeToneKey(key);
      if (normalized && !isReservedKey(normalized) && isTone(tone)) {
        defaultStatusTones[normalized] = tone;
      }
    }
  }
  return {
    locale: validLocale(input.locale) ?? DEFAULT_SETTINGS.locale,
    currency: validCurrency(input.currency) ?? DEFAULT_SETTINGS.currency,
    maxRevisions: boundedInt(input.maxRevisions, SETTINGS_LIMITS.maxRevisions),
    maxSpecBytes: boundedInt(input.maxSpecBytes, SETTINGS_LIMITS.maxSpecBytes),
    navLabel: label(input.navLabel, DEFAULT_SETTINGS.navLabel),
    projectTabLabel: label(input.projectTabLabel, DEFAULT_SETTINGS.projectTabLabel),
    palette: palette.some((entry) => entry !== "") ? palette : [],
    defaultStatusTones,
    defaultStaleAfterHours: boundedInt(input.defaultStaleAfterHours, SETTINGS_LIMITS.staleAfterHours),
    refreshIntervalSeconds: refreshInterval(input.refreshIntervalSeconds),
  };
}

/** JSON Schema for the host-generated settings form (kept to plain keywords). */
export const INSTANCE_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    locale: {
      type: "string",
      title: "Locale",
      description: "BCP-47 tag for number/date formatting and UI language (en and pt-BR are translated; others fall back to English text).",
      default: DEFAULT_SETTINGS.locale,
      maxLength: 35,
    },
    currency: {
      type: "string",
      title: "Currency",
      description: "ISO 4217 code used by the currency format.",
      default: DEFAULT_SETTINGS.currency,
      pattern: "^[A-Za-z]{3}$",
    },
    maxRevisions: {
      type: "integer",
      title: "Revisions kept per dashboard",
      minimum: SETTINGS_LIMITS.maxRevisions.min,
      maximum: SETTINGS_LIMITS.maxRevisions.max,
      default: SETTINGS_LIMITS.maxRevisions.default,
    },
    maxSpecBytes: {
      type: "integer",
      title: "Maximum serialized spec size (bytes)",
      minimum: SETTINGS_LIMITS.maxSpecBytes.min,
      maximum: SETTINGS_LIMITS.maxSpecBytes.max,
      default: SETTINGS_LIMITS.maxSpecBytes.default,
    },
    navLabel: {
      type: "string",
      title: "Sidebar and page label",
      default: DEFAULT_SETTINGS.navLabel,
      maxLength: SETTINGS_LIMITS.label.max,
    },
    projectTabLabel: {
      type: "string",
      title: "Project tab label",
      default: DEFAULT_SETTINGS.projectTabLabel,
      maxLength: SETTINGS_LIMITS.label.max,
    },
    palette: {
      type: "array",
      title: "Chart palette override",
      description: "Up to 8 hex colors (for example #3b82f6). Invalid entries use the built-in color for that slot.",
      items: { type: "string" },
      maxItems: SETTINGS_LIMITS.palette.max,
    },
    defaultStaleAfterHours: {
      type: "integer",
      title: "Default stale-after (hours)",
      description: "Datasets older than this are flagged stale unless they set staleAfterHours. 0 never marks datasets stale.",
      minimum: SETTINGS_LIMITS.staleAfterHours.min,
      maximum: SETTINGS_LIMITS.staleAfterHours.max,
      default: SETTINGS_LIMITS.staleAfterHours.default,
    },
    refreshIntervalSeconds: {
      type: "integer",
      title: "Automatic refresh interval (seconds)",
      description: "How often open dashboards check for new revisions. 0 turns automatic refresh off; otherwise 5 to 3600.",
      minimum: 0,
      maximum: SETTINGS_LIMITS.refreshIntervalSeconds.max,
      default: SETTINGS_LIMITS.refreshIntervalSeconds.default,
    },
    defaultStatusTones: {
      type: "object",
      title: "Default status tones",
      description: "Map of status or priority values to ok, warn, bad, muted or info. A dashboard's own statusTones win over these.",
      additionalProperties: { type: "string", enum: [...TONES] },
    },
  },
};
