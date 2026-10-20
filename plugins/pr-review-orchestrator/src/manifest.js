export const PLUGIN_ID = "journeystudios.pr-review-orchestrator";
export const ORIGIN_KIND = `plugin:${PLUGIN_ID}`;

const manifest = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Automatic PR Review Orchestrator",
  description:
    "Authenticates GitHub PR webhooks, deduplicates commit revisions and queues code reviews as Paperclip Issues for on-demand agents.",
  author: "Journey Studios",
  categories: ["automation"],
  capabilities: [
    "webhooks.receive",
    "secrets.read-ref",
    "events.subscribe",
    "jobs.schedule",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "agents.read",
    "projects.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  database: { namespaceSlug: "pr_review_orchestrator", migrationsDir: "migrations" },
  webhooks: [
    {
      endpointKey: "github",
      displayName: "GitHub pull requests",
      description: "Validates GitHub x-hub-signature-256; handles pull_request lifecycle events.",
    },
  ],
  jobs: [
    {
      jobKey: "reconcile",
      displayName: "PR review queue reconciliation",
      description: "Recovers interrupted dispatches and starts queued review Issues without running an LLM on a schedule.",
      schedule: "*/5 * * * *",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    required: ["reviewerAgentId", "githubWebhookSecretRef", "repositories"],
    properties: {
      enabled: { type: "boolean", title: "Enable automatic PR reviews", default: false },
      reviewerAgentId: {
        type: "string",
        format: "uuid",
        title: "Reviewer agent ID (e.g., Thermo)",
      },
      githubWebhookSecretRef: {
        type: "object",
        title: "GitHub webhook secret reference",
        description: "Paperclip secret_ref; never store a plaintext webhook secret.",
        required: ["type", "secretId"],
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["secret_ref"] },
          secretId: { type: "string", format: "uuid" },
          version: { anyOf: [{ type: "string", enum: ["latest"] }, { type: "integer", minimum: 1 }] },
        },
      },
      repositories: {
        type: "array",
        minItems: 1,
        maxItems: 30,
        title: "GitHub repository → Paperclip project",
        items: {
          type: "object",
          required: ["fullName", "projectId"],
          additionalProperties: false,
          properties: {
            fullName: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
            projectId: { type: "string", format: "uuid" },
            reviewerAgentId: { type: "string", format: "uuid" },
          },
        },
      },
      maxAttempts: { type: "integer", minimum: 1, maximum: 3, default: 2 },
      ignoreDrafts: { type: "boolean", default: true },
    },
  },
};

export default manifest;
