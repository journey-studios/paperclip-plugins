import { companyPublicOrigin, resolveReviewBotToken } from "./config.js";
import {
  fetchAuthenticatedLogin,
  fetchPull,
  publicationMarker,
  submitFormalReview,
} from "./github-api.js";
import { resolveLinkedPullRequests } from "./pull-resolution.js";
import { getReceipt, upsertReceipt } from "./receipt-store.js";
import {
  buildReceiptKey,
  extractReviewDecisionTransition,
  isReviewDecisionOutcome,
  mapOutcomeToGitHubEvent,
} from "./review-sync-core.js";
import { buildReviewBody } from "./review-body.js";

const STATE_NAMESPACE = "review-sync";
const lastDecisionScope = (issueId) => ({
  scopeKind: "instance",
  namespace: STATE_NAMESPACE,
  stateKey: `last-published-decision:${issueId}`,
});

/**
 * @param {unknown} executionState
 */
export function readDecisionFromIssueState(executionState) {
  const state = executionState && typeof executionState === "object" ? executionState : null;
  if (!state) return null;
  const decisionId = state.lastDecisionId;
  const outcome = state.lastDecisionOutcome;
  if (typeof decisionId !== "string" || !decisionId) return null;
  if (!isReviewDecisionOutcome(outcome)) return null;
  return { decisionId, outcome };
}

/**
 * @param {import("@paperclipai/plugin-sdk").PluginContext} ctx
 * @param {string} companyId
 * @param {string} issueId
 * @param {{ decisionId: string, outcome: string }|null} transition
 */
export async function publishReviewDecisionsForIssue(ctx, companyId, issueId, transition) {
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) return { skipped: "issue_missing" };

  const decision =
    transition ?? readDecisionFromIssueState(issue.executionState);
  if (!decision) return { skipped: "no_review_decision" };

  const githubEvent = mapOutcomeToGitHubEvent(decision.outcome);
  if (!githubEvent) return { skipped: "unmapped_outcome" };

  const pulls = await resolveLinkedPullRequests(ctx, issueId, companyId);
  if (pulls.length === 0) {
    ctx.logger.warn("github-pr-review-sync: no linked pull request", {
      companyId,
      issueId,
      decisionId: decision.decisionId,
    });
    return { skipped: "no_linked_pr" };
  }

  const token = await resolveReviewBotToken(ctx, companyId);
  if (!token) {
    ctx.logger.error("github-pr-review-sync: review bot token unavailable", { companyId, issueId });
    return { skipped: "missing_token" };
  }

  const botLogin = await fetchAuthenticatedLogin(ctx, token);
  const origin = await companyPublicOrigin(ctx, companyId);
  const body = buildReviewBody(issue, null, origin);

  const results = [];
  for (const pull of pulls) {
    // One unreachable PR (404, 403, rate limit) must not abort the others.
    let pullData;
    try {
      pullData = await fetchPull(ctx, token, pull.owner, pull.repo, pull.number);
    } catch (error) {
      ctx.logger.warn("github-pr-review-sync: pull fetch failed", {
        pull: `${pull.owner}/${pull.repo}#${pull.number}`,
        error: error instanceof Error ? error.message : String(error),
      });
      results.push({ pull, status: "failed", error: "pull_fetch_failed" });
      continue;
    }
    const headSha = pullData?.head?.sha;
    if (typeof headSha !== "string" || !headSha) {
      results.push({ pull, status: "failed", error: "missing_head_sha" });
      continue;
    }

    const prAuthor = pullData?.user?.login;
    const receiptKey = buildReceiptKey({
      companyId,
      issueId,
      decisionId: decision.decisionId,
      pull,
      headSha,
      event: githubEvent,
    });
    const existing = await getReceipt(ctx, receiptKey);
    if (existing?.status === "published" && existing.github_review_id) {
      results.push({ pull, status: "already_published", reviewId: existing.github_review_id });
      continue;
    }

    const marker = publicationMarker(receiptKey);

    if (
      githubEvent === "REQUEST_CHANGES" &&
      botLogin &&
      prAuthor &&
      botLogin.toLowerCase() === prAuthor.toLowerCase()
    ) {
      await upsertReceipt(ctx, {
        receiptKey,
        companyId,
        issueId,
        decisionId: decision.decisionId,
        owner: pull.owner,
        repo: pull.repo,
        pullNumber: pull.number,
        headSha,
        githubEvent,
        status: "pending_identity",
        errorCode: "self_review_blocked",
        errorMessage: "Review bot login matches PR author; separate GitHub App identity required",
        marker,
      });
      results.push({ pull, status: "pending_identity" });
      continue;
    }

    if (pullData.state !== "open") {
      await upsertReceipt(ctx, {
        receiptKey,
        companyId,
        issueId,
        decisionId: decision.decisionId,
        owner: pull.owner,
        repo: pull.repo,
        pullNumber: pull.number,
        headSha,
        githubEvent,
        status: "skipped_stale",
        errorCode: "pr_not_open",
        errorMessage: `PR state is ${pullData.state}`,
        marker,
      });
      results.push({ pull, status: "skipped_stale" });
      continue;
    }

    try {
      const posted = await submitFormalReview(ctx, {
        token,
        owner: pull.owner,
        repo: pull.repo,
        number: pull.number,
        headSha,
        event: githubEvent,
        body,
        marker,
      });
      await upsertReceipt(ctx, {
        receiptKey,
        companyId,
        issueId,
        decisionId: decision.decisionId,
        owner: pull.owner,
        repo: pull.repo,
        pullNumber: pull.number,
        headSha,
        githubEvent,
        status: "published",
        githubReviewId: posted.id,
        githubReviewUrl: posted.url,
        marker,
      });
      await ctx.activity.log({
        companyId,
        message: `Published formal GitHub review (${githubEvent}) on ${pull.owner}/${pull.repo}#${pull.number}`,
        entityType: "issue",
        entityId: issueId,
        metadata: {
          receiptKey,
          pull: `${pull.owner}/${pull.repo}#${pull.number}`,
          headSha,
          githubEvent,
          reviewId: posted.id,
          reviewUrl: posted.url,
          decisionId: decision.decisionId,
        },
      });
      results.push({ pull, status: "published", reviewId: posted.id, reviewUrl: posted.url });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await upsertReceipt(ctx, {
        receiptKey,
        companyId,
        issueId,
        decisionId: decision.decisionId,
        owner: pull.owner,
        repo: pull.repo,
        pullNumber: pull.number,
        headSha,
        githubEvent,
        status: err.code === "self_review_blocked" ? "pending_identity" : "failed",
        errorCode: err.code ?? "github_error",
        errorMessage: err.message.slice(0, 2000),
        marker,
      });
      results.push({ pull, status: "failed", error: err.message });
    }
  }

  return { decision, results };
}

/**
 * @param {import("@paperclipai/plugin-sdk").PluginContext} ctx
 * @param {import("@paperclipai/plugin-sdk").PluginEvent} event
 */
export async function handleIssueUpdated(ctx, event) {
  const issueId = event.entityId;
  const companyId = event.companyId;
  if (!issueId || !companyId) return;

  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const transition =
    extractReviewDecisionTransition({
      before: payload._previous?.executionState ?? payload.before ?? {},
      after: payload.executionState ?? payload.after ?? payload.patch?.executionState ?? {},
    }) ?? null;

  if (!transition) {
    const issue = await ctx.issues.get(issueId, companyId);
    const current = readDecisionFromIssueState(issue?.executionState);
    if (!current) return;
    const prior = await ctx.state.get(lastDecisionScope(issueId));
    if (prior === current.decisionId) return;
    const result = await publishReviewDecisionsForIssue(ctx, companyId, issueId, current);
    if (result.results?.some((r) => r.status === "published")) {
      await ctx.state.set(lastDecisionScope(issueId), current.decisionId);
    }
    return result;
  }

  const result = await publishReviewDecisionsForIssue(ctx, companyId, issueId, transition);
  // Mark the decision as handled only once it was actually published, so a failure is retried.
  if (result.results?.some((r) => r.status === "published" || r.status === "already_published")) {
    await ctx.state.set(lastDecisionScope(issueId), transition.decisionId);
  }
  return result;
}
