import type { PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { CHANGELOG_KINDS, CURATED_KINDS } from "./contracts.js";

export const AUTHORING_GUIDE = [
  "Publish a project-tracking dashboard as a declarative JSON spec (never HTML or scripts). Every dashboard belongs to a project: a new dashboard uses projectId, else the current run's project; an existing dashboard keeps its project unless projectId moves it; archived projects are rejected (project_archived).",
  'Shape: {version:1, title, summary?:markdown, meta?:markdown, datasets:{id:{title, description?, source?, updatedAt?:ISO, staleAfterHours?:number, columns?:[...], rows:[{field:string|number|boolean|null}]}}, statusTones?:{value:"ok|warn|bad|muted|info"}, sections:[{id, title?, note?, columns?:1-4, blocks:[...]}]}.',
  "Blocks (all accept id?, title?, note?, span?:1-4): {type:'markdown',content} | {type:'mermaid',code} | {type:'callout',tone,content} | {type:'kpis',items:[{label,value,of?,caption?,format?,tone?}]} | {type:'chart',chart:'bar|horizontalBar|stackedBar|line|area|donut|progress',dataset,x,y:field|[fields],seriesLabels?,seriesColors?:{field:tone|#rrggbb},format?,tooltip?:[fields],goal?} | {type:'table',dataset,rowKey,columns:[{field,label,format?,wide?}],filters?:{chips?,selects?:[],search?},sort?:{field,dir},emptyText?} | {type:'statusList',dataset,labelField,valueField,statusField,detailField?,format?}.",
  "A value is a number, a string, or {dataset,field,where?:{field:value},row?:n,agg?:'sum|count|avg|min|max'} computed from a dataset, so numbers live in one place.",
  "Formats: int, decimal, pct (fraction: 0.42 shows 42%), currency (company currency setting), duration (seconds), raw. Table cell formats also: status, priority, date, link (http/https only), code, muted, strong.",
  "Always fill dataset title, description, source (where the numbers come from) and updatedAt so readers can trust them; set staleAfterHours on data that must be refreshed regularly. Reference only declared datasets and fields; errors list exact paths such as sections[2].blocks[0].dataset.",
  "Series whose field names are statuses or priorities (done, blocked, P0...) are colored by tone automatically; use seriesColors to choose colors.",
  "Use update_dataset to refresh numbers without resending the page. Use validate_dashboard_spec to dry-run.",
].join("\n");

export const CHANGELOG_GUIDE = [
  "A project changelog is the evolution of a project over time: a dated list of what changed and why.",
  "Record an entry when something relevant is closed: a merged PR, a validated deploy, a milestone, a decision, an incident or a release. One entry per relevant change, not one per run or per commit.",
  "Write the title as the result (\"Checkout accepts Pix payments\"), not the activity. Use body (Markdown) for what changed and why, refs for issue identifiers, PR numbers or commit SHAs, links for URLs, version for a release number and occurredAt when the event happened earlier than now.",
  `Kinds: ${CURATED_KINDS.join(", ")}.`,
  "Completed issues are added to the changelog automatically (kind \"issue\", according to the company setting), so do not record an entry that only repeats an issue that was just completed.",
  "Entries cannot be deleted by agents; correct a mistake with update_changelog_entry.",
].join("\n");

const changelogFieldSchemas = {
  kind: { type: "string", enum: [...CURATED_KINDS], description: "What the entry records." },
  title: { type: "string", minLength: 1, maxLength: 200, description: "The result, in one line." },
  body: { type: "string", maxLength: 20000, description: "Markdown: what changed and why." },
  version: { type: "string", minLength: 1, maxLength: 64, description: "Release or version label, such as v1.4.0." },
  refs: {
    type: "array",
    maxItems: 20,
    items: { type: "string", minLength: 1, maxLength: 100 },
    description: "Issue identifiers (ABC-12 style), PR numbers or commit SHAs.",
  },
  links: {
    type: "array",
    maxItems: 20,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["label", "url"],
      properties: {
        label: { type: "string", minLength: 1, maxLength: 100 },
        url: { type: "string", maxLength: 2000, description: "Absolute http or https URL." },
      },
    },
  },
  occurredAt: { type: "string", maxLength: 64, description: "ISO 8601 date or timestamp of the event; defaults to now." },
};

const projectIdSchema = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
  description:
    "Project UUID of this company (not archived). Every dashboard belongs to a project. Optional: a new dashboard defaults to the current run's project (error project_required if the run has none); an existing dashboard keeps its project (or lack of one) when omitted, and a UUID moves it.",
};

const milestoneFields = {
  title: { type: "string", minLength: 1, maxLength: 200 },
  description: { type: ["string", "null"], maxLength: 10000 },
  status: { type: "string", enum: ["planned", "in_progress", "completed", "cancelled"] },
  targetDate: { type: ["string", "null"], description: "YYYY-MM-DD (nullable)." },
  criteria: {
    type: "array", minItems: 1, maxItems: 30,
    items: {
      type: "object", additionalProperties: false, required: ["text", "checked"],
      properties: { text: { type: "string", minLength: 1, maxLength: 300 }, checked: { type: "boolean" } },
    },
  },
  issueIds: { type: "array", maxItems: 50, items: { type: "string", format: "uuid" } },
  evidence: {
    type: "array", maxItems: 20,
    items: {
      type: "object", additionalProperties: false, required: ["label", "url"],
      properties: { label: { type: "string", maxLength: 100 }, url: { type: "string", maxLength: 2000 } },
    },
  },
} as const;

const milestoneGuide = "Milestones are explicit project checkpoints, not Goals, Issues or changelog entries. Attach existing Issue UUIDs of the same project; mark criteria checked only after verification, and attach evidence URLs. Completing a milestone requires every linked Issue to be done, all criteria checked and at least one evidence URL; issue completion never automatically completes milestones. Updates require the revision returned by get_milestone to prevent lost writes. A completed milestone is immutable until explicitly reopened to in_progress; its first completion appears once in the project's changelog.";

export const TOOL_DECLARATIONS: PluginToolDeclaration[] = [
  {
    name: "upsert_dashboard",
    displayName: "Publish dashboard",
    description: `Create or replace a project dashboard identified by slug in the current company; every call stores a new revision.\n${AUTHORING_GUIDE}`,
    parametersSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug", "spec"],
      properties: {
        slug: { type: "string", pattern: "^[a-z0-9-]{1,64}$", description: "Stable identifier: lowercase letters, digits, hyphens." },
        title: { type: "string", maxLength: 200, description: "Defaults to spec.title." },
        projectId: projectIdSchema,
        spec: { type: "object", description: "DashboardSpec v1 (see tool description)." },
      },
    },
  },
  {
    name: "get_dashboard",
    displayName: "Read dashboard",
    description: "Read a dashboard spec by slug, including its revision and datasets.",
    parametersSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug"],
      properties: { slug: { type: "string", pattern: "^[a-z0-9-]{1,64}$" } },
    },
  },
  {
    name: "list_dashboards",
    displayName: "List dashboards",
    description: "List dashboards in the current company, optionally for one project.",
    parametersSchema: {
      type: "object",
      additionalProperties: false,
      properties: { projectId: { type: "string", description: "Project UUID filter." } },
    },
  },
  {
    name: "get_dashboard_status",
    displayName: "Dashboard freshness",
    description:
      "Report whether a dashboard's data is fresh, stale or unknown: per-dataset age and staleness, revision and counts. Datasets are stale when older than their staleAfterHours (or the company default).",
    parametersSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug"],
      properties: { slug: { type: "string", pattern: "^[a-z0-9-]{1,64}$" } },
    },
  },
  {
    name: "update_dataset",
    displayName: "Refresh dashboard dataset",
    description:
      "Replace the rows (and optionally columns, description, source, updatedAt) of one dataset in an existing dashboard without resending the page. The whole spec is revalidated; updatedAt defaults to now.",
    parametersSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug", "datasetId", "rows"],
      properties: {
        slug: { type: "string", pattern: "^[a-z0-9-]{1,64}$" },
        datasetId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
        rows: { type: "array", items: { type: "object" } },
        columns: { type: "array", items: { type: "string" } },
        description: { type: "string" },
        source: { type: "string" },
        updatedAt: { type: "string", description: "ISO 8601 timestamp." },
      },
    },
  },
  {
    name: "validate_dashboard_spec",
    displayName: "Validate dashboard spec",
    description: "Dry-run a DashboardSpec and list every validation error with its path. Stores nothing.",
    parametersSchema: {
      type: "object",
      additionalProperties: false,
      required: ["spec"],
      properties: { spec: { type: "object" } },
    },
  },
  {
    name: "add_changelog_entry",
    displayName: "Add changelog entry",
    description: `Record one entry in a project's changelog.\n${CHANGELOG_GUIDE}`,
    parametersSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "title"],
      properties: {
        projectId: { type: "string", description: "Project UUID. Omit to use the current run's project." },
        ...changelogFieldSchemas,
      },
    },
  },
  {
    name: "list_changelog",
    displayName: "List changelog",
    description:
      "Read the changelog, newest first: the dated evolution of one project or of the whole company. Read it before recording an entry to avoid duplicating one, or to summarize what changed. Pass the nextCursor of a response as `before` for older entries.",
    parametersSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", description: "Project UUID filter; omit for every project of the company." },
        kinds: { type: "array", items: { type: "string", enum: [...CHANGELOG_KINDS] }, description: "Only these kinds." },
        includeIssues: { type: "boolean", description: "Include entries generated from completed issues (default true)." },
        before: { type: "string", maxLength: 200, description: "The nextCursor of the previous response." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Entries to return (default 50)." },
      },
    },
  },
  {
    name: "update_changelog_entry",
    displayName: "Update changelog entry",
    description:
      "Correct or complete a changelog entry written with add_changelog_entry: send entryId and only the fields to change. null clears body or version. Entries generated from completed issues mirror the issue and cannot be edited.",
    parametersSchema: {
      type: "object",
      additionalProperties: false,
      required: ["entryId"],
      properties: {
        entryId: { type: "string", description: "Entry UUID, from list_changelog or add_changelog_entry." },
        ...changelogFieldSchemas,
        body: { type: ["string", "null"], maxLength: 20000, description: "Markdown; null removes it." },
        version: { type: ["string", "null"], minLength: 1, maxLength: 64, description: "Version label; null removes it." },
      },
    },
  },
  {
    name: "create_milestone",
    displayName: "Create project milestone",
    description: `Create a verifiable project checkpoint. ${milestoneGuide}`,
    parametersSchema: {
      type: "object", additionalProperties: false, required: ["title", "criteria"],
      properties: {
        projectId: { type: "string", description: "Project UUID; defaults to the current run's project." },
        ...milestoneFields, status: { type: "string", enum: ["planned", "in_progress"] },
      },
    },
  },
  {
    name: "list_milestones",
    displayName: "List project milestones",
    description: "List project checkpoints with progress, blockers, dates, links and evidence. Defaults to current project, or all company projects outside an issue.",
    parametersSchema: { type: "object", additionalProperties: false,
      properties: { projectId: { type: "string", description: "Project UUID filter." } } },
  },
  {
    name: "get_milestone",
    displayName: "Inspect milestone",
    description: "Read live Issue statuses, verification gates and current revision for a milestone.",
    parametersSchema: { type: "object", additionalProperties: false, required: ["milestoneId"],
      properties: { milestoneId: { type: "string", description: "Milestone UUID." } } },
  },
  {
    name: "update_milestone",
    displayName: "Update/complete milestone",
    description: `Edit a milestone, verify criteria, attach evidence, or explicitly complete it. ${milestoneGuide}`,
    parametersSchema: {
      type: "object", additionalProperties: false, required: ["milestoneId", "revision"],
      properties: {
        milestoneId: { type: "string", description: "Milestone UUID." },
        revision: { type: "integer", minimum: 1, description: "Current revision from get_milestone." },
        ...milestoneFields,
      },
    },
  },
];
