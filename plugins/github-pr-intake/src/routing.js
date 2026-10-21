import { matchesAny } from "./glob.js";

function ruleMatches(rule, pull, files) {
  const criteria = [];
  if (rule.paths.length) criteria.push(files.some((file) => matchesAny(file.filename, rule.paths)));
  if (rule.labels.length) criteria.push(pull.labels.some((label) => rule.labels.includes(label)));
  if (rule.authors.length) criteria.push(rule.authors.includes(pull.author.login.toLowerCase()));
  if (rule.baseBranches.length) criteria.push(rule.baseBranches.includes(pull.baseRef));
  // A rule with no criteria never matches, so a misconfigured rule cannot hijack every PR.
  return criteria.length > 0 && criteria.every(Boolean);
}

/**
 * Decides whether a pull request should be reviewed and by whom.
 * `files` may be null for a cheap first pass (before the file list is fetched).
 * `filesTruncated` means the list is only a prefix of the changed files, so conclusions that need the
 * whole list ("every file is ignored") cannot be drawn.
 * @returns {{ action: "skip", reason: string } | { action: "review", reviewerAgentId: string, rule: number | null }}
 */
export function decideReview(config, repoCfg, pull, files, { filesTruncated = false } = {}) {
  if (config.killSwitch || repoCfg.killSwitch) return { action: "skip", reason: "kill_switch" };
  if (pull.state !== "open") return { action: "skip", reason: "closed" };
  if (pull.draft) return { action: "skip", reason: "draft" };
  if (pull.labels.some((label) => repoCfg.skipLabels.includes(label))) {
    return { action: "skip", reason: "skip_label" };
  }
  if (repoCfg.baseBranches.length && !repoCfg.baseBranches.includes(pull.baseRef)) {
    return { action: "skip", reason: "base_branch" };
  }
  if (pull.author.isBot && !repoCfg.reviewBots) return { action: "skip", reason: "bot_author" };
  if (files && !filesTruncated && files.length > 0 && repoCfg.ignorePaths.length) {
    if (files.every((file) => matchesAny(file.filename, repoCfg.ignorePaths))) {
      return { action: "skip", reason: "ignored_paths_only" };
    }
  }
  const candidates = files ?? [];
  const index = repoCfg.rules.findIndex((rule) => ruleMatches(rule, pull, candidates));
  if (index >= 0) {
    return { action: "review", reviewerAgentId: repoCfg.rules[index].reviewerAgentId, rule: index };
  }
  return { action: "review", reviewerAgentId: repoCfg.defaultReviewerAgentId, rule: null };
}
