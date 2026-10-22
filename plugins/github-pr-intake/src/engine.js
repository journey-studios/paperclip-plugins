import { CANCEL_ACTIONS, HANDLED_ACTIONS, ORIGIN_KIND, TERMINAL_ISSUE_STATUSES } from "./constants.js";
import { loadConfig as loadMergedConfig } from "./company-config.js";
import { normalizePull } from "./events.js";
import { createInstallationTokens } from "../../../shared/github-app-token.js";
import { createGithubClient } from "./github-client.js";
import { buildCiUpdateComment, ciEmpty, ciPending, ciUnavailable } from "./review-evidence.js";
import { TRIAGE_MARKER, createTriageClient, formatReviewerHypotheses, formatTriageComment } from "./triage.js";
import { buildIssueBody, buildLimitComment, buildNewHeadComment, issueTitle } from "./package-builder.js";
import { decideReview } from "./routing.js";
import { createStore } from "./state.js";

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;
const MAX_FETCH_ATTEMPTS = 6;
const MAX_WAKE_ATTEMPTS = 5;
const CAPACITY_RETRY_MS = 60_000;
const TRIAGE_GIVE_UP_MS = 30 * 60_000;
const CI_WATCH_GIVE_UP_MS = 45 * 60_000;
// Checks are registered shortly after a push; an empty list is only believed after this long.
const CI_NO_CHECKS_WINDOW_MS = 10 * 60_000;
const MAX_TRIAGE_ATTEMPTS = 3;
// The triage service is only ever given a token that can read; it never needs to write.
const READ_ONLY_PERMISSIONS = { contents: "read", pull_requests: "read", metadata: "read" };

const prKey = (repo, number) => `${repo.toLowerCase()}#${number}`;
const isTerminal = (issue) => !issue || TERMINAL_ISSUE_STATUSES.has(issue.status);
const message = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Review orchestration. Every dependency comes through `ctx` (or `deps` in tests), so the whole
 * flow runs against fakes. A review for one PR is always handled under that PR's lock.
 */
export function createEngine(ctx, deps = {}) {
  const now = deps.now ?? Date.now;
  const store = deps.store ?? createStore(ctx);
  const github = deps.github ?? createGithubClient(ctx);
  const appTokens = deps.appTokens ?? createInstallationTokens(ctx.http);
  const triage = deps.triage ?? createTriageClient(ctx);
  const log = ctx.logger;
  const locks = new Map();
  let kicking = false;

  const loadConfig = () => loadMergedConfig(ctx);

  async function tokenFor(repoCfg, owner, repo, { readOnly = false } = {}) {
    // A narrower token can only be minted from a GitHub App; a static token cannot be narrowed, so it is refused.
    if (readOnly && !repoCfg.githubApp) return null;
    // When a GitHub App is configured it is the only identity: a failure there must not fall back to a static token.
    if (repoCfg.githubApp) {
      const privateKeyPem = await ctx.secrets.resolve(repoCfg.githubApp.privateKeyRef, {
        companyId: repoCfg.companyId,
        configPath: "githubApp.privateKeyRef",
      });
      if (typeof privateKeyPem !== "string" || !privateKeyPem.trim()) return null;
      try {
        return await appTokens.tokenFor({
          appId: repoCfg.githubApp.appId,
          privateKeyPem,
          owner,
          repo,
          ...(readOnly ? { permissions: READ_ONLY_PERMISSIONS } : {}),
        });
      } catch (error) {
        log.warn("github-pr-intake: GitHub App token unavailable", { owner, repo, error: message(error) });
        return null;
      }
    }
    const ref = repoCfg.tokenRefs[owner.toLowerCase()] ?? repoCfg.tokenRefs["*"];
    if (!ref) return null;
    const value = await ctx.secrets.resolve(ref, { companyId: repoCfg.companyId, configPath: `githubTokenRefs.${owner}` });
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  function withLock(key, operation) {
    const prior = locks.get(key) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(operation);
    locks.set(key, current);
    return current.finally(() => {
      if (locks.get(key) === current) locks.delete(key);
    });
  }

  async function wake(issue, companyId, key, sha) {
    try {
      const result = await ctx.issues.requestWakeup(issue.id, companyId, {
        reason: "github_pr_review_requested",
        contextSource: "github-pr-intake",
        // The issue id is part of the key: a review cancelled and requested again for the same head gets a
        // new issue, so it is a new request, while a retry of the same wake reuses the same key.
        idempotencyKey: `pr-intake:${key}@${sha}#${issue.id}`,
      });
      return Boolean(result?.queued);
    } catch (error) {
      log.warn("github-pr-intake: wakeup failed", { key, error: message(error) });
      return false;
    }
  }

  async function activeReviews(exceptKey, companyId) {
    let active = 0;
    for (const key of await store.prKeys()) {
      if (key === exceptKey) continue;
      const record = await store.getPr(key);
      if (record?.status !== "reviewing" || record.companyId !== companyId) continue;
      const issue = await ctx.issues.get(record.issueId, record.companyId);
      if (isTerminal(issue)) await store.savePr(key, { ...record, status: "finished", updatedAt: now() });
      else active += 1;
    }
    return active;
  }

  async function cancelReview(key, pull, action) {
    await store.dequeue(key);
    const record = await store.getPr(key);
    if (!record?.issueId) return;
    const issue = await ctx.issues.get(record.issueId, record.companyId);
    let reviewedSha = record.reviewedSha;
    let round = record.round;
    if (!isTerminal(issue)) {
      const why = action === "converted_to_draft" ? "converted back to a draft" : pull.merged ? "merged" : "closed";
      await ctx.issues.createComment(issue.id, `The pull request was ${why}; this review is no longer needed.`, record.companyId);
      await ctx.issues.update(issue.id, { status: "cancelled" }, record.companyId);
      // A review that was cancelled before it finished never happened: the same head must be reviewable
      // again if the PR is reopened or marked ready. A finished review keeps its SHA (no repeat review).
      reviewedSha = null;
      // ...and it must not use up the round limit either (the wake key no longer depends on the round).
      round = Math.max(0, (record.round ?? 1) - 1);
    }
    await store.savePr(key, {
      ...record,
      reviewedSha,
      round,
      status: action === "converted_to_draft" ? "draft" : "closed",
      updatedAt: now(),
    });
  }

  /** Cheap, webhook-safe step: decide and enqueue. The heavy work happens in processDue. */
  async function onPullEvent({ deliveryId, action, repo, pull }, { companyId } = {}) {
    const config = await loadConfig();
    const repoCfg = config.repositories.get(repo.toLowerCase());
    if (!repoCfg) return { status: "ignored", reason: "repo_not_configured" };
    // The delivery was signed with one company's secret: it may only touch that company's repositories.
    if (companyId && repoCfg.companyId !== companyId) return { status: "ignored", reason: "repo_not_in_company" };
    if (repoCfg.killSwitch) return { status: "ignored", reason: "kill_switch" };
    if (deliveryId && !(await store.markDeliverySeen(deliveryId))) return { status: "duplicate" };

    const key = prKey(repo, pull.number);
    if (CANCEL_ACTIONS.has(action) || pull.state === "closed") {
      await withLock(key, () => cancelReview(key, pull, action));
      return { status: "cancelled" };
    }
    if (!HANDLED_ACTIONS.has(action)) return { status: "ignored", reason: "action_not_handled" };

    const first = decideReview(repoCfg, pull, null);
    if (first.action === "skip") return { status: "skipped", reason: first.reason };

    // Only pushes are debounced: a newly opened or ready PR is reviewed right away.
    const delayMs = action === "synchronize" ? repoCfg.debounceSeconds * 1000 : 0;
    await withLock(key, () =>
      store.enqueue(key, { repo, number: pull.number, headSha: pull.headSha, dueAt: now() + delayMs, deliveryId, action }),
    );
    return { status: "queued", delayMs };
  }

  async function processPr(key) {
    const entry = await store.getQueue(key);
    if (!entry || entry.dueAt > now()) return "not_due";
    const config = await loadConfig();
    const repoCfg = config.repositories.get(entry.repo.toLowerCase());
    if (!repoCfg) {
      await store.dequeue(key);
      return "repo_not_configured";
    }
    if (repoCfg.killSwitch) return "kill_switch";
    const [owner, name] = repoCfg.fullName.split("/");
    const token = await tokenFor(repoCfg, owner, name);
    if (!token) {
      log.warn("github-pr-intake: no GitHub token for owner", { owner });
      await store.retryLater(key, entry, now() + RETRY_MAX_MS);
      return "no_token";
    }

    let pull;
    let files;
    let filesTruncated = false;
    try {
      pull = normalizePull(repoCfg.fullName, await github.getPull(token, owner, name, entry.number));
      const listed = await github.listPullFiles(token, owner, name, entry.number);
      files = listed.files;
      filesTruncated = listed.truncated;
    } catch (error) {
      const attempts = (entry.attempts ?? 0) + 1;
      log.warn("github-pr-intake: GitHub fetch failed", { key, attempts, error: message(error) });
      if (attempts >= MAX_FETCH_ATTEMPTS) {
        // The PR leaves the queue unreviewed; the next reconcile lists the repository again and queues this head.
        await store.dequeue(key);
      } else {
        await store.retryLater(key, entry, now() + Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_MS));
      }
      return "fetch_failed";
    }

    const record = (await store.getPr(key)) ?? { repo: repoCfg.fullName, number: pull.number };
    const decision = decideReview(repoCfg, pull, files, { filesTruncated });
    if (decision.action === "skip") {
      await store.dequeue(key);
      // handledSha stops reconcile from queueing this head again until a new commit arrives.
      await store.savePr(key, { ...record, lastSkip: decision.reason, handledSha: pull.headSha, updatedAt: now() });
      return `skipped:${decision.reason}`;
    }
    // The current head, not the webhook's, is the truth: one review request per head SHA.
    if (record.reviewedSha === pull.headSha) {
      await store.dequeue(key);
      return "already_requested";
    }

    const round = (record.round ?? 0) + 1;
    if (round > repoCfg.maxRoundsPerPr) {
      if (!record.limitNotified && record.issueId) {
        await ctx.issues.createComment(record.issueId, buildLimitComment({ pull, maxRounds: repoCfg.maxRoundsPerPr }), record.companyId);
      }
      await store.savePr(key, { ...record, limitNotified: true, handledSha: pull.headSha, updatedAt: now() });
      await store.dequeue(key);
      return "round_limit";
    }

    let issue = record.issueId ? await ctx.issues.get(record.issueId, repoCfg.companyId) : null;
    if (!issue) {
      // Recovery after a crash between creating the issue and saving the record.
      const found = await ctx.issues.list({
        companyId: repoCfg.companyId,
        originKind: ORIGIN_KIND,
        originId: `${repoCfg.fullName}#${pull.number}`,
        includePluginOperations: true,
        limit: 5,
      });
      issue = found.find((candidate) => !isTerminal(candidate)) ?? null;
    }
    // A new issue is about to be opened (none, or the previous one is finished): respect the cap.
    if ((!issue || isTerminal(issue)) && (await activeReviews(key, repoCfg.companyId)) >= repoCfg.maxConcurrentReviews) {
      await store.retryLater(key, { ...entry, attempts: 0 }, now() + CAPACITY_RETRY_MS);
      return "at_capacity";
    }

    const ci = await readCi(repoCfg, owner, name, pull.headSha, token);
    if (issue && !isTerminal(issue)) {
      await ctx.issues.createComment(issue.id, buildNewHeadComment({ pull, round, maxRounds: repoCfg.maxRoundsPerPr, files, ci }), repoCfg.companyId);
    } else {
      issue = await ctx.issues.create({
        companyId: repoCfg.companyId,
        projectId: repoCfg.projectId,
        title: issueTitle(pull),
        description: buildIssueBody({ pull, files, repoCfg, round, filesTruncated, ci }),
        status: "todo",
        priority: "medium",
        assigneeAgentId: decision.reviewerAgentId,
        originKind: ORIGIN_KIND,
        originId: `${repoCfg.fullName}#${pull.number}`,
      });
    }

    const queued = await wake(issue, repoCfg.companyId, key, pull.headSha);
    if (ciPending(ci) || ciEmpty(ci)) {
      await store.saveCiWatch(key, { repo: repoCfg.fullName, number: pull.number, issueId: issue.id, companyId: repoCfg.companyId, sha: pull.headSha, startedAt: now(), status: "watching" });
    }
    await requestTriage(key, repoCfg, owner, name, pull);
    await store.savePr(key, {
      repo: repoCfg.fullName,
      number: pull.number,
      companyId: repoCfg.companyId,
      issueId: issue.id,
      reviewerAgentId: decision.reviewerAgentId,
      reviewedSha: pull.headSha,
      round,
      status: "reviewing",
      wakePending: !queued,
      wakeAttempts: queued ? 0 : 1,
      url: pull.url,
      updatedAt: now(),
    });
    await store.dequeue(key);
    return queued ? "review_requested" : "review_requested_wake_pending";
  }

  async function processDue(limit = 10) {
    let processed = 0;
    for (const key of await store.queueKeys()) {
      const entry = await store.getQueue(key);
      if (!entry) {
        await store.dequeue(key);
        continue;
      }
      if (entry.dueAt > now()) continue;
      try {
        await withLock(key, () => processPr(key));
      } catch (error) {
        log.error("github-pr-intake: processing failed", { key, error: message(error) });
      }
      processed += 1;
      if (processed >= limit) break;
    }
    return processed;
  }

  /** Fire-and-forget after a webhook; the reconcile job also drains the queue if this is lost. */
  function kick() {
    if (kicking) return;
    kicking = true;
    queueMicrotask(() => {
      processDue(5)
        .catch((error) => log.error("github-pr-intake: kick failed", { error: message(error) }))
        .finally(() => {
          kicking = false;
        });
    });
  }

  async function retryWakeups() {
    let retried = 0;
    for (const key of await store.prKeys()) {
      const record = await store.getPr(key);
      if (!record?.wakePending || (record.wakeAttempts ?? 0) >= MAX_WAKE_ATTEMPTS) continue;
      const issue = await ctx.issues.get(record.issueId, record.companyId);
      if (isTerminal(issue)) {
        await store.savePr(key, { ...record, wakePending: false });
        continue;
      }
      const queued = await wake(issue, record.companyId, key, record.reviewedSha);
      await store.savePr(key, { ...record, wakePending: !queued, wakeAttempts: (record.wakeAttempts ?? 0) + 1, updatedAt: now() });
      retried += 1;
    }
    return retried;
  }

  /** Source of truth: recovers events lost while the webhook was down and closes stale reviews. */
  /** CI evidence for the review package. A failure to read it must never stop the review being requested. */
  async function readCi(repoCfg, owner, name, sha, token) {
    const read = async (value) => {
      const [checks, statuses] = await Promise.all([github.listCheckRuns(value, owner, name, sha), github.getCommitStatus(value, owner, name, sha)]);
      return { checks, statuses };
    };
    try {
      let ci = await read(token);
      // A cached installation token keeps the permissions it was minted with, so CI can look "unavailable" right
      // after the App was granted Checks access. Mint a fresh token once before saying so.
      if (ciUnavailable(ci) && repoCfg.githubApp) {
        appTokens.invalidate?.({ appId: repoCfg.githubApp.appId, owner, repo: name });
        const fresh = await tokenFor(repoCfg, owner, name);
        if (fresh && fresh !== token) ci = await read(fresh);
      }
      return ci;
    } catch (error) {
      log.warn("github-pr-intake: could not read CI", { owner, name, error: message(error) });
      return { error: true };
    }
  }

  /**
   * When checks were still running as the review was requested, adds a comment with their final result to the
   * review issue (once). Nothing is added to a finished issue or for a head that is no longer under review.
   */
  async function advanceCiWatch(config) {
    for (const key of await store.ciWatchKeys()) {
      const entry = await store.getCiWatch(key);
      if (!entry || entry.status !== "watching") continue;
      const repoCfg = config.repositories.get(entry.repo.toLowerCase());
      if (!repoCfg || repoCfg.killSwitch) continue;
      try {
        const record = await store.getPr(key);
        const issue = await ctx.issues.get(entry.issueId, entry.companyId);
        if (!record || record.reviewedSha !== entry.sha || isTerminal(issue)) {
          await store.saveCiWatch(key, { ...entry, status: "closed" });
          continue;
        }
        const [owner, name] = repoCfg.fullName.split("/");
        const token = await tokenFor(repoCfg, owner, name);
        if (!token) continue;
        const ci = await readCi(repoCfg, owner, name, entry.sha, token);
        const elapsed = now() - entry.startedAt;
        const timedOut = elapsed > CI_WATCH_GIVE_UP_MS;
        // A read error or a momentarily unreadable CI is not a result: try again until the window closes. An empty
        // list is not a result either until the checks had time to be registered.
        const waiting = ciPending(ci) || ciUnavailable(ci) || (ciEmpty(ci) && elapsed <= CI_NO_CHECKS_WINDOW_MS);
        if (waiting && !timedOut) continue;
        await ctx.issues.createComment(entry.issueId, buildCiUpdateComment({ sha: entry.sha, ci, final: !ciPending(ci) && !ciUnavailable(ci) }), entry.companyId);
        await store.saveCiWatch(key, { ...entry, status: "posted", postedAt: now() });
      } catch (error) {
        log.warn("github-pr-intake: CI watch step failed", { key, error: message(error) });
      }
    }
  }

  async function triageService(repoCfg) {
    if (!repoCfg.triageService) return null;
    const value = await ctx.secrets.resolve(repoCfg.triageService.tokenRef, {
      companyId: repoCfg.companyId,
      configPath: "triageService.tokenRef",
    });
    if (typeof value !== "string" || !value.trim()) return null;
    return { url: repoCfg.triageService.url, token: value.trim() };
  }

  /**
   * Asks the triage service for a first-pass review of this head. Advisory only: whatever happens here must
   * never affect the review issue, so every failure is logged and left for the next reconcile to retry.
   */
  async function requestTriage(key, repoCfg, owner, name, pull, attempts = 1) {
    if (!repoCfg.triageService) return;
    const prior = await store.getTriage(key).catch(() => null);
    if (prior?.sha === pull.headSha && attempts === 1 && prior.status !== "failed") return;
    const base = { repo: repoCfg.fullName, number: pull.number, companyId: repoCfg.companyId, sha: pull.headSha, attempts, commentId: prior?.commentId };
    try {
      const service = await triageService(repoCfg);
      const readToken = await tokenFor(repoCfg, owner, name, { readOnly: true });
      if (!service || !readToken) return;
      const job = await triage.submit(service, { repo: repoCfg.fullName, number: pull.number, head_sha: pull.headSha, token: readToken });
      await store.saveTriage(key, { ...base, jobId: job.id, status: "submitted", submittedAt: now() });
    } catch (error) {
      log.warn("github-pr-intake: triage request failed", { key, error: message(error) });
      await store.saveTriage(key, { ...base, status: "retry", submittedAt: now() }).catch(() => {});
    }
  }

  async function postTriage(key, entry, repoCfg, owner, name, result) {
    const token = await tokenFor(repoCfg, owner, name);
    if (!token) return false;
    const pull = normalizePull(repoCfg.fullName, await github.getPull(token, owner, name, entry.number));
    // A newer push has its own triage; an answer about an older head would mislead.
    if (pull.state !== "open" || pull.headSha !== entry.sha) {
      await store.saveTriage(key, { ...entry, status: "stale" });
      return true;
    }
    const body = formatTriageComment({ result, sha: entry.sha });
    let commentId = entry.commentId ?? null;
    if (!commentId) {
      const comments = await github.listIssueComments(token, owner, name, entry.number);
      // Only comments written by a bot count: the marker alone could be copied by anyone.
      commentId = comments.find((c) => c.user?.type === "Bot" && typeof c.body === "string" && c.body.startsWith(TRIAGE_MARKER))?.id ?? null;
    }
    let posted = null;
    if (commentId) {
      try {
        posted = await github.updateIssueComment(token, owner, name, commentId, body);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    posted ??= await github.createIssueComment(token, owner, name, entry.number, body);
    const reviewerNotified = await shareWithReviewer(key, entry, result);
    await store.saveTriage(key, { ...entry, status: "posted", commentId: posted.id, postedAt: now(), reviewerNotified });
    return true;
  }

  /**
   * Hands the triage to the reviewer agent as hypotheses to verify, so the full review starts from what the quick
   * pass saw and a diff-only false positive is dismissed before anything is published. Only while the review issue
   * for this same head is still open; a failure here never affects the public triage comment.
   */
  async function shareWithReviewer(key, entry, result) {
    const body = formatReviewerHypotheses({ result, sha: entry.sha });
    if (!body) return false;
    try {
      const record = await store.getPr(key);
      if (!record?.issueId || record.reviewedSha !== entry.sha) return false;
      const issue = await ctx.issues.get(record.issueId, record.companyId);
      if (isTerminal(issue)) return false;
      await ctx.issues.createComment(issue.id, body, record.companyId);
      return true;
    } catch (error) {
      log.warn("github-pr-intake: could not share the triage with the reviewer", { key, error: message(error) });
      return false;
    }
  }

  async function advanceOneTriage(key, entry, repoCfg) {
    const [owner, name] = repoCfg.fullName.split("/");
    if (now() - entry.submittedAt > TRIAGE_GIVE_UP_MS) {
      await store.saveTriage(key, { ...entry, status: "failed", reason: "timeout" });
      return true;
    }
    const resubmit = async (reason) => {
      if (entry.attempts >= MAX_TRIAGE_ATTEMPTS) {
        await store.saveTriage(key, { ...entry, status: "failed", reason });
        return true;
      }
      await requestTriage(key, repoCfg, owner, name, { number: entry.number, headSha: entry.sha }, entry.attempts + 1);
      return true;
    };
    if (entry.status === "retry") return resubmit("submit_failed");
    const service = await triageService(repoCfg);
    if (!service) return false;
    const state = await triage.status(service, entry.jobId);
    if (state.status === "queued" || state.status === "running") return false;
    if (state.status !== "done") return resubmit(state.error ?? state.status);
    return postTriage(key, entry, repoCfg, owner, name, state.result);
  }

  /** Polls the submitted triage jobs and posts the finished ones. Returns how many entries moved forward. */
  async function advanceTriage(config) {
    let advanced = 0;
    for (const key of await store.triageKeys()) {
      const entry = await store.getTriage(key);
      if (!entry || (entry.status !== "submitted" && entry.status !== "retry")) continue;
      const repoCfg = config.repositories.get(entry.repo.toLowerCase());
      if (!repoCfg?.triageService || repoCfg.killSwitch) continue;
      try {
        if (await advanceOneTriage(key, entry, repoCfg)) advanced += 1;
      } catch (error) {
        log.warn("github-pr-intake: triage step failed", { key, error: message(error) });
      }
    }
    return advanced;
  }

  async function reconcile({ maxProcess = 20 } = {}) {
    const summary = { repos: 0, enqueued: 0, cancelled: 0, wakeRetried: 0, processed: 0, errors: 0, triage: 0 };
    const config = await loadConfig();

    for (const repoCfg of config.repositories.values()) {
      if (repoCfg.killSwitch) continue;
      summary.repos += 1;
      const [owner, name] = repoCfg.fullName.split("/");
      try {
        const token = await tokenFor(repoCfg, owner, name);
        if (!token) continue;
        const repoKey = repoCfg.fullName.toLowerCase();
        const listing = await github.listOpenPulls(token, owner, name);

        // First look at a repository: pull requests that are already open are recorded as handled instead of
        // reviewed (unless asked otherwise), so adding a repository does not trigger a backlog of reviews.
        const baseline = !repoCfg.reviewExistingPullRequests && !(await store.isBaselined(repoKey));
        const open = new Set();
        for (const raw of listing.pulls) {
          const pull = normalizePull(repoCfg.fullName, raw);
          const key = prKey(repoCfg.fullName, pull.number);
          open.add(key);
          if (decideReview(repoCfg, pull, null).action !== "review") continue;
          const [record, queued] = [await store.getPr(key), await store.getQueue(key)];
          // Only PRs the plugin has never seen are part of the backlog; anything it already tracks or
          // has queued (a webhook that arrived before the first reconcile) keeps its normal flow.
          if (baseline && !record && !queued) {
            await store.savePr(key, {
              repo: repoCfg.fullName,
              number: pull.number,
              companyId: repoCfg.companyId,
              handledSha: pull.headSha,
              updatedAt: now(),
            });
            continue;
          }
          if (queued || record?.reviewedSha === pull.headSha || record?.handledSha === pull.headSha) continue;
          await withLock(key, () =>
            store.enqueue(key, { repo: repoCfg.fullName, number: pull.number, headSha: pull.headSha, dueAt: now(), action: "reconcile" }),
          );
          summary.enqueued += 1;
        }

        for (const key of await store.prKeys()) {
          const record = await store.getPr(key);
          if (record?.status !== "reviewing" || record.repo.toLowerCase() !== repoKey || open.has(key)) continue;
          const pull = normalizePull(repoCfg.fullName, await github.getPull(token, owner, name, record.number));
          if (pull.state === "closed") {
            await withLock(key, () => cancelReview(key, pull, "closed"));
            summary.cancelled += 1;
          }
        }
        if (baseline) await store.setBaselined(repoKey);
      } catch (error) {
        summary.errors += 1;
        log.warn("github-pr-intake: reconcile failed for repository", { repo: repoCfg.fullName, error: message(error) });
      }
    }
    summary.triage = await advanceTriage(config);
    await advanceCiWatch(config);
    summary.wakeRetried = await retryWakeups();
    summary.processed = await processDue(maxProcess);
    return summary;
  }

  return { onPullEvent, processDue, kick, reconcile, retryWakeups };
}
