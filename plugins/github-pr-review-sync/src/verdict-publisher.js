import { companyPublicOrigin, resolveReviewBotToken } from "./config.js";
import { fetchAuthenticatedLogin, fetchPull, publicationMarker, submitFormalReview } from "./github-api.js";
import { getReceipt, listRetryableReceipts, upsertReceipt } from "./receipt-store.js";
import { buildReceiptKey, parsePullReference } from "./review-sync-core.js";
import {
  INTAKE_ORIGIN_KIND,
  buildVerdictBody,
  effectiveOutcome,
  mapVerdictOutcomeToEvent,
  parseIntakeHeader,
  parseVerdict,
} from "./verdict.js";

const TERMINAL = new Set(["done", "cancelled"]);

const defaultDeps = {
  resolveToken: resolveReviewBotToken,
  publicOrigin: companyPublicOrigin,
  fetchPull,
  fetchLogin: fetchAuthenticatedLogin,
  submitReview: submitFormalReview,
  getReceipt,
  upsertReceipt,
  listRetryableReceipts,
};

const message = (error) => (error instanceof Error ? error.message : String(error));

async function note(ctx, issue, text) {
  try {
    await ctx.issues.createComment(issue.id, text, issue.companyId);
  } catch (error) {
    ctx.logger.warn("github-pr-review-sync: could not comment on the review issue", {
      issueId: issue.id,
      error: message(error),
    });
  }
}

/**
 * Publishes the reviewer's verdict comment on an intake-created issue as a formal GitHub review.
 * Safety rules: the comment must come from the issue's assignee, the PR comes from the issue's
 * origin (never from text), the verdict must be for the current head SHA, and policy caps the
 * outcome. Every failure leaves a receipt or an explanatory comment; nothing is published silently.
 */
export async function processVerdictComment(ctx, { companyId, issueId, commentId }, deps = defaultDeps) {
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue || issue.companyId !== companyId) return { skipped: "issue_missing" };
  if (issue.originKind !== INTAKE_ORIGIN_KIND) return { skipped: "not_intake_issue" };
  if (TERMINAL.has(issue.status)) return { skipped: "issue_closed" };

  const comments = await ctx.issues.listComments(issueId, companyId);
  const comment = comments.find((entry) => entry.id === commentId);
  if (!comment) return { skipped: "comment_missing" };
  if (!issue.assigneeAgentId || comment.authorAgentId !== issue.assigneeAgentId) return { skipped: "not_from_reviewer" };

  const parsed = parseVerdict(comment.body);
  if (!parsed.ok) {
    if (parsed.error === "no_verdict") return { skipped: "no_verdict" };
    await note(ctx, issue, `The verdict block was rejected (${parsed.error}). Post one valid block to publish the review.`);
    return { rejected: parsed.error };
  }
  const { verdict } = parsed;

  const pull = parsePullReference(issue.originId ?? "");
  const header = parseIntakeHeader(issue.description);
  const matches =
    pull &&
    header &&
    verdict.repo.toLowerCase() === `${pull.owner}/${pull.repo}`.toLowerCase() &&
    verdict.number === pull.number &&
    header.repo.toLowerCase() === verdict.repo.toLowerCase() &&
    header.number === verdict.number;
  if (!matches) {
    await note(ctx, issue, "The verdict does not match the pull request this issue was created for; nothing was published.");
    return { rejected: "verdict_mismatch" };
  }

  const token = await deps.resolveToken(ctx, companyId, { owner: pull.owner, repo: pull.repo });
  if (!token) {
    ctx.logger.error("github-pr-review-sync: review bot token unavailable", { companyId, issueId });
    await note(ctx, issue, "The review bot token is not configured; the verdict could not be published.");
    return { skipped: "missing_token" };
  }

  const { outcome, notes } = effectiveOutcome(verdict, header.authority);
  const event = mapVerdictOutcomeToEvent(outcome);
  const receiptKey = buildReceiptKey({ companyId, issueId, decisionId: commentId, pull, headSha: verdict.headSha, event });
  const marker = publicationMarker(receiptKey);
  const base = {
    receiptKey,
    companyId,
    issueId,
    decisionId: commentId,
    owner: pull.owner,
    repo: pull.repo,
    pullNumber: pull.number,
    headSha: verdict.headSha,
    githubEvent: event,
    marker,
  };

  const existing = await deps.getReceipt(ctx, receiptKey);
  if (existing?.status === "published" && existing.github_review_id) return { status: "already_published" };

  let pullData;
  try {
    pullData = await deps.fetchPull(ctx, token, pull.owner, pull.repo, pull.number);
  } catch (error) {
    await deps.upsertReceipt(ctx, { ...base, status: "failed", errorCode: "pull_fetch_failed", errorMessage: message(error).slice(0, 2000) });
    return { status: "failed", error: "pull_fetch_failed" };
  }

  if (pullData.state !== "open") {
    await deps.upsertReceipt(ctx, { ...base, status: "skipped_stale", errorCode: "pr_not_open", errorMessage: `PR state is ${pullData.state}` });
    await note(ctx, issue, "The pull request is no longer open; the verdict was not published.");
    return { status: "skipped_stale" };
  }
  if (pullData.head?.sha !== verdict.headSha) {
    await deps.upsertReceipt(ctx, { ...base, status: "skipped_stale", errorCode: "stale_verdict", errorMessage: `PR head is ${pullData.head?.sha}` });
    await note(ctx, issue, `The verdict is for ${verdict.headSha.slice(0, 12)} but the pull request head is now ${String(pullData.head?.sha).slice(0, 12)}. It was not published; review the new head.`);
    return { status: "skipped_stale" };
  }

  if (event !== "COMMENT") {
    const botLogin = await deps.fetchLogin(ctx, token);
    const author = pullData.user?.login;
    if (botLogin && author && botLogin.toLowerCase() === author.toLowerCase()) {
      await deps.upsertReceipt(ctx, {
        ...base,
        status: "pending_identity",
        errorCode: "self_review_blocked",
        errorMessage: "Review bot login matches the PR author; a separate GitHub identity is required",
      });
      await note(ctx, issue, "The review bot is the pull request author, so GitHub forbids approving or requesting changes. Nothing was published.");
      return { status: "pending_identity" };
    }
  }

  try {
    const body = buildVerdictBody({ verdict, outcome, notes, issueRef: issue.identifier ?? undefined });
    const posted = await deps.submitReview(ctx, {
      token,
      owner: pull.owner,
      repo: pull.repo,
      number: pull.number,
      headSha: verdict.headSha,
      event,
      body,
      marker,
    });
    await deps.upsertReceipt(ctx, { ...base, status: "published", githubReviewId: posted.id, githubReviewUrl: posted.url });
    await note(ctx, issue, `Published GitHub review (${event}): ${posted.url}`);
    return { status: "published", reviewId: posted.id, event };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const status = err.code === "self_review_blocked" ? "pending_identity" : "failed";
    await deps.upsertReceipt(ctx, { ...base, status, errorCode: err.code ?? "github_error", errorMessage: err.message.slice(0, 2000) });
    if (status === "pending_identity") {
      await note(ctx, issue, "GitHub rejected the review because the bot is the pull request author. Nothing was published.");
    }
    return { status, error: err.code ?? "github_error" };
  }
}

/** Event entry point for `issue.comment.created`. */
export async function handleVerdictComment(ctx, event, deps = defaultDeps) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const commentId = typeof payload.commentId === "string" ? payload.commentId : null;
  if (!event?.entityId || !event?.companyId || !commentId) return { skipped: "no_ids" };
  return processVerdictComment(ctx, { companyId: event.companyId, issueId: event.entityId, commentId }, deps);
}

/** Retries publications that failed for transient reasons (network, 5xx) within a bounded window. */
export async function retryFailedVerdicts(ctx, deps = defaultDeps) {
  const rows = await deps.listRetryableReceipts(ctx, 10);
  const results = [];
  for (const row of rows) {
    try {
      results.push(await processVerdictComment(ctx, { companyId: row.company_id, issueId: row.issue_id, commentId: row.decision_id }, deps));
    } catch (error) {
      ctx.logger.warn("github-pr-review-sync: verdict retry failed", { receiptKey: row.receipt_key, error: message(error) });
    }
  }
  return results;
}
