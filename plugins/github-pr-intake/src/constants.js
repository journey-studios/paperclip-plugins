export const PLUGIN_KEY = "journey-studios.github-pr-intake";
export const ORIGIN_KIND = `plugin:${PLUGIN_KEY}`;
export const STATE_NAMESPACE = "pr-intake";

// Actions that (re)start a review, and actions that end one.
export const HANDLED_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "synchronize"]);
export const CANCEL_ACTIONS = new Set(["closed", "converted_to_draft"]);

// Machine-readable markers shared with the publishing plugin (github-pr-review-sync).
export const INTAKE_MARKER = "paperclip-pr-intake";
export const VERDICT_MARKER = "paperclip-review-verdict";

export const AUTHORITIES = ["comment", "request_changes", "approve"];

// A steady stream of pushes must not postpone a review forever: debounce is capped at 10 minutes.
export const MAX_DEBOUNCE_SECONDS = 600;
export const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
