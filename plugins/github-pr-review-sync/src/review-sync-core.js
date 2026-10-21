const OUTCOMES = new Set(["approved", "changes_requested"]);

/** @typedef {{ owner: string, repo: string, number: number }} PullRef */

/**
 * @param {unknown} outcome
 * @returns {boolean}
 */
export function isReviewDecisionOutcome(outcome) {
  return typeof outcome === "string" && OUTCOMES.has(outcome);
}

/**
 * Map Paperclip review outcome to GitHub review event. Fail-closed on unknown outcomes.
 * @param {"approved"|"changes_requested"} outcome
 * @returns {"APPROVE"|"REQUEST_CHANGES"|null}
 */
export function mapOutcomeToGitHubEvent(outcome) {
  if (outcome === "approved") return "APPROVE";
  if (outcome === "changes_requested") return "REQUEST_CHANGES";
  return null;
}

/**
 * Stable idempotency key for a formal review publication attempt.
 * @param {{ companyId: string, issueId: string, decisionId: string, pull: PullRef, headSha: string, event: string }} input
 */
export function buildReceiptKey(input) {
  const pr = `${input.pull.owner}/${input.pull.repo}#${input.pull.number}`;
  return [input.companyId, input.issueId, input.decisionId, pr, input.headSha, input.event].join(":");
}

/**
 * Detect GitHub self-review 422 (author cannot request changes on own PR).
 * @param {{ status?: number, message?: string }} error
 */
export function isSelfReviewBlocked(error) {
  if (error?.status !== 422) return false;
  const message = String(error.message ?? "").toLowerCase();
  return message.includes("own pull request") || message.includes("can not request changes");
}

/**
 * Parse `owner/repo#number` or GitHub pull URL.
 * @param {string} raw
 * @returns {PullRef|null}
 */
export function parsePullReference(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const trimmed = raw.trim();
  const short = trimmed.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (short) {
    return { owner: short[1], repo: short[2], number: Number(short[3]) };
  }
  const url = trimmed.match(
    /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/i,
  );
  if (url) {
    return { owner: url[1], repo: url[2], number: Number(url[3]) };
  }
  return null;
}

/**
 * @param {{ before?: { lastDecisionOutcome?: string|null, lastDecisionId?: string|null }, after?: { lastDecisionOutcome?: string|null, lastDecisionId?: string|null } }} patch
 */
export function extractReviewDecisionTransition(patch) {
  const before = patch.before ?? {};
  const after = patch.after ?? {};
  const outcome = after.lastDecisionOutcome;
  const decisionId = after.lastDecisionId;
  if (!decisionId || !isReviewDecisionOutcome(outcome)) return null;
  if (before.lastDecisionId === decisionId && before.lastDecisionOutcome === outcome) return null;
  return { decisionId, outcome };
}
