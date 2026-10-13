import {
  CHANGELOG_KINDS,
  CURATED_KINDS,
  type ChangelogKind,
  type ChangelogLink,
  type CuratedKind,
} from "./contracts.js";
import { DashboardError } from "./errors.js";
import { isRecord } from "./keys.js";
import { safeHttpUrl } from "./safe-url.js";

export const LIMITS = {
  title: 200,
  body: 20_000,
  version: 64,
  refs: 20,
  ref: 100,
  links: 20,
  label: 100,
  url: 2000,
  kinds: CHANGELOG_KINDS.length,
  cursor: 200,
  pageDefault: 50,
  pageMax: 500,
} as const;

/** The curated fields of an entry after validation; occurredAt is a normalized ISO string. */
export interface EntryFields {
  kind: CuratedKind;
  title: string;
  body: string | null;
  version: string | null;
  refs: string[];
  links: ChangelogLink[];
  occurredAt: string;
}

export type EntryPatch = Partial<EntryFields>;

/** Field-level problems of a changelog write, each prefixed with the path of the field. */
export class InvalidEntryError extends DashboardError {
  constructor(readonly details: string[]) {
    super(`Invalid changelog entry:\n${details.map((detail) => `- ${detail}`).join("\n")}`);
  }
}

const FIELD_KEYS = ["kind", "title", "body", "version", "refs", "links", "occurredAt"] as const;
const ISO_START = /^\d{4}-\d{2}-\d{2}/;

export function isCuratedKind(value: unknown): value is CuratedKind {
  return CURATED_KINDS.some((kind) => kind === value);
}

export function isChangelogKind(value: unknown): value is ChangelogKind {
  return CHANGELOG_KINDS.some((kind) => kind === value);
}

/** A valid ISO 8601 instant (any offset) in a range Postgres and JavaScript both accept, as a normalized string. */
export function parseInstant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64 || !ISO_START.test(value)) {
    return null;
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    return null;
  }
  const date = new Date(time);
  return date.getUTCFullYear() >= 1970 && date.getUTCFullYear() <= 9999 ? date.toISOString() : null;
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text.length >= 1 && text.length <= max ? text : null;
}

function parseRefs(value: unknown, problems: string[]): string[] | undefined {
  if (!Array.isArray(value) || value.length > LIMITS.refs) {
    problems.push(`refs: must be an array of at most ${LIMITS.refs} strings`);
    return undefined;
  }
  const refs: string[] = [];
  value.forEach((item, index) => {
    const ref = boundedText(item, LIMITS.ref);
    if (ref === null) {
      problems.push(`refs[${index}]: must be a string of 1-${LIMITS.ref} characters`);
    } else {
      refs.push(ref);
    }
  });
  return refs;
}

function parseLink(value: unknown, index: number, problems: string[]): ChangelogLink | null {
  const path = `links[${index}]`;
  if (!isRecord(value)) {
    problems.push(`${path}: must be an object with label and url`);
    return null;
  }
  const before = problems.length;
  for (const key of Object.keys(value)) {
    if (key !== "label" && key !== "url") {
      problems.push(`${path}.${key}: unexpected field (allowed: label, url)`);
    }
  }
  const label = boundedText(value.label, LIMITS.label);
  if (label === null) {
    problems.push(`${path}.label: must be a string of 1-${LIMITS.label} characters`);
  }
  const url = typeof value.url === "string" && value.url.length <= LIMITS.url ? safeHttpUrl(value.url) : null;
  if (url === null) {
    problems.push(`${path}.url: must be an absolute http or https URL of at most ${LIMITS.url} characters`);
  }
  return label !== null && url !== null && problems.length === before ? { label, url } : null;
}

function parseLinks(value: unknown, problems: string[]): ChangelogLink[] | undefined {
  if (!Array.isArray(value) || value.length > LIMITS.links) {
    problems.push(`links: must be an array of at most ${LIMITS.links} {label, url} objects`);
    return undefined;
  }
  const links: ChangelogLink[] = [];
  value.forEach((item, index) => {
    const link = parseLink(item, index, problems);
    if (link) {
      links.push(link);
    }
  });
  return links;
}

/** null clears an optional text field; blank text is rejected rather than silently stored. */
function parseOptionalText(value: unknown, field: "body" | "version", problems: string[]): string | null | undefined {
  if (value === null) {
    return null;
  }
  const max = LIMITS[field];
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length >= 1 && text.length <= max) {
    return text;
  }
  problems.push(`${field}: must be a string of 1-${max} characters, or null to clear it`);
  return undefined;
}

/**
 * Validate the entry fields present in `input`. Keys named in `handledBy` belong to the
 * caller (for example projectId) and are skipped; any other key is rejected. Every problem
 * is collected so a caller can fix the whole request at once.
 */
function readFields(input: Record<string, unknown>, handledBy: readonly string[], problems: string[]): EntryPatch {
  const out: EntryPatch = {};
  for (const key of Object.keys(input)) {
    if (!handledBy.includes(key) && !FIELD_KEYS.some((field) => field === key)) {
      problems.push(`${key}: unexpected field (allowed: ${[...handledBy, ...FIELD_KEYS].join(", ")})`);
    }
  }
  if (input.kind !== undefined) {
    if (isCuratedKind(input.kind)) {
      out.kind = input.kind;
    } else if (input.kind === "issue") {
      problems.push(`kind: "issue" entries are created automatically when an issue is completed; choose one of ${CURATED_KINDS.join(", ")}`);
    } else {
      problems.push(`kind: must be one of ${CURATED_KINDS.join(", ")}`);
    }
  }
  if (input.title !== undefined) {
    const title = boundedText(input.title, LIMITS.title);
    if (title === null) {
      problems.push(`title: must be a string of 1-${LIMITS.title} characters`);
    } else {
      out.title = title;
    }
  }
  for (const field of ["body", "version"] as const) {
    if (input[field] !== undefined) {
      const text = parseOptionalText(input[field], field, problems);
      if (text !== undefined) {
        out[field] = text;
      }
    }
  }
  if (input.refs !== undefined) {
    out.refs = parseRefs(input.refs, problems);
  }
  if (input.links !== undefined) {
    out.links = parseLinks(input.links, problems);
  }
  if (input.occurredAt !== undefined) {
    const occurredAt = parseInstant(input.occurredAt);
    if (occurredAt === null) {
      problems.push("occurredAt: must be an ISO 8601 date or timestamp such as 2026-10-13T12:00:00Z");
    } else {
      out.occurredAt = occurredAt;
    }
  }
  return out;
}

/** New entry: kind and title are required; everything else is optional (occurredAt defaults to now). */
export function parseNewEntry(input: Record<string, unknown>, handledBy: readonly string[], now: Date): EntryFields {
  const problems: string[] = [];
  const fields = readFields(input, handledBy, problems);
  if (input.kind === undefined) {
    problems.push(`kind: is required (one of ${CURATED_KINDS.join(", ")})`);
  }
  if (input.title === undefined) {
    problems.push("title: is required");
  }
  if (problems.length > 0 || fields.kind === undefined || fields.title === undefined) {
    throw new InvalidEntryError(problems);
  }
  return {
    kind: fields.kind,
    title: fields.title,
    body: fields.body ?? null,
    version: fields.version ?? null,
    refs: fields.refs ?? [],
    links: fields.links ?? [],
    occurredAt: fields.occurredAt ?? now.toISOString(),
  };
}

/** Update: at least one field; null in body/version clears it. */
export function parseEntryPatch(input: Record<string, unknown>, handledBy: readonly string[]): EntryPatch {
  const problems: string[] = [];
  const patch = readFields(input, handledBy, problems);
  if (!FIELD_KEYS.some((key) => input[key] !== undefined)) {
    problems.push(`at least one of ${FIELD_KEYS.join(", ")} is required`);
  }
  if (problems.length > 0) {
    throw new InvalidEntryError(problems);
  }
  return patch;
}
