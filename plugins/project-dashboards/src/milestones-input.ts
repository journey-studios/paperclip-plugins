import type { MilestoneCriterion, MilestoneEvidence, MilestoneStatus } from "./contracts.js";
import { DashboardError } from "./errors.js";
import { isRecord } from "./keys.js";
import { safeHttpUrl } from "./safe-url.js";
import { uuid } from "./store-util.js";

export class InvalidMilestoneError extends DashboardError {
  constructor(readonly details: string[]) {
    super(`Invalid milestone:\n${details.map((item) => `- ${item}`).join("\n")}`);
  }
}

export interface MilestoneFields {
  title: string;
  description: string | null;
  status: MilestoneStatus;
  targetDate: string | null;
  criteria: MilestoneCriterion[];
  issueIds: string[];
  evidence: MilestoneEvidence[];
}
export type MilestonePatch = Partial<MilestoneFields> & { revision: number };

const KEYS = ["title", "description", "status", "targetDate", "criteria", "issueIds", "evidence"] as const;
const STATUSES: readonly MilestoneStatus[] = ["planned", "in_progress", "completed", "cancelled"];

function text(value: unknown, max: number, name: string, errors: string[], nullable = false): string | null {
  if (nullable && (value === null || value === "")) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > max) {
    errors.push(`${name}: must be ${nullable ? "null or " : ""}1-${max} characters`);
    return null;
  }
  return value.trim();
}

function date(value: unknown, errors: string[]): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    errors.push("targetDate: must be a valid YYYY-MM-DD date or null");
    return null;
  }
  return value;
}

function criteria(value: unknown, errors: string[]): MilestoneCriterion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) {
    errors.push("criteria: must contain 1-30 {text, checked} items");
    return [];
  }
  const seen = new Set<string>();
  return value.flatMap((item, index) => {
    if (!isRecord(item) || Object.keys(item).some((key) => key !== "text" && key !== "checked") ||
        typeof item.checked !== "boolean") {
      errors.push(`criteria[${index}]: expected only text and checked (boolean)`);
      return [];
    }
    const line = text(item.text, 300, `criteria[${index}].text`, errors);
    if (line === null) return [];
    if (seen.has(line.toLowerCase())) {
      errors.push(`criteria[${index}]: duplicate criterion`);
      return [];
    }
    seen.add(line.toLowerCase());
    return [{ text: line, checked: item.checked }];
  });
}

function issueIds(value: unknown, errors: string[]): string[] {
  if (!Array.isArray(value) || value.length > 50) {
    errors.push("issueIds: must be an array of at most 50 issue UUIDs");
    return [];
  }
  const ids: string[] = [];
  for (const [index, item] of value.entries()) {
    try {
      const id = uuid(item, `issueIds[${index}]`);
      if (ids.includes(id)) errors.push(`issueIds[${index}]: duplicate issue`);
      else ids.push(id);
    } catch {
      errors.push(`issueIds[${index}]: must be an issue UUID`);
    }
  }
  return ids;
}

function evidence(value: unknown, errors: string[]): MilestoneEvidence[] {
  if (!Array.isArray(value) || value.length > 20) {
    errors.push("evidence: must be an array of at most 20 {label, url} links");
    return [];
  }
  return value.flatMap((item, index) => {
    if (!isRecord(item) || Object.keys(item).some((key) => key !== "label" && key !== "url")) {
      errors.push(`evidence[${index}]: expected only label and url`);
      return [];
    }
    const label = text(item.label, 100, `evidence[${index}].label`, errors);
    const link = typeof item.url === "string" && item.url.length <= 2000 ? safeHttpUrl(item.url) : null;
    if (link === null) errors.push(`evidence[${index}].url: must be a valid http(s) URL`);
    return label && link ? [{ label, url: link }] : [];
  });
}

function parseFields(raw: Record<string, unknown>, excluded: string[], patch: boolean): Partial<MilestoneFields> {
  const errors: string[] = [];
  const allowed = new Set<string>([...KEYS, ...excluded, ...(patch ? ["revision"] : [])]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) errors.push(`${key}: unexpected field`);
  }
  if (patch && !KEYS.some((key) => key in raw)) errors.push("patch: provide at least one milestone field");
  const result: Partial<MilestoneFields> = {};
  if (!patch || "title" in raw) {
    const title = text(raw.title, 200, "title", errors);
    if (title) result.title = title;
  }
  if ("description" in raw) result.description = text(raw.description, 10000, "description", errors, true);
  if ("targetDate" in raw) result.targetDate = date(raw.targetDate, errors);
  if ("criteria" in raw) result.criteria = criteria(raw.criteria, errors);
  if ("issueIds" in raw) result.issueIds = issueIds(raw.issueIds, errors);
  if ("evidence" in raw) result.evidence = evidence(raw.evidence, errors);
  if ("status" in raw) {
    if (!STATUSES.includes(raw.status as MilestoneStatus)) errors.push("status: must be planned, in_progress, completed or cancelled");
    else result.status = raw.status as MilestoneStatus;
  }
  if (errors.length) throw new InvalidMilestoneError(errors);
  return result;
}

export function parseMilestoneCreate(raw: Record<string, unknown>, excluded: string[] = []): MilestoneFields {
  const parsed = parseFields(raw, excluded, false);
  if (parsed.status === "completed") throw new InvalidMilestoneError(["status: milestones must be created before they can be completed"]);
  return {
    title: parsed.title!,
    description: parsed.description ?? null,
    targetDate: parsed.targetDate ?? null,
    status: parsed.status ?? "planned",
    criteria: parsed.criteria ?? ((): MilestoneCriterion[] => { throw new InvalidMilestoneError(["criteria: at least one explicit acceptance criterion is required"]); })(),
    issueIds: parsed.issueIds ?? [],
    evidence: parsed.evidence ?? [],
  };
}

export function parseMilestonePatch(raw: Record<string, unknown>, excluded: string[] = []): MilestonePatch {
  const parsed = parseFields(raw, excluded, true);
  if (typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 1)
    throw new InvalidMilestoneError(["revision: the current positive integer revision is required"]);
  return { ...parsed, revision: raw.revision };
}
