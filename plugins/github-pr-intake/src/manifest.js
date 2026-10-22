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
    triage: {
      type: "boolean",
      default: false,
      title: "Post a quick advisory triage comment (needs triageService and a GitHub App)",
    },
    worktree: {
      type: "boolean",
      default: false,
      title: "Prepare a git worktree of the PR at its head commit for the reviewer (needs workspaceService and a GitHub App)",
    },
    reviewExistingPullRequests: {
      type: "boolean",
      default: false,
      title: "Also review pull requests that were already open when the repository was added",
    },
  },
  required: ["fullName", "defaultReviewerAgentId"],
};

const manifest = {
  id: PLUGIN_KEY,
  apiVersion: 1,
  version: "0.7.1",
  displayName: "GitHub PR intake",
  description:
    "Listen to GitHub pull requests (webhook plus reconciliation) and route each one to a Paperclip review agent.",
  author: "Journey Studios",
  categories: ["automation", "connector"],
  capabilities: [
    "webhooks.receive",
    "companies.read",
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
      killSwitch: { type: "boolean", default: false, title: "Pause every repository of this company" },
      webhookSecretRef: { ...secretRef, title: "GitHub webhook secret" },
      githubTokenRefs: {
        type: "object",
        title: "GitHub token per repository owner (use * as a fallback)",
        additionalProperties: secretRef,
      },
      githubApp: {
        type: "object",
        title: "GitHub App (preferred over static tokens)",
        description: "When set, GitHub access uses short-lived installation tokens of this App.",
        required: ["appId", "privateKeyRef"],
        additionalProperties: false,
        properties: {
          appId: { type: "string", pattern: "^[0-9]+$", title: "App ID" },
          privateKeyRef: { ...secretRef, title: "App private key (PEM)" },
        },
      },
      triageService: {
        type: "object",
        title: "pr-triage service (quick advisory comment)",
        description: "PR-Agent behind an authenticated HTTP API. Repositories opt in with `triage: true`.",
        required: ["url", "tokenRef"],
        additionalProperties: false,
        properties: {
          url: { type: "string", format: "uri", title: "Service base URL" },
          tokenRef: { ...secretRef, title: "Service bearer token" },
        },
      },
      workspaceService: {
        type: "object",
        title: "review-workspaces service (worktree of the PR for the reviewer)",
        description: "Prepares a git worktree at the PR's head commit. Repositories opt in with `worktree: true`.",
        required: ["url", "tokenRef"],
        additionalProperties: false,
        properties: {
          url: { type: "string", format: "uri", title: "Service base URL" },
          tokenRef: { ...secretRef, title: "Service bearer token" },
        },
      },
      maxConcurrentReviews: { type: "integer", minimum: 1, default: 3, title: "Maximum open review issues" },
      repositories: { type: "array", items: repository, title: "Repositories to review" },
    },
  },
};

export default manifest;
