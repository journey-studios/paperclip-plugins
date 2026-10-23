import { resolveReviewBotToken } from "./config.js";
import { fetchPull } from "./github-api.js";
import { parsePullReference } from "./review-sync-core.js";
import { INTAKE_ORIGIN_KIND } from "./verdict.js";

export const MAX_REPAIRS = 2;
export const REPAIR_WINDOW_MS = 2 * 60 * 60 * 1000;
/**
 * The reviewer closes its issue a few seconds after posting the verdict. Reopening it before that finishes would be
 * undone by the reviewer's own status update, so a repair waits until the run that posted the block is over.
 */
export const REPAIR_SETTLE_MS = 60_000;
const MAX_WAKE_TRIES = 3;
const MAX_PER_TICK = 5;
const TERMINAL = new Set(["done", "cancelled"]);
const PENDING_KEY = "pending";
const VERDICT_MARKER_RE = /<!--\s*paperclip-review-verdict/i;

/** Every way a block can be broken by the reviewer; a wrong PR (`verdict_mismatch`) is not one of them. */
export const REPAIRABLE_ERRORS = new Set([
  "invalid_json",
  "multiple_verdicts",
  "unsupported_version",
  "invalid_repo",
  "invalid_number",
  "invalid_head_sha",
  "invalid_outcome",
  "invalid_findings",
  "invalid_finding",
]);

const HINTS = {
  invalid_json:
    "The block is not valid JSON. Write `summary` and every finding `message` on a single line, with no line break inside a string, and put a backslash before each double quote inside a string.",
  multiple_verdicts: "A comment must carry exactly one verdict block.",
};
const DEFAULT_HINT = "A required field is missing or has the wrong type. Follow the verdict format from the issue description.";

const defaultDeps = {
  resolveToken: resolveReviewBotToken,
  fetchPull,
};

const message = (error) => (error instanceof Error ? error.message : String(error));
const scope = (stateKey) => ({ scopeKind: "instance", namespace: "verdict_repair", stateKey });
const timeOf = (value) => new Date(value).getTime();

// The index is read, changed and written back, so concurrent callers (comment events and the job) take turns.
let tail = Promise.resolve();
function exclusive(operation) {
  const run = tail.catch(() => {}).then(operation);
  tail = run;
  return run;
}

async function readIssueEntry(ctx, issueId) {
  return (await ctx.state.get(scope(`issue:${issueId}`))) ?? null;
}

async function writeIssueEntry(ctx, issueId, entry) {
  await ctx.state.set(scope(`issue:${issueId}`), entry);
}

async function removePending(ctx, issueId) {
  await exclusive(async () => {
    const index = (await ctx.state.get(scope(PENDING_KEY))) ?? [];
    if (index.includes(issueId)) await ctx.state.set(scope(PENDING_KEY), index.filter((id) => id !== issueId));
  });
}

/**
 * Remembers that a verdict block was rejected, so the job can ask the reviewer for a corrected one.
 * @returns {Promise<{ queued: boolean, reason?: string }>}
 */
export async function requestRepair(ctx, { companyId, issueId, commentId, error }, now = Date.now()) {
  if (!REPAIRABLE_ERRORS.has(error)) return { queued: false, reason: "not_repairable" };
  return exclusive(async () => {
    const prior = await readIssueEntry(ctx, issueId);
    const attempts = prior?.attempts ?? 0;
    if (attempts >= MAX_REPAIRS) return { queued: false, reason: "limit_reached" };
    await writeIssueEntry(ctx, issueId, { companyId, commentId, error, requestedAt: now, attempts });
    const index = (await ctx.state.get(scope(PENDING_KEY))) ?? [];
    if (!index.includes(issueId)) await ctx.state.set(scope(PENDING_KEY), [...index, issueId]);
    return { queued: true };
  });
}

function repairComment(entry) {
  const hint = HINTS[entry.error] ?? DEFAULT_HINT;
  return [
    `Your verdict block (${entry.error}) was rejected and nothing was published to GitHub. ${hint}`,
    "",
    `Post one corrected verdict block for the current head of the pull request, then mark this issue done again. Do not redo the review. This is correction ${entry.attempts + 1} of ${MAX_REPAIRS}.`,
  ].join("\n");
}

async function wakeReviewer(ctx, issue, entry) {
  try {
    const result = await ctx.issues.requestWakeup(issue.id, entry.companyId, {
      reason: "github_pr_review_requested",
      contextSource: "github-pr-review-sync",
      idempotencyKey: `verdict-repair:${issue.id}:${entry.commentId}`,
    });
    return Boolean(result?.queued);
  } catch (error) {
    ctx.logger.warn("github-pr-review-sync: reviewer wakeup failed", { issueId: issue.id, error: message(error) });
    return false;
  }
}

/** The reviewer already posted another verdict block after the rejected one: nothing left to ask. */
function answeredSince(comments, rejected, assigneeAgentId) {
  return comments.some(
    (comment) =>
      comment.authorAgentId === assigneeAgentId &&
      timeOf(comment.createdAt) > timeOf(rejected.createdAt) &&
      VERDICT_MARKER_RE.test(String(comment.body ?? "")),
  );
}

async function repairIssue(ctx, issueId, deps, now) {
  const drop = async (reason) => {
    await removePending(ctx, issueId);
    return { issueId, dropped: reason };
  };
  let entry = await readIssueEntry(ctx, issueId);
  if (!entry) return drop("no_entry");
  if (now - entry.requestedAt > REPAIR_WINDOW_MS) return drop("expired");
  if (now - entry.requestedAt < REPAIR_SETTLE_MS) return { issueId, waiting: "settling" };

  const issue = await ctx.issues.get(issueId, entry.companyId);
  if (!issue || issue.originKind !== INTAKE_ORIGIN_KIND || !issue.assigneeAgentId) return drop("issue_unavailable");
  if (issue.status === "cancelled") return drop("issue_cancelled");

  const comments = await ctx.issues.listComments(issueId, entry.companyId);
  const rejected = comments.find((comment) => comment.id === entry.commentId);
  if (!rejected) return drop("comment_missing");
  if (answeredSince(comments, rejected, issue.assigneeAgentId)) return drop("already_answered");

  const pull = parsePullReference(issue.originId ?? "");
  if (!pull) return drop("no_pull");
  const token = await deps.resolveToken(ctx, entry.companyId, { owner: pull.owner, repo: pull.repo });
  if (!token) return { issueId, waiting: "missing_token" };
  const pullData = await deps.fetchPull(ctx, token, pull.owner, pull.repo, pull.number);
  if (pullData.state !== "open") return drop("pr_not_open");

  if (!entry.prepared) {
    if (TERMINAL.has(issue.status)) await ctx.issues.update(issue.id, { status: "todo" }, entry.companyId);
    await ctx.issues.createComment(issue.id, repairComment(entry), entry.companyId);
    entry = { ...entry, prepared: true };
    await writeIssueEntry(ctx, issueId, entry);
  }

  if (!(await wakeReviewer(ctx, issue, entry))) {
    const wakeTries = (entry.wakeTries ?? 0) + 1;
    if (wakeTries < MAX_WAKE_TRIES) {
      await writeIssueEntry(ctx, issueId, { ...entry, wakeTries });
      return { issueId, waiting: "wake_retry" };
    }
    ctx.logger.warn("github-pr-review-sync: the reviewer could not be woken for a verdict correction", { issueId });
  }
  await writeIssueEntry(ctx, issueId, { ...entry, attempts: entry.attempts + 1, prepared: false, wakeTries: 0 });
  await removePending(ctx, issueId);
  return { issueId, repaired: true };
}

/**
 * Asks the reviewer for a corrected verdict where a rejected block left an issue without a published review.
 * Bounded: at most MAX_REPAIRS per issue, only inside REPAIR_WINDOW_MS, only for pull requests that are still open.
 */
export async function runRepairs(ctx, deps = defaultDeps, now = Date.now()) {
  const index = (await exclusive(() => ctx.state.get(scope(PENDING_KEY)))) ?? [];
  const results = [];
  for (const issueId of index.slice(0, MAX_PER_TICK)) {
    try {
      results.push(await repairIssue(ctx, issueId, deps, now));
    } catch (error) {
      ctx.logger.warn("github-pr-review-sync: verdict repair failed", { issueId, error: message(error) });
      results.push({ issueId, failed: true });
    }
  }
  return results;
}
