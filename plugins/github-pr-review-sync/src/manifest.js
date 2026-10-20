const secretRef = {
  type: "object",
  title: "Paperclip secret reference",
  properties: {
    type: { type: "string", const: "secret_ref" },
    secretId: { type: "string", format: "uuid" },
    version: { type: ["string", "integer"] },
  },
  required: ["type", "secretId"],
  additionalProperties: false,
};

const manifest = {
  id: "journey-studios.github-pr-review-sync",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "GitHub PR review sync",
  description:
    "Publish Paperclip native PR-linked review decisions as formal GitHub pull request reviews with idempotent receipts.",
  author: "Journey Studios",
  categories: ["automation", "integrations"],
  capabilities: [
    "events.subscribe",
    "issues.read",
    "issue.comments.read",
    "artifacts.read",
    "companies.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "http.outbound",
    "secrets.read-ref",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  database: {
    namespaceSlug: "github_pr_review_sync",
    migrationsDir: "migrations",
    coreReadTables: ["companies"],
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      reviewBotTokenRef: {
        ...secretRef,
        title: "GitHub review bot token",
        description:
          "Token for a GitHub identity distinct from PR authors (App/bot). Required for REQUEST_CHANGES on self-authored PRs.",
      },
      publicOrigin: {
        type: "string",
        title: "Paperclip public origin",
        description: "Optional base URL for issue links in review bodies (e.g. https://paper.example.com/JOU).",
        format: "uri",
      },
    },
  },
};

export default manifest;
