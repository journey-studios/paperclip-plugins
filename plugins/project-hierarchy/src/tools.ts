import type { PluginToolDeclaration } from "@paperclipai/plugin-sdk";

const PROJECT_ID = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
} as const;

export const TOOL_DECLARATIONS: PluginToolDeclaration[] = [
  {
    name: "list_project_tree",
    displayName: "List project tree",
    description:
      "List every project of the current company as an indented tree: top-level projects with their sub-projects below. Each line shows the project name, id, status and whether it is archived.",
    parametersSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_project_hierarchy",
    displayName: "Read project hierarchy",
    description:
      "Read where one project sits in the hierarchy: its parent, its ancestors from the top-level project down, and its direct sub-projects. Defaults to the current run's project.",
    parametersSchema: {
      type: "object",
      properties: { projectId: { ...PROJECT_ID, description: "Project UUID; defaults to the run's project." } },
      additionalProperties: false,
    },
  },
  {
    name: "set_project_parent",
    displayName: "Set parent project",
    description:
      "Make a project a sub-project of another project in the same company, or pass parentProjectId null to make it top-level again. Rejected when the parent is archived, belongs to another company, is the project itself, or is one of the project's own sub-projects (cycle). To create a new sub-project, create the project first, then call this tool with its id.",
    parametersSchema: {
      type: "object",
      required: ["projectId", "parentProjectId"],
      properties: {
        projectId: { ...PROJECT_ID, description: "Project to move." },
        parentProjectId: {
          anyOf: [PROJECT_ID, { type: "null" }],
          description: "New parent project UUID, or null for top-level.",
        },
      },
      additionalProperties: false,
    },
  },
];
