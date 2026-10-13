import type { PluginToolDeclaration } from "@paperclipai/plugin-sdk";

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

const projectIdSchema = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
  description:
    "Project UUID of this company (not archived). Every dashboard belongs to a project. Optional: a new dashboard defaults to the current run's project (error project_required if the run has none); an existing dashboard keeps its project (or lack of one) when omitted, and a UUID moves it.",
};

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
];
