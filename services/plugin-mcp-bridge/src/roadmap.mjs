import { tool, uuid, UUID_RE } from './tool-schema.mjs';
import {
  IDEMPOTENT_WRITE, MOVE_DASHBOARD_TOOL, boundedString, clean, isPlainObject, isRecord, textResult,
} from './dashboards.mjs';

/**
 * Roadmap tools: projects and goals through the core Paperclip REST API, plus
 * paperclipMoveDashboard (a Project Dashboards plugin call, handled in dashboards.mjs).
 *
 * Nothing here talks to the network on its own: runRoadmapTool receives an `api` object
 * ({ companyId, request(pathname, { method, body }) }) from the bridge, which owns the
 * bearer key, timeouts and the concurrency limit. The company is always the one pinned at
 * deployment and never part of any tool input. The host's own schemas are not strict (unknown
 * fields are silently ignored), so every write is read back and compared with what was asked.
 */

// Copies of the host constants (packages/shared/src/constants.ts); roadmap.test.mjs checks them
// against the vendored host source whenever it is present.
export const PROJECT_STATUSES = ['backlog', 'planned', 'in_progress', 'completed', 'cancelled'];
export const GOAL_LEVELS = ['company', 'team', 'agent', 'task'];
export const GOAL_STATUSES = ['planned', 'active', 'achieved', 'cancelled'];

const MAX_NAME_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 10_000;
const MAX_GOAL_IDS = 20;
export const MAX_ERROR_DETAIL_LINES = 20;

const CLIENT_ERROR_STATUSES = new Set([400, 404, 409, 422]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const ADDITIVE_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** Input rejected by the bridge before any HTTP call. The message is bridge-authored and safe to return. */
export class RoadmapInputError extends Error {}

/** Carries a finished MCP tool result out of a deep call, so the flows can simply throw. */
class ToolOutcome extends Error {
  constructor(result) {
    super('tool outcome');
    this.result = result;
  }
}

// ---------------------------------------------------------------------------------------------
// Input rules
// ---------------------------------------------------------------------------------------------

const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);
function isCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  // Date.parse rolls impossible days over (February 30 becomes March 2); the round trip catches that.
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
const nonBlankString = (min, max) => (value) => boundedString(min, max)(value) && value.trim().length > 0;
const nullable = (rule) => ({ check: (value) => value === null || rule.check(value), hint: `${rule.hint}, or null to clear it` });
const enumRule = (values) => ({ check: (value) => values.includes(value), hint: `must be one of ${values.join(', ')}` });

const RULES = {
  uuid: { check: isUuid, hint: 'must be a UUID' },
  nullableUuid: nullable({ check: isUuid, hint: 'must be a UUID' }),
  projectId: { check: isUuid, hint: 'must be a project UUID' },
  goalId: { check: isUuid, hint: 'must be a goal UUID' },
  name: { check: nonBlankString(1, MAX_NAME_CHARS), hint: `must be a non-blank string of 1-${MAX_NAME_CHARS} characters` },
  description: nullable({ check: boundedString(0, MAX_DESCRIPTION_CHARS), hint: `must be a string of at most ${MAX_DESCRIPTION_CHARS} characters` }),
  projectStatus: enumRule(PROJECT_STATUSES),
  goalLevel: enumRule(GOAL_LEVELS),
  goalStatus: enumRule(GOAL_STATUSES),
  goalIds: {
    check: (value) => Array.isArray(value) && value.length <= MAX_GOAL_IDS && value.every(isUuid)
      && new Set(value.map((id) => id.toLowerCase())).size === value.length,
    hint: `must be an array of at most ${MAX_GOAL_IDS} distinct goal UUIDs`,
  },
  targetDate: { check: isCalendarDate, hint: 'must be a calendar date formatted YYYY-MM-DD' },
  nullableTargetDate: nullable({ check: isCalendarDate, hint: 'must be a calendar date formatted YYYY-MM-DD' }),
  color: { check: (value) => typeof value === 'string' && COLOR_RE.test(value), hint: 'must be a color formatted #rrggbb' },
  nullableColor: nullable({ check: (value) => typeof value === 'string' && COLOR_RE.test(value), hint: 'must be a color formatted #rrggbb' }),
  idempotencyKey: { check: nonBlankString(1, 255), hint: 'must be a non-blank string of 1-255 characters' },
  archived: { check: (value) => typeof value === 'boolean', hint: 'must be true or false' },
};

const PROJECT_WRITE_FIELDS = ['name', 'description', 'status', 'goalIds', 'targetDate', 'color', 'leadAgentId'];
const GOAL_WRITE_FIELDS = ['title', 'description', 'level', 'status', 'parentId', 'ownerAgentId'];

const DEFINITIONS = new Map([
  ['paperclipCreateProject', {
    fields: {
      name: 'name', description: 'description', status: 'projectStatus', goalIds: 'goalIds', targetDate: 'targetDate',
      color: 'color', leadAgentId: 'nullableUuid', idempotencyKey: 'idempotencyKey',
    },
    required: ['name'],
  }],
  ['paperclipUpdateProject', {
    fields: {
      projectId: 'projectId', name: 'name', description: 'description', status: 'projectStatus', goalIds: 'goalIds',
      targetDate: 'nullableTargetDate', color: 'nullableColor', leadAgentId: 'nullableUuid', archived: 'archived',
    },
    required: ['projectId'],
    atLeastOne: [...PROJECT_WRITE_FIELDS, 'archived'],
  }],
  ['paperclipCreateGoal', {
    fields: {
      title: 'name', description: 'description', level: 'goalLevel', status: 'goalStatus', parentId: 'nullableUuid',
      ownerAgentId: 'nullableUuid',
    },
    required: ['title'],
  }],
  ['paperclipUpdateGoal', {
    fields: {
      goalId: 'goalId', title: 'name', description: 'description', level: 'goalLevel', status: 'goalStatus',
      parentId: 'nullableUuid', ownerAgentId: 'nullableUuid',
    },
    required: ['goalId'],
    atLeastOne: GOAL_WRITE_FIELDS,
    validate: (input) => {
      if (typeof input.parentId === 'string' && input.parentId.toLowerCase() === input.goalId.toLowerCase()) {
        return 'parentId cannot be the goal itself.';
      }
      return undefined;
    },
  }],
]);

// The move tool is a plugin call: dashboards.mjs validates and sends it.
const OWN_TOOLS = [...DEFINITIONS.keys()];
export const isRoadmapTool = (name) => DEFINITIONS.has(name);
export const ROADMAP_TOOL_NAMES = [...OWN_TOOLS, MOVE_DASHBOARD_TOOL.name];

function reject(message) {
  throw new RoadmapInputError(`Invalid input: ${message}`);
}

/** Validate tool input strictly. Throws RoadmapInputError before anything touches the network. */
export function parseRoadmapInput(name, rawInput) {
  const definition = DEFINITIONS.get(name);
  if (!definition) {
    reject('unknown tool.');
  }
  if (!isPlainObject(rawInput)) {
    reject('arguments must be an object.');
  }
  const allowed = Object.keys(definition.fields);
  for (const key of Object.keys(rawInput)) {
    if (!allowed.includes(key)) {
      reject(`unexpected field ${JSON.stringify(key.slice(0, 50))}. Allowed fields: ${allowed.join(', ')}.`);
    }
  }
  for (const key of definition.required) {
    if (rawInput[key] === undefined) {
      reject(`${key} is required.`);
    }
  }
  if (definition.atLeastOne && !definition.atLeastOne.some((key) => rawInput[key] !== undefined)) {
    reject(`at least one field besides the id is required: ${definition.atLeastOne.join(', ')}.`);
  }
  for (const [key, ruleName] of Object.entries(definition.fields)) {
    const value = rawInput[key];
    if (value === undefined) {
      continue;
    }
    const rule = RULES[ruleName];
    if (!rule.check(value)) {
      reject(`${key} ${rule.hint}.`);
    }
  }
  const problem = definition.validate?.(rawInput);
  if (problem) {
    reject(problem);
  }
  return rawInput;
}

// ---------------------------------------------------------------------------------------------
// Tool catalog
// ---------------------------------------------------------------------------------------------

const nullableUuidSchema = { type: ['string', 'null'], format: 'uuid' };
const descriptionSchema = (text) => ({ type: ['string', 'null'], maxLength: MAX_DESCRIPTION_CHARS, description: text });
const goalIdsSchema = (text) => ({ type: 'array', maxItems: MAX_GOAL_IDS, uniqueItems: true, items: uuid, description: text });

export const CREATE_PROJECT_TOOL = tool('paperclipCreateProject',
  'Create a Paperclip project in the configured company. Projects are the delivery unit of the roadmap: they group dashboards (paperclipUpsertDashboard, paperclipMoveDashboard), a changelog and issues, and can serve strategic goals (goalIds, see paperclipCreateGoal). List the existing projects first: a name that collides gets a numeric suffix such as " 2" and the result says so. status is backlog (default), planned, in_progress, completed or cancelled; targetDate is YYYY-MM-DD; color is #rrggbb. NOT idempotent: pass an idempotencyKey so a retry cannot create a second project. Creating a project wakes no agent. The result is the project read back from Paperclip, with warnings for any field that did not stick. Projects cannot be deleted or paused here.',
  {
    name: { type: 'string', minLength: 1, maxLength: MAX_NAME_CHARS, description: 'Project name.' },
    description: descriptionSchema('Markdown: the outcome and scope of the project; null for none.'),
    status: { type: 'string', enum: PROJECT_STATUSES, description: 'Roadmap status; defaults to backlog.' },
    goalIds: goalIdsSchema('Goals this project serves (IDs of goals in this company).'),
    targetDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Target date, YYYY-MM-DD.' },
    color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Display color, #rrggbb.' },
    leadAgentId: { ...nullableUuidSchema, description: 'The agent leading the project; null for none.' },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 255, description: 'Reuse the same key when retrying to get the already created project instead of a second one.' },
  },
  ['name'], ADDITIVE_WRITE);

export const UPDATE_PROJECT_TOOL = tool('paperclipUpdateProject',
  'Change a Paperclip project of the configured company: send projectId and only the fields to change. goalIds REPLACES the whole set of linked goals ([] unlinks all), so read the project first to keep the ones you want. description, targetDate, color and leadAgentId accept null to clear them. status moves the project along the roadmap (backlog, planned, in_progress, completed, cancelled). archived true archives the project (dashboards can no longer be moved into it), false restores it. Idempotent. The result is the project read back from Paperclip, with warnings for any field that did not stick or a name that was changed. Projects cannot be deleted or paused here.',
  {
    projectId: { ...uuid, description: 'The project to change.' },
    name: { type: 'string', minLength: 1, maxLength: MAX_NAME_CHARS, description: 'New name; a collision gets a numeric suffix and the result says so.' },
    description: descriptionSchema('Markdown; null clears it.'),
    status: { type: 'string', enum: PROJECT_STATUSES },
    goalIds: goalIdsSchema('The complete new set of linked goals; [] unlinks all.'),
    targetDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD; null clears it.' },
    color: { type: ['string', 'null'], pattern: '^#[0-9a-fA-F]{6}$', description: '#rrggbb; null clears it.' },
    leadAgentId: { ...nullableUuidSchema, description: 'The leading agent; null clears it.' },
    archived: { type: 'boolean', description: 'true archives the project, false restores it.' },
  },
  ['projectId'], IDEMPOTENT_WRITE);

export const CREATE_GOAL_TOOL = tool('paperclipCreateGoal',
  'Create a goal in the configured company. Goals are the strategic level of the roadmap and sit above projects: create the goal, then link projects to it with goalIds on paperclipCreateProject or paperclipUpdateProject. level is company, team, agent or task (default task); status is planned (default), active, achieved or cancelled. Use parentId to nest it under a higher-level goal and ownerAgentId to name the accountable agent. List the goals first (paperclipListGoals): this is NOT idempotent and a retry creates a duplicate. The result is the goal read back from Paperclip, with warnings for any field that did not stick. Goals cannot be deleted here.',
  {
    title: { type: 'string', minLength: 1, maxLength: MAX_NAME_CHARS, description: 'The goal, stated as an outcome.' },
    description: descriptionSchema('Markdown: why it matters and how success is measured; null for none.'),
    level: { type: 'string', enum: GOAL_LEVELS, description: 'Scope of the goal; defaults to task.' },
    status: { type: 'string', enum: GOAL_STATUSES, description: 'Defaults to planned.' },
    parentId: { ...nullableUuidSchema, description: 'The higher-level goal this one belongs to; null for a root goal.' },
    ownerAgentId: { ...nullableUuidSchema, description: 'The agent accountable for the goal; null for none.' },
  },
  ['title'], ADDITIVE_WRITE);

export const UPDATE_GOAL_TOOL = tool('paperclipUpdateGoal',
  'Change a goal of the configured company: send goalId and only the fields to change. Set status to achieved or cancelled to close a goal, active or planned to reopen it. description, parentId and ownerAgentId accept null to clear them; parentId cannot be the goal itself. Idempotent. The result is the goal read back from Paperclip, with warnings for any field that did not stick. Goals cannot be deleted here.',
  {
    goalId: { ...uuid, description: 'The goal to change.' },
    title: { type: 'string', minLength: 1, maxLength: MAX_NAME_CHARS },
    description: descriptionSchema('Markdown; null clears it.'),
    level: { type: 'string', enum: GOAL_LEVELS },
    status: { type: 'string', enum: GOAL_STATUSES },
    parentId: { ...nullableUuidSchema, description: 'The higher-level goal; null makes it a root goal.' },
    ownerAgentId: { ...nullableUuidSchema, description: 'The accountable agent; null clears it.' },
  },
  ['goalId'], IDEMPOTENT_WRITE);

export const ROADMAP_TOOLS = [CREATE_PROJECT_TOOL, UPDATE_PROJECT_TOOL, CREATE_GOAL_TOOL, UPDATE_GOAL_TOOL, MOVE_DASHBOARD_TOOL];

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

const GENERIC_FAILURE = 'Roadmap request failed. Check bridge configuration and Paperclip availability.';
const UNCERTAIN_WRITE = ' The write may or may not have been applied: read the resource before retrying (paperclipListProjects, paperclipListGoals).';

export const roadmapInputErrorResult = (message) => textResult(message, true);
export const roadmapFailureResult = () => textResult(GENERIC_FAILURE, true);
export const roadmapBusyResult = () => textResult('Roadmap tools are busy; retry shortly.', true);
const writeFailureResult = () => textResult(`${GENERIC_FAILURE}${UNCERTAIN_WRITE}`, true);
const failure = (written) => new ToolOutcome(written ? writeFailureResult() : roadmapFailureResult());
const notFound = (text) => new ToolOutcome(textResult(`Not found: ${text} Nothing was written.`, true));

/** Detail lines from the host's validation errors: plain strings, or issues with a message and path. */
function detailLines(details) {
  if (!Array.isArray(details)) {
    return [];
  }
  const lines = [];
  for (const detail of details) {
    if (typeof detail === 'string') {
      lines.push(clean(detail));
    } else if (isRecord(detail) && typeof detail.message === 'string') {
      const path = Array.isArray(detail.path)
        ? detail.path.filter((segment) => typeof segment === 'string' || typeof segment === 'number').join('.')
        : '';
      lines.push(clean(path ? `${path}: ${detail.message}` : detail.message));
    }
  }
  return lines;
}

function clientErrorResult(status, body) {
  const lines = [`Paperclip rejected the request (HTTP ${status}): ${clean(body.error)}`];
  const details = detailLines(body.details);
  for (const detail of details.slice(0, MAX_ERROR_DETAIL_LINES)) {
    lines.push(`- ${detail}`);
  }
  if (details.length > MAX_ERROR_DETAIL_LINES) {
    lines.push(`- (${details.length - MAX_ERROR_DETAIL_LINES} more not shown)`);
  }
  return textResult(lines.join('\n'), true);
}

/**
 * Core routes explain their 400, 404, 409 and 422 answers (the model can fix its call from them);
 * everything else (401, 403, 5xx, unknown or malformed bodies) stays generic and is never echoed.
 */
function rejection(response, written) {
  const body = parseJson(response.text);
  if (CLIENT_ERROR_STATUSES.has(response.status) && body && typeof body.error === 'string') {
    return new ToolOutcome(clientErrorResult(response.status, body));
  }
  // A 4xx means the write was refused; a 5xx (or an unexpected success) may have been applied.
  return failure(written && (response.status >= 500 || response.status < 400));
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Core API access
// ---------------------------------------------------------------------------------------------

const enc = encodeURIComponent;

async function send(api, pathname, { method = 'GET', body } = {}) {
  try {
    return await api.request(pathname, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch {
    throw failure(method !== 'GET');
  }
}

/**
 * A resource of the pinned company, or null when it does not exist or belongs to another company
 * (the two cases are deliberately indistinguishable). Anything unexpected fails closed.
 */
async function fetchResource(api, collection, id) {
  const response = await send(api, `/api/${collection}/${enc(id)}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw rejection(response, false);
  }
  const record = parseJson(response.text);
  if (!record || typeof record.companyId !== 'string' || typeof record.id !== 'string' || record.id.toLowerCase() !== id.toLowerCase()) {
    throw failure(false);
  }
  return record.companyId === api.companyId ? record : null;
}

/** Every referenced id must be a resource of the pinned company; the first problem (in input order) wins. */
async function checkReferences(api, references) {
  const outcomes = await Promise.all(references.map(async (reference) => {
    try {
      return { reference, found: (await fetchResource(api, reference.collection, reference.id)) !== null };
    } catch (error) {
      if (error instanceof ToolOutcome) {
        return { reference, outcome: error };
      }
      throw error;
    }
  }));
  for (const { reference, found, outcome } of outcomes) {
    if (outcome) {
      throw outcome;
    }
    if (!found) {
      throw notFound(`${reference.label} (${reference.id}) is not ${/^[aeiou]/.test(reference.noun) ? 'an' : 'a'} ${reference.noun} of the configured Paperclip company.`);
    }
  }
}

const reference = (label, collection, noun, id) => (typeof id === 'string' ? [{ label, collection, noun, id }] : []);
const goalReferences = (goalIds = []) => goalIds.flatMap((id, index) => reference(`goalIds[${index}]`, 'goals', 'goal', id));
const projectReferences = (input) => [...goalReferences(input.goalIds), ...reference('leadAgentId', 'agents', 'agent', input.leadAgentId)];
const goalParentReferences = (input) => [
  ...reference('parentId', 'goals', 'goal', input.parentId),
  ...reference('ownerAgentId', 'agents', 'agent', input.ownerAgentId),
];

/** A write response must carry the pinned company and the resource id. */
function writtenRecord(api, response) {
  const record = parseJson(response.text);
  if (!record || record.companyId !== api.companyId || typeof record.id !== 'string' || !isUuid(record.id)) {
    throw failure(true);
  }
  return record;
}

/** The stored state after a write, or null when it cannot be read back (the caller says so). */
async function readBack(api, collection, id) {
  try {
    return await fetchResource(api, collection, id);
  } catch (error) {
    if (error instanceof ToolOutcome) {
      return null;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Compact views and read-back comparison
// ---------------------------------------------------------------------------------------------

const textOrNull = (value) => (typeof value === 'string' ? value : null);
const uuidList = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []);

const compactProject = (project) => ({
  id: project.id,
  name: textOrNull(project.name),
  urlKey: textOrNull(project.urlKey),
  status: textOrNull(project.status),
  description: textOrNull(project.description),
  goalIds: uuidList(project.goalIds),
  leadAgentId: textOrNull(project.leadAgentId),
  targetDate: textOrNull(project.targetDate),
  archivedAt: textOrNull(project.archivedAt),
});

const compactGoal = (goal) => ({
  id: goal.id,
  title: textOrNull(goal.title),
  description: textOrNull(goal.description),
  level: textOrNull(goal.level),
  status: textOrNull(goal.status),
  parentId: textOrNull(goal.parentId),
  ownerAgentId: textOrNull(goal.ownerAgentId),
});

// How to read each requested field back from the stored record.
const PROJECT_READBACK = {
  name: (project) => textOrNull(project.name),
  description: (project) => textOrNull(project.description),
  status: (project) => textOrNull(project.status),
  goalIds: (project) => uuidList(project.goalIds).map((id) => id.toLowerCase()).sort(),
  targetDate: (project) => (typeof project.targetDate === 'string' ? project.targetDate.slice(0, 10) : null),
  color: (project) => (typeof project.color === 'string' ? project.color.toLowerCase() : null),
  leadAgentId: (project) => textOrNull(project.leadAgentId)?.toLowerCase() ?? null,
  archived: (project) => typeof project.archivedAt === 'string',
};
const GOAL_READBACK = {
  title: (goal) => textOrNull(goal.title),
  description: (goal) => textOrNull(goal.description),
  level: (goal) => textOrNull(goal.level),
  status: (goal) => textOrNull(goal.status),
  parentId: (goal) => textOrNull(goal.parentId)?.toLowerCase() ?? null,
  ownerAgentId: (goal) => textOrNull(goal.ownerAgentId)?.toLowerCase() ?? null,
};

/** The requested value in the shape its read-back function produces. */
function normalizeRequested(field, value) {
  if (field === 'goalIds') {
    return value.map((id) => id.toLowerCase()).sort();
  }
  if (field === 'color' && typeof value === 'string') {
    return value.toLowerCase();
  }
  if (['leadAgentId', 'parentId', 'ownerAgentId'].includes(field) && typeof value === 'string') {
    return value.toLowerCase();
  }
  return value;
}

const show = (value) => {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
};

/** One warning per requested field whose stored value differs from what was asked. */
function compareReadBack(requested, stored, readers, subject) {
  const warnings = [];
  for (const [field, read] of Object.entries(readers)) {
    if (requested[field] === undefined) {
      continue;
    }
    const wanted = normalizeRequested(field, requested[field]);
    const actual = read(stored);
    if (JSON.stringify(wanted) === JSON.stringify(actual)) {
      continue;
    }
    if (field === 'name' && subject === 'project') {
      warnings.push(`The project name was changed: requested ${show(wanted)} but it reads back as ${show(actual)}. Paperclip adds a numeric suffix such as " 2" when the name collides with an existing project; rename it or reuse the existing project if that is not what you want.`);
    } else {
      warnings.push(`Field "${field}" was requested as ${show(wanted)} but reads back as ${show(actual)}: Paperclip ignored or changed it.`);
    }
  }
  return warnings;
}

function writeResult(payload, warnings) {
  const content = [];
  if (warnings.length) {
    content.push({ type: 'text', text: warnings.map((warning) => `Warning: ${warning}`).join('\n') });
  }
  content.push({ type: 'text', text: JSON.stringify(warnings.length ? { ...payload, warnings } : payload) });
  return { content };
}

const UNREADABLE = 'The result could not be read back from Paperclip, so this is the answer of the write itself; check it with paperclipGetProject or paperclipGetGoal.';

const pick = (input, keys) => Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));

// ---------------------------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------------------------

async function createProject(input, api) {
  await checkReferences(api, projectReferences(input));
  const body = pick(input, [...PROJECT_WRITE_FIELDS, 'idempotencyKey']);
  const response = await send(api, `/api/companies/${enc(api.companyId)}/projects`, { method: 'POST', body });
  if (response.status !== 201 && response.status !== 200) {
    throw rejection(response, true);
  }
  const written = writtenRecord(api, response);
  const stored = await readBack(api, 'projects', written.id);
  const warnings = [];
  if (response.status === 200) {
    warnings.push('A project was already created with this idempotencyKey; it is returned and nothing new was created.');
  }
  if (stored) {
    warnings.push(...compareReadBack(input, stored, PROJECT_READBACK, 'project'));
  } else {
    warnings.push(UNREADABLE);
  }
  return writeResult({ created: response.status === 201, project: compactProject(stored ?? written) }, warnings);
}

async function updateProject(input, api) {
  const existing = await fetchResource(api, 'projects', input.projectId);
  if (!existing) {
    throw notFound(`project ${input.projectId} does not exist in the configured Paperclip company.`);
  }
  await checkReferences(api, projectReferences(input));
  const body = pick(input, PROJECT_WRITE_FIELDS);
  // Already archived (or active): leave archivedAt alone so repeating the call changes nothing.
  if (input.archived === true && typeof existing.archivedAt !== 'string') {
    body.archivedAt = new Date().toISOString();
  } else if (input.archived === false && typeof existing.archivedAt === 'string') {
    body.archivedAt = null;
  }
  let written = null;
  if (Object.keys(body).length) {
    const response = await send(api, `/api/projects/${enc(input.projectId)}`, { method: 'PATCH', body });
    if (!response.ok) {
      throw rejection(response, true);
    }
    written = writtenRecord(api, response);
  }
  const stored = written ? await readBack(api, 'projects', input.projectId) : existing;
  const warnings = stored ? compareReadBack(input, stored, PROJECT_READBACK, 'project') : [UNREADABLE];
  return writeResult({ updated: written !== null, project: compactProject(stored ?? written) }, warnings);
}

async function createGoal(input, api) {
  await checkReferences(api, goalParentReferences(input));
  const response = await send(api, `/api/companies/${enc(api.companyId)}/goals`, { method: 'POST', body: pick(input, GOAL_WRITE_FIELDS) });
  if (response.status !== 201 && response.status !== 200) {
    throw rejection(response, true);
  }
  const written = writtenRecord(api, response);
  const stored = await readBack(api, 'goals', written.id);
  const warnings = stored ? compareReadBack(input, stored, GOAL_READBACK, 'goal') : [UNREADABLE];
  return writeResult({ created: true, goal: compactGoal(stored ?? written) }, warnings);
}

async function updateGoal(input, api) {
  const existing = await fetchResource(api, 'goals', input.goalId);
  if (!existing) {
    throw notFound(`goal ${input.goalId} does not exist in the configured Paperclip company.`);
  }
  await checkReferences(api, goalParentReferences(input));
  const response = await send(api, `/api/goals/${enc(input.goalId)}`, { method: 'PATCH', body: pick(input, GOAL_WRITE_FIELDS) });
  if (!response.ok) {
    throw rejection(response, true);
  }
  const written = writtenRecord(api, response);
  const stored = await readBack(api, 'goals', input.goalId);
  const warnings = stored ? compareReadBack(input, stored, GOAL_READBACK, 'goal') : [UNREADABLE];
  return writeResult({ updated: true, goal: compactGoal(stored ?? written) }, warnings);
}

const FLOWS = new Map([
  ['paperclipCreateProject', createProject],
  ['paperclipUpdateProject', updateProject],
  ['paperclipCreateGoal', createGoal],
  ['paperclipUpdateGoal', updateGoal],
]);

/**
 * Run one roadmap project or goal tool. Always resolves to an MCP tool result for input problems,
 * rejections and generic failures; only a programming error escapes (the bridge turns it into the
 * generic failure result).
 */
export async function runRoadmapTool(name, rawInput, api) {
  let input;
  try {
    input = parseRoadmapInput(name, rawInput);
  } catch (error) {
    if (error instanceof RoadmapInputError) {
      return roadmapInputErrorResult(error.message);
    }
    throw error;
  }
  try {
    return await FLOWS.get(name)(input, api);
  } catch (error) {
    if (error instanceof ToolOutcome) {
      return error.result;
    }
    throw error;
  }
}
