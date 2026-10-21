import { PLUGIN_KEY } from "./constants.js";

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

const stringList = { type: "array", items: { type: "string" } };

const rule = {
  type: "object",
  title: "Routing rule (first match wins; all given criteria must match)",
  additionalProperties: false,
  properties: {
    reviewerAgentId: { type: "string", title: "Reviewer agent id" },
    paths: { ...stringList, title: "Match if any changed file matches one of these globs" },
    labels: { ...stringList, title: "Match if the PR has any of these labels" },
    authors: { ...stringList, title: "Match if the PR author is one of these GitHub logins" },
    baseBranches: { ...stringList, title: "Match if the PR targets one of these branches" },
  },
  required: ["reviewerAgentId"],
};

const repository = {
  type: "object",
  additionalProperties: false,
  properties: {
    fullName: { type: "string", title: "owner/repo" },
    companyId: { type: "string", title: "Paperclip company id" },
    projectId: { type: "string", title: "Project for the review issues (optional)" },
    defaultReviewerAgentId: { type: "string", title: "Default reviewer agent id" },
    rules: { type: "array", items: rule, title: "Routing rules" },
    authority: {
      type: "string",
      enum: ["comment", "request_changes", "approve"],
      default: "comment",
      title: "Most the reviewer may publish on GitHub",
    },
    ignorePaths: { ...stringList, title: "Skip PRs whose changed files all match these globs" },
    skipLabels: { ...stringList, title: "Skip PRs with any of these labels (default: skip-review)" },
    reviewBots: { type: "boolean", default: false, title: "Also review PRs opened by bots" },
    baseBranches: { ...stringList, title: "Only review PRs targeting these branches (empty = all)" },
    debounceSeconds: { type: "number", minimum: 0, maximum: 600, default: 60, title: "Wait after a push before reviewing (max 600)" },
    maxRoundsPerPr: { type: "integer", minimum: 1, default: 3, title: "Review rounds per PR" },
    killSwitch: { type: "boolean", default: false, title: "Pause reviews for this repository" },
    deliveryNotes: { type: "string", title: "Extra notes added to every review package" },
  },
  required: ["fullName", "companyId", "defaultReviewerAgentId"],
};

const manifest = {
  id: PLUGIN_KEY,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "GitHub PR intake",
  description:
    "Listen to GitHub pull requests (webhook plus reconciliation) and route each one to a Paperclip review agent.",
  author: "Journey Studios",
  categories: ["automation", "connector"],
  capabilities: [
    "webhooks.receive",
    "secrets.read-ref",
    "http.outbound",
    "jobs.schedule",
    "issues.create",
    "issues.read",
    "issues.update",
    "issues.wakeup",
    "issue.comments.create",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  webhooks: [
    {
      endpointKey: "github",
      displayName: "GitHub pull request events",
      description: "Receives `pull_request` events (application/json) signed with the webhook secret.",
    },
  ],
  jobs: [
    {
      jobKey: "reconcile",
      displayName: "Reconcile open pull requests",
      description: "Recovers missed webhook events and drains the review queue.",
      schedule: "* * * * *",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      killSwitch: { type: "boolean", default: false, title: "Pause every review" },
      webhookSecretRef: { ...secretRef, title: "GitHub webhook secret" },
      githubTokenRefs: {
        type: "object",
        title: "GitHub token per repository owner (use * as a fallback)",
        additionalProperties: secretRef,
      },
      maxConcurrentReviews: { type: "integer", minimum: 1, default: 3, title: "Maximum open review issues" },
      repositories: { type: "array", items: repository, title: "Repositories to review" },
    },
  },
};

export default manifest;
