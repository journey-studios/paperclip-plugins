import { CANCEL_ACTIONS, HANDLED_ACTIONS, ORIGIN_KIND, TERMINAL_ISSUE_STATUSES } from "./constants.js";
import { loadConfig as loadMergedConfig } from "./company-config.js";
import { normalizePull } from "./events.js";
import { createGithubClient } from "./github-client.js";
import { buildIssueBody, buildLimitComment, buildNewHeadComment, issueTitle } from "./package-builder.js";
import { decideReview } from "./routing.js";
import { createStore } from "./state.js";

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;
const MAX_FETCH_ATTEMPTS = 6;
const MAX_WAKE_ATTEMPTS = 5;
const CAPACITY_RETRY_MS = 60_000;

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
  const log = ctx.logger;
  const locks = new Map();
  let kicking = false;

  const loadConfig = () => loadMergedConfig(ctx);

  async function tokenFor(repoCfg, owner) {
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
    const token = await tokenFor(repoCfg, owner);
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
        await store.dequeue(key);
        // The PR leaves the queue unreviewed. Forget the listing ETag so the next reconcile lists the
        // repository again (instead of a 304) and queues this head once GitHub answers.
        await store.clearEtag(repoCfg.fullName.toLowerCase());
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

    if (issue && !isTerminal(issue)) {
      await ctx.issues.createComment(issue.id, buildNewHeadComment({ pull, round, maxRounds: repoCfg.maxRoundsPerPr }), repoCfg.companyId);
    } else {
      issue = await ctx.issues.create({
        companyId: repoCfg.companyId,
        projectId: repoCfg.projectId,
        title: issueTitle(pull),
        description: buildIssueBody({ pull, files, repoCfg, round, filesTruncated }),
        status: "todo",
        priority: "medium",
        assigneeAgentId: decision.reviewerAgentId,
        originKind: ORIGIN_KIND,
        originId: `${repoCfg.fullName}#${pull.number}`,
      });
    }

    const queued = await wake(issue, repoCfg.companyId, key, pull.headSha);
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
  async function reconcile({ maxProcess = 20 } = {}) {
    const summary = { repos: 0, enqueued: 0, cancelled: 0, wakeRetried: 0, processed: 0, errors: 0 };
    const config = await loadConfig();

    for (const repoCfg of config.repositories.values()) {
      if (repoCfg.killSwitch) continue;
      summary.repos += 1;
      const [owner, name] = repoCfg.fullName.split("/");
      try {
        const token = await tokenFor(repoCfg, owner);
        if (!token) continue;
        const repoKey = repoCfg.fullName.toLowerCase();
        const listing = await github.listOpenPulls(token, owner, name, await store.getEtag(repoKey));
        if (listing.notModified) continue;

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
        // Remember the listing only after all of it was handled. If a step above throws, the next run
        // must fetch the listing again instead of getting a 304 and never seeing this work.
        if (listing.etag) await store.setEtag(repoKey, listing.etag);
      } catch (error) {
        summary.errors += 1;
        log.warn("github-pr-intake: reconcile failed for repository", { repo: repoCfg.fullName, error: message(error) });
      }
    }
    summary.wakeRetried = await retryWakeups();
    summary.processed = await processDue(maxProcess);
    return summary;
  }

  return { onPullEvent, processDue, kick, reconcile, retryWakeups };
}
