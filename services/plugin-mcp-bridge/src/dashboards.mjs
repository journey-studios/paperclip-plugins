import { tool, uuid, UUID_RE } from './tool-schema.mjs';

/**
 * Project Dashboards tools: input validation, request construction and result
 * mapping for the board REST API of the journeystudios.project-dashboards plugin.
 * Nothing here performs I/O; the bridge owns transport, timeouts and the
 * concurrency limit.
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
const CLIENT_ERROR_STATUSES = new Set([400, 404, 413, 422]);
const HEALTH_VALUES = new Set(['fresh', 'stale', 'unknown']);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPlainObject = (value) => {
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const boundedString = (min, max) => (value) => typeof value === 'string' && value.length >= min && value.length <= max;

/** Input rejected by the bridge before any HTTP call. The message is bridge-authored and safe to return. */
export class DashboardInputError extends Error {}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const IDEMPOTENT_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

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
  updatedAt: {
    check: (value) => typeof value === 'string' && value.length <= 64 && ISO_DATE_RE.test(value) && Number.isFinite(Date.parse(value)),
    hint: 'must be an ISO 8601 date or timestamp string, e.g. 2026-10-13T12:00:00Z',
  },
  spec: { check: isPlainObject, hint: 'must be a JSON object' },
  rows: {
    check: (value) => Array.isArray(value) && value.length <= MAX_ROWS && value.every(isPlainObject),
    hint: `must be an array of at most ${MAX_ROWS} objects`,
  },
  columns: {
    check: (value) => Array.isArray(value) && value.length <= MAX_COLUMNS && value.every(boundedString(1, 200)),
    hint: `must be an array of at most ${MAX_COLUMNS} non-empty strings (max 200 characters each)`,
  },
};

const route = (...segments) => ['/dashboards', ...segments.map(encodeURIComponent)].join('/');

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
  ['paperclipValidateDashboardSpec', {
    fields: { spec: 'spec' },
    required: ['spec'],
    build: (input) => ({ method: 'POST', path: '/validate', params: {}, body: { spec: input.spec } }),
  }],
]);

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
];

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

const textResult = (text, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }] });

export const dashboardInputErrorResult = (message) => textResult(message, true);
export const dashboardFailureResult = () => textResult('Project Dashboards request failed. Check bridge configuration and plugin availability.', true);
export const dashboardBusyResult = () => textResult('Project Dashboards is busy; retry shortly.', true);
const unavailableResult = () => textResult('Project Dashboards plugin unavailable. Check that it is installed and enabled for this company; other Paperclip tools are unaffected.', true);

/** One printable line: control characters collapsed, bounded length. */
function clean(value, max = MAX_MESSAGE_CHARS) {
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
