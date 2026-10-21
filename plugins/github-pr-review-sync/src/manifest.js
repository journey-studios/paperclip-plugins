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
  version: "0.2.0",
  displayName: "GitHub PR review sync",
  description:
    "Publish Paperclip native PR-linked review decisions as formal GitHub pull request reviews with idempotent receipts.",
  author: "Journey Studios",
  // The host only accepts: connector, workspace, automation, ui.
  categories: ["automation", "connector"],
  capabilities: [
    "events.subscribe",
    "jobs.schedule",
    "issues.read",
    "issue.comments.read",
    "issue.comments.create",
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
  jobs: [
    {
      jobKey: "retry-failed",
      displayName: "Retry failed verdict publications",
      description: "Retries recent verdict publications that failed for transient reasons.",
      schedule: "*/5 * * * *",
    },
  ],
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
      githubApp: {
        type: "object",
        title: "GitHub App (preferred over a static token)",
        description: "When set, reviews are published as this App using short-lived installation tokens.",
        required: ["appId", "privateKeyRef"],
        additionalProperties: false,
        properties: {
          appId: { type: "string", pattern: "^[0-9]+$", title: "App ID" },
          privateKeyRef: { ...secretRef, title: "App private key (PEM)" },
        },
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
