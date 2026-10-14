import { tool, uuid, UUID_RE } from './tool-schema.mjs';

/**
 * Project Dashboards tools (dashboards and the per-project changelog): input
 * validation, request construction and result mapping for the board REST API of the
 * journeystudios.project-dashboards plugin. Nothing here performs I/O; the bridge owns
 * transport, timeouts and the concurrency limit.
 */

export const DASHBOARD_PLUGIN_KEY = 'journeystudios.project-dashboards';
export const DASHBOARD_API_PREFIX = `/api/plugins/${DASHBOARD_PLUGIN_KEY}/api`;
// The host rejects bodies above 1,000,000 bytes; stay below it.
export const MAX_REQUEST_BODY_BYTES = 950_000;
export const MAX_ROWS = 10_000;
export const MAX_COLUMNS = 200;
export const MAX_DETAIL_LINES = 50;
export const MAX_MESSAGE_CHARS = 300;

const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const DATASET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
// Kinds written by agents and the board; the plugin generates "issue" entries itself and refuses it on writes.
export const CURATED_KINDS = ['milestone', 'release', 'feature', 'fix', 'improvement', 'decision', 'incident', 'note'];
export const ALL_KINDS = [...CURATED_KINDS, 'issue'];
export const MAX_CHANGELOG_PAGE = 500;
const CLIENT_ERROR_STATUSES = new Set([400, 404, 413, 422]);
const HEALTH_VALUES = new Set(['fresh', 'stale', 'unknown']);

export const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isPlainObject = (value) => {
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
export const boundedString = (min, max) => (value) => typeof value === 'string' && value.length >= min && value.length <= max;

/** Input rejected by the bridge before any HTTP call. The message is bridge-authored and safe to return. */
export class DashboardInputError extends Error {}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
export const IDEMPOTENT_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Adds a new record every call, so repeating it duplicates the entry.
const ADDITIVE_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const slugSchema = {
  type: 'string',
  pattern: '^[a-z0-9-]{1,64}$',
  description: 'Dashboard slug: lowercase letters, digits and hyphens, 1-64 characters.',
};
const datasetIdSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{1,64}$',
  description: 'Dataset id, a key of spec.datasets.',
};
const specSchema = (description) => ({ type: 'object', description });

const ISO_DATE_RULE = {
  check: (value) => typeof value === 'string' && value.length <= 64 && ISO_DATE_RE.test(value) && Number.isFinite(Date.parse(value)),
  hint: 'must be an ISO 8601 date or timestamp string, e.g. 2026-10-13T12:00:00Z',
};
const isHttpUrl = (value) => {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
};
const isLink = (value) => isPlainObject(value)
  && Object.keys(value).every((key) => key === 'label' || key === 'url')
  && boundedString(1, 100)(value.label) && isHttpUrl(value.url);
const changelogText = (max) => ({ check: boundedString(1, max), hint: `must be a string of 1-${max} characters` });
const nullable = (rule) => ({ check: (value) => value === null || rule.check(value), hint: `${rule.hint}, or null to clear it` });

const FIELD_RULES = {
  slug: { check: (value) => typeof value === 'string' && SLUG_RE.test(value), hint: 'must match ^[a-z0-9-]{1,64}$' },
  datasetId: { check: (value) => typeof value === 'string' && DATASET_ID_RE.test(value), hint: 'must match ^[A-Za-z0-9_-]{1,64}$' },
  uuid: { check: (value) => typeof value === 'string' && UUID_RE.test(value), hint: 'must be a UUID' },
  projectId: {
    check: (value) => typeof value === 'string' && UUID_RE.test(value),
    hint: 'must be a project UUID (null is not accepted: every dashboard belongs to a project)',
  },
  title: { check: boundedString(1, 200), hint: 'must be a string of 1-200 characters' },
  description: { check: boundedString(0, 10_000), hint: 'must be a string of at most 10000 characters' },
  source: { check: boundedString(0, 500), hint: 'must be a string of at most 500 characters' },
  updatedAt: ISO_DATE_RULE,
  occurredAt: ISO_DATE_RULE,
  spec: { check: isPlainObject, hint: 'must be a JSON object' },
  rows: {
    check: (value) => Array.isArray(value) && value.length <= MAX_ROWS && value.every(isPlainObject),
    hint: `must be an array of at most ${MAX_ROWS} objects`,
  },
  columns: {
    check: (value) => Array.isArray(value) && value.length <= MAX_COLUMNS && value.every(boundedString(1, 200)),
    hint: `must be an array of at most ${MAX_COLUMNS} non-empty strings (max 200 characters each)`,
  },
  curatedKind: {
    check: (value) => CURATED_KINDS.includes(value),
    hint: `must be one of ${CURATED_KINDS.join(', ')} (issue entries are created automatically from completed issues)`,
  },
  kinds: {
    check: (value) => Array.isArray(value) && value.length <= ALL_KINDS.length && value.every((kind) => ALL_KINDS.includes(kind)),
    hint: `must be an array of changelog kinds (${ALL_KINDS.join(', ')})`,
  },
  includeIssues: { check: (value) => typeof value === 'boolean', hint: 'must be true or false' },
  cursor: { check: boundedString(1, 200), hint: 'must be the nextCursor string of a previous response (at most 200 characters)' },
  pageSize: {
    check: (value) => Number.isInteger(value) && value >= 1 && value <= MAX_CHANGELOG_PAGE,
    hint: `must be an integer from 1 to ${MAX_CHANGELOG_PAGE}`,
  },
  entryBody: changelogText(20_000),
  nullableBody: nullable(changelogText(20_000)),
  entryVersion: changelogText(64),
  nullableVersion: nullable(changelogText(64)),
  refs: {
    check: (value) => Array.isArray(value) && value.length <= 20 && value.every(boundedString(1, 100)),
    hint: 'must be an array of at most 20 strings of 1-100 characters',
  },
  links: {
    check: (value) => Array.isArray(value) && value.length <= 20 && value.every(isLink),
    hint: 'must be an array of at most 20 {label, url} objects (label 1-100 characters, url an absolute http or https URL of at most 2000 characters)',
  },
};

const route = (...segments) => ['/dashboards', ...segments.map(encodeURIComponent)].join('/');
const changelogRoute = (...segments) => ['/changelog', ...segments.map(encodeURIComponent)].join('/');
const pick = (input, keys) => Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
const CHANGELOG_FIELDS = ['kind', 'title', 'body', 'version', 'refs', 'links', 'occurredAt'];

const DEFINITIONS = new Map([
  ['paperclipListDashboards', {
    fields: { projectId: 'uuid' },
    required: [],
    build: (input) => ({
      method: 'GET',
      path: route(),
      params: input.projectId === undefined ? {} : { projectId: input.projectId },
    }),
  }],
  ['paperclipGetDashboard', {
    fields: { slug: 'slug' },
    required: ['slug'],
    build: (input) => ({ method: 'GET', path: route(input.slug), params: {} }),
  }],
  ['paperclipDashboardStatus', {
    fields: { slug: 'slug' },
    required: ['slug'],
    build: (input) => ({ method: 'GET', path: route(input.slug, 'status'), params: {} }),
  }],
  ['paperclipUpsertDashboard', {
    fields: { slug: 'slug', title: 'title', projectId: 'projectId', spec: 'spec' },
    required: ['slug', 'spec'],
    build: (input) => ({
      method: 'POST',
      path: route(),
      params: {},
      body: {
        slug: input.slug,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        spec: input.spec,
      },
    }),
  }],
  ['paperclipUpdateDashboardDataset', {
    fields: {
      slug: 'slug', datasetId: 'datasetId', rows: 'rows', columns: 'columns',
      description: 'description', source: 'source', updatedAt: 'updatedAt',
    },
    required: ['slug', 'datasetId', 'rows'],
    build: (input) => ({
      method: 'POST',
      path: route(input.slug, 'datasets', input.datasetId),
      params: {},
      body: Object.fromEntries(['rows', 'columns', 'description', 'source', 'updatedAt']
        .filter((key) => input[key] !== undefined).map((key) => [key, input[key]])),
    }),
  }],
  ['paperclipMoveDashboard', {
    fields: { slug: 'slug', projectId: 'projectId' },
    required: ['slug', 'projectId'],
    build: (input) => ({ method: 'POST', path: route(input.slug, 'project'), params: {}, body: { projectId: input.projectId } }),
  }],
  ['paperclipValidateDashboardSpec', {
    fields: { spec: 'spec' },
    required: ['spec'],
    build: (input) => ({ method: 'POST', path: '/validate', params: {}, body: { spec: input.spec } }),
  }],
  ['paperclipListChangelog', {
    fields: { projectId: 'uuid', kinds: 'kinds', includeIssues: 'includeIssues', before: 'cursor', limit: 'pageSize' },
    required: [],
    build: (input) => ({
      method: 'GET',
      path: changelogRoute(),
      params: {
        ...pick(input, ['projectId', 'includeIssues', 'before', 'limit']),
        ...(input.kinds?.length ? { kind: input.kinds.join(',') } : {}),
      },
    }),
  }],
  ['paperclipAddChangelogEntry', {
    fields: {
      projectId: 'uuid', kind: 'curatedKind', title: 'title', body: 'entryBody', version: 'entryVersion',
      refs: 'refs', links: 'links', occurredAt: 'occurredAt',
    },
    required: ['projectId', 'kind', 'title'],
    build: (input) => ({ method: 'POST', path: changelogRoute(), params: {}, body: pick(input, ['projectId', ...CHANGELOG_FIELDS]) }),
  }],
  ['paperclipUpdateChangelogEntry', {
    fields: {
      entryId: 'uuid', kind: 'curatedKind', title: 'title', body: 'nullableBody', version: 'nullableVersion',
      refs: 'refs', links: 'links', occurredAt: 'occurredAt',
    },
    required: ['entryId'],
    atLeastOne: CHANGELOG_FIELDS,
    build: (input) => ({ method: 'POST', path: changelogRoute(input.entryId), params: {}, body: pick(input, CHANGELOG_FIELDS) }),
  }],
  ['paperclipImportChangelogFromIssues', {
    fields: { projectId: 'uuid' },
    required: ['projectId'],
    build: (input) => ({ method: 'POST', path: changelogRoute('import'), params: {}, body: { projectId: input.projectId } }),
  }],
]);

const CHANGELOG_GUIDE = 'Record an entry when something relevant closes (a merged PR, a validated deploy, a milestone, a decision, an incident or a release): one entry per relevant change, not one per run or commit. Title it with the result, put what changed and why in body (Markdown), and put issue identifiers, PR numbers or commit SHAs in refs. Completed issues already enter the changelog on their own, so do not record an entry that only repeats one.';
const entryFields = {
  kind: { type: 'string', enum: CURATED_KINDS, description: 'What the entry records.' },
  title: { type: 'string', minLength: 1, maxLength: 200, description: 'The result, in one line.' },
  refs: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 100 }, description: 'Issue identifiers (e.g. ABC-12), PR numbers or commit SHAs.' },
  links: {
    type: 'array',
    maxItems: 20,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['label', 'url'],
      properties: { label: { type: 'string', minLength: 1, maxLength: 100 }, url: { type: 'string', maxLength: 2000, description: 'Absolute http or https URL.' } },
    },
  },
  occurredAt: { type: 'string', maxLength: 64, description: 'ISO 8601 date or timestamp of the event; defaults to now.' },
};

export const DASHBOARD_TOOLS = [
  tool('paperclipListDashboards',
    'List the Project Dashboards of the configured Paperclip company. Dashboards are grouped by project: each result carries id, slug, title, projectId and projectName, revision, updatedAt/updatedBy and viewPath (a path under the Paperclip web origin), and the projectId input limits the list to one project. Specs are not included; use paperclipGetDashboard for one.',
    { projectId: { ...uuid, description: 'Only dashboards linked to this Paperclip project.' } },
    [], READ_ONLY),
  tool('paperclipGetDashboard',
    'Get one Project Dashboard by slug with its full declarative spec. Read it before changing a dashboard, or reuse it as a working example. For data freshness use paperclipDashboardStatus.',
    { slug: slugSchema }, ['slug'], READ_ONLY),
  tool('paperclipDashboardStatus',
    'Live status of one Project Dashboard: health (fresh, stale or unknown) from dataset freshness, stale dataset count, per-dataset rows, updatedAt, ageMinutes and staleAfterHours, plus section and block counts. Use it to find datasets to refresh with paperclipUpdateDashboardDataset.',
    { slug: slugSchema }, ['slug'], READ_ONLY),
  tool('paperclipUpsertDashboard',
    'Create or replace a Project Dashboard by slug (idempotent; every save bumps the revision). spec is declarative JSON: {version: 1, title, summary?, datasets: {<id>: {title, description, source, updatedAt (ISO), columns?, rows[]}}, sections: [{id, title?, blocks[]}]}. A block has a type: markdown, mermaid, callout, kpis, chart, table or statusList. Numbers come from datasets, never typed into text, and every dataset needs title, description, source and updatedAt. Dry-run with paperclipValidateDashboardSpec first; refresh numbers later with paperclipUpdateDashboardDataset. Every dashboard belongs to a Paperclip project (Paperclip groups dashboards by project): projectId is required when creating one; for an existing dashboard omit it to leave it where it is (in its project, or without one), or pass a project UUID to move it. Dashboards cannot be deleted here.',
    {
      slug: slugSchema,
      title: { type: 'string', minLength: 1, maxLength: 200, description: 'Optional display title; defaults to the spec title.' },
      projectId: { ...uuid, description: 'Project UUID. Required when creating a dashboard; on an existing one omit it to leave it where it is, or pass a UUID to move it.' },
      spec: specSchema('Dashboard spec (declarative JSON).'),
    },
    ['slug', 'spec'], IDEMPOTENT_WRITE),
  tool('paperclipUpdateDashboardDataset',
    'Replace the rows of one existing dataset of a Project Dashboard without resending its spec, and stamp updatedAt (default: now) so freshness and health reflect the refresh. Optionally update columns, description and source. Fails with not_found if the dashboard or dataset does not exist. Idempotent.',
    {
      slug: slugSchema,
      datasetId: datasetIdSchema,
      rows: { type: 'array', maxItems: MAX_ROWS, items: { type: 'object' }, description: 'New rows: objects with string, number, boolean or null cells.' },
      columns: { type: 'array', maxItems: MAX_COLUMNS, items: { type: 'string', minLength: 1, maxLength: 200 }, description: 'Optional column names, in display order.' },
      description: { type: 'string', maxLength: 10_000, description: 'Optional dataset description.' },
      source: { type: 'string', maxLength: 500, description: 'Optional data source (URL or short text).' },
      updatedAt: { type: 'string', maxLength: 64, description: 'Optional ISO 8601 date-time of the data, e.g. 2026-10-13T12:00:00Z; defaults to now.' },
    },
    ['slug', 'datasetId', 'rows'], IDEMPOTENT_WRITE),
  tool('paperclipValidateDashboardSpec',
    'Dry run: validate a Project Dashboard spec and save nothing. Returns {valid: true, datasets, sections} or an error listing up to 50 path-precise problems to fix. Call it before paperclipUpsertDashboard.',
    { spec: specSchema('Dashboard spec (declarative JSON) to validate.') },
    ['spec'], READ_ONLY),
  tool('paperclipListChangelog',
    'Read the Project Dashboards changelog, newest first: the dated evolution of one project or of the whole company (entries of kind milestone, release, feature, fix, improvement, decision, incident, note, plus issue entries generated from completed issues). Use it to see what changed in a project or to check what is already recorded before adding an entry. Returns {entries, nextCursor}; pass nextCursor as before for older entries. Optional filters: projectId, kinds, includeIssues (false hides the generated issue entries), limit (1-500, default 50).',
    {
      projectId: { ...uuid, description: 'Only this Paperclip project; omit for every project of the company.' },
      kinds: { type: 'array', maxItems: ALL_KINDS.length, items: { type: 'string', enum: ALL_KINDS }, description: 'Only these kinds.' },
      includeIssues: { type: 'boolean', description: 'Include entries generated from completed issues (default true).' },
      before: { type: 'string', maxLength: 200, description: 'The nextCursor of the previous response.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_CHANGELOG_PAGE, description: 'Entries to return (default 50).' },
    },
    [], READ_ONLY),
  tool('paperclipAddChangelogEntry',
    `Add one entry to a project's changelog. NOT idempotent: every call creates a new entry, so call it once per change and do not retry blindly (list the changelog first if unsure). ${CHANGELOG_GUIDE} Entries cannot be deleted here; correct one with paperclipUpdateChangelogEntry.`,
    {
      projectId: { ...uuid, description: 'The Paperclip project the entry belongs to.' },
      ...entryFields,
      body: { type: 'string', minLength: 1, maxLength: 20_000, description: 'Markdown: what changed and why.' },
      version: { type: 'string', minLength: 1, maxLength: 64, description: 'Release or version label, such as v1.4.0.' },
    },
    ['projectId', 'kind', 'title'], ADDITIVE_WRITE),
  tool('paperclipUpdateChangelogEntry',
    'Correct or complete a changelog entry written by hand: send entryId (from paperclipListChangelog) and only the fields to change; null clears body or version. The project cannot be changed, and entries generated from completed issues cannot be edited. Idempotent.',
    {
      entryId: { ...uuid, description: 'The changelog entry to update.' },
      ...entryFields,
      body: { type: ['string', 'null'], minLength: 1, maxLength: 20_000, description: 'Markdown; null removes it.' },
      version: { type: ['string', 'null'], minLength: 1, maxLength: 64, description: 'Version label; null removes it.' },
    },
    ['entryId'], IDEMPOTENT_WRITE),
  tool('paperclipImportChangelogFromIssues',
    'Backfill or reconcile one project: add the completed (done) issues that have no changelog entry yet. Completed issues are normally added automatically, but events can be missed while Paperclip restarts, so run this after downtime or to fill a new project. Idempotent; never duplicates and never brings back an entry the board deleted. Honors the company setting (top-level issues only, or sub-issues too). Returns {scanned, imported, skipped, truncated}; truncated means 1000 issues were read and older ones may be missing.',
    { projectId: { ...uuid, description: 'The Paperclip project to import into.' } },
    ['projectId'], IDEMPOTENT_WRITE),
];

/**
 * Moves a dashboard between projects. It is a Project Dashboards plugin call and shares this module's
 * request building and result handling, but it is listed with the roadmap tools (see roadmap.mjs).
 */
export const MOVE_DASHBOARD_TOOL = tool('paperclipMoveDashboard',
  'Move an existing Project Dashboard to another Paperclip project of the configured company, by slug. Projects group dashboards, so use this to rehome a dashboard, including one that has no project. The spec is untouched; the move is stored as a new revision and logged as activity. The target project must exist in this company and not be archived. Returns {moved, dashboard}; moved is false, with no new revision, when the dashboard is already in that project. To create or edit a dashboard use paperclipUpsertDashboard. Idempotent.',
  {
    slug: slugSchema,
    projectId: { ...uuid, description: 'The project to move the dashboard into (an active project of this company).' },
  },
  ['slug', 'projectId'], IDEMPOTENT_WRITE);

export const isDashboardTool = (name) => DEFINITIONS.has(name);

function reject(message) {
  throw new DashboardInputError(`Invalid input: ${message}`);
}

/**
 * Validate tool input strictly and build the plugin request. Throws
 * DashboardInputError before anything touches the network. The company is never
 * part of the input; the bridge always adds it from its own configuration.
 */
export function buildDashboardRequest(name, rawInput) {
  const definition = DEFINITIONS.get(name);
  if (!definition) reject('unknown tool.');
  if (!isPlainObject(rawInput)) reject('arguments must be an object.');
  const allowed = Object.keys(definition.fields);
  for (const key of Object.keys(rawInput)) {
    if (!allowed.includes(key)) reject(`unexpected field. Allowed fields: ${allowed.join(', ')}.`);
  }
  for (const key of definition.required) {
    if (rawInput[key] === undefined) reject(`${key} is required.`);
  }
  if (definition.atLeastOne && !definition.atLeastOne.some((key) => rawInput[key] !== undefined)) {
    reject(`at least one of ${definition.atLeastOne.join(', ')} is required.`);
  }
  for (const [key, ruleName] of Object.entries(definition.fields)) {
    const value = rawInput[key];
    if (value === undefined) continue;
    const rule = FIELD_RULES[ruleName];
    if (!rule.check(value)) reject(`${key} ${rule.hint}.`);
  }
  const { method, path, params, body } = definition.build(rawInput);
  let bodyText;
  if (body !== undefined) {
    try { bodyText = JSON.stringify(body); } catch { reject('request body is not valid JSON.'); }
    if (Buffer.byteLength(bodyText, 'utf8') > MAX_REQUEST_BODY_BYTES) {
      reject(`request body is larger than ${MAX_REQUEST_BODY_BYTES} bytes. Send less data per call (for example refresh large datasets with separate paperclipUpdateDashboardDataset calls).`);
    }
  }
  return { method, path: `${DASHBOARD_API_PREFIX}${path}`, params, bodyText };
}

export const textResult = (text, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }] });

export const dashboardInputErrorResult = (message) => textResult(message, true);
export const dashboardFailureResult = () => textResult('Project Dashboards request failed. Check bridge configuration and plugin availability.', true);
export const dashboardBusyResult = () => textResult('Project Dashboards is busy; retry shortly.', true);
const unavailableResult = () => textResult('Project Dashboards plugin unavailable. Check that it is installed and enabled for this company; other Paperclip tools are unaffected.', true);

/** One printable line: control characters collapsed, bounded length. */
export function clean(value, max = MAX_MESSAGE_CHARS) {
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function statusLine(status) {
  if (!isRecord(status)) return null;
  const text = (value, max) => (typeof value === 'string' ? clean(value, max) : '?');
  const count = (value) => (Number.isFinite(value) ? value : '?');
  const health = HEALTH_VALUES.has(status.health) ? status.health : '?';
  return `Dashboard "${text(status.title, 120)}": revision ${count(status.revision)}, health ${health}, ${count(status.staleCount)} stale dataset(s), updated ${text(status.updatedAt, 40)}`;
}

function clientErrorResult(status, body) {
  const lines = [`Project Dashboards rejected the request (HTTP ${status}): ${clean(body.error)}`];
  if (status === 413 && Number.isSafeInteger(body.limitBytes)) lines[0] += ` (limit ${body.limitBytes} bytes)`;
  if (status === 422 && Array.isArray(body.details)) {
    const details = body.details.filter((detail) => typeof detail === 'string');
    for (const detail of details.slice(0, MAX_DETAIL_LINES)) lines.push(`- ${clean(detail)}`);
    if (details.length > MAX_DETAIL_LINES) lines.push(`- (${details.length - MAX_DETAIL_LINES} more not shown)`);
  }
  return textResult(lines.join('\n'), true);
}

function successResult(name, body) {
  const { companyId: _pinned, ...payload } = body;
  const content = [];
  if (name === 'paperclipDashboardStatus') {
    const line = statusLine(payload.status);
    if (line) content.push({ type: 'text', text: line });
  }
  content.push({ type: 'text', text: JSON.stringify(payload) });
  return { content };
}

/**
 * Map a plugin HTTP response to an MCP tool result. Only the plugin's documented
 * client errors (400/404/413/422 with the pinned companyId and a string `error`)
 * are surfaced; everything else (5xx, auth, unknown, company mismatch) is generic.
 */
export function dashboardToolResult(name, response, companyId) {
  const { status, ok, text } = response;
  if (status === 503) return unavailableResult();
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  // The host answers an unknown plugin or route without a company echo; the plugin's
  // own "not_found" always carries the company, so the two cannot be confused.
  if (status === 404 && !(isRecord(body) && Object.hasOwn(body, 'companyId'))) return unavailableResult();
  if (!isRecord(body) || body.companyId !== companyId) return dashboardFailureResult();
  if (ok) return successResult(name, body);
  if (CLIENT_ERROR_STATUSES.has(status) && typeof body.error === 'string') return clientErrorResult(status, body);
  return dashboardFailureResult();
}
