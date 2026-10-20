import { randomUUID } from "node:crypto";
import { ORIGIN_KIND } from "./manifest.js";
import { reviewIssueDescription } from "./github.js";

function table(ctx) {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace)) {
    throw new Error("Invalid plugin database namespace");
  }
  return `${ctx.db.namespace}.review_jobs`;
}
const active = ["dispatching", "running"];
const MAX_QUEUE_SCAN = 20;

function isUniqueConflict(error) {
  return error?.code === "23505" || /duplicate key|unique constraint/i.test(String(error?.message ?? error));
}

export async function enqueueReview(ctx, companyId, route, event) {
  const name = table(ctx);
  // Only pending old revisions are superseded; an in-flight review must
  // finish/expire safely before the new SHA can start on the same agent.
  await ctx.db.execute(
    `UPDATE ${name} SET status='superseded', updated_at=now()
     WHERE company_id=$1 AND repository=$2 AND pr_number=$3
       AND head_sha<>$4 AND remote_updated_at <= $5::timestamptz AND status='queued'`,
    [companyId, event.repository, event.number, event.sha, event.updatedAt],
  );
  const id = randomUUID();
  const inserted = await ctx.db.execute(
    `INSERT INTO ${name}
      (id,company_id,project_id,reviewer_agent_id,repository,pr_number,head_sha,remote_updated_at,
       pr_url,pr_title,base_ref,author_login,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11,$12,'queued')
     ON CONFLICT (company_id,repository,pr_number,head_sha) DO NOTHING`,
    [
      id, companyId, route.projectId, route.reviewerAgentId,
      event.repository, event.number, event.sha, event.updatedAt, event.url,
      event.title, event.baseRef, event.authorLogin,
    ],
  );
  if (inserted.rowCount === 0) {
    // A converted draft or closed PR may later become reviewable at the
    // same SHA. Reopen only when GitHub reports a newer lifecycle event.
    await ctx.db.execute(
      `UPDATE ${name} SET status='queued',remote_updated_at=$5::timestamptz,
       next_attempt_at=now(),attempts=0,last_error=NULL,updated_at=now()
       WHERE company_id=$1 AND repository=$2 AND pr_number=$3
         AND head_sha=$4 AND status IN ('closed','superseded')
         AND remote_updated_at<$5::timestamptz`,
      [companyId, event.repository, event.number, event.sha, event.updatedAt],
    );
  }
  // A delayed GitHub delivery must not replace a newer head with an old SHA.
  await ctx.db.execute(
    `UPDATE ${name} newer SET status='superseded',updated_at=now()
     WHERE newer.company_id=$1 AND newer.repository=$2 AND newer.pr_number=$3
       AND newer.head_sha=$4 AND newer.status='queued'
       AND EXISTS (SELECT 1 FROM ${name} latest
         WHERE latest.company_id=newer.company_id AND latest.repository=newer.repository
           AND latest.pr_number=newer.pr_number
           AND latest.remote_updated_at>newer.remote_updated_at)`,
    [companyId, event.repository, event.number, event.sha],
  );
  return { created: inserted.rowCount > 0, id };
}

export async function closeReview(ctx, companyId, event, status = "closed") {
  const name = table(ctx);
  // Don't clear active reviewer locks for a run that is already executing.
  await ctx.db.execute(
    `UPDATE ${name}
       SET status=$4, updated_at=now(), last_error='PR became inactive'
       WHERE company_id=$1 AND repository=$2 AND pr_number=$3
         AND status='queued' AND remote_updated_at<=$5::timestamptz`,
    [companyId, event.repository, event.number, status, event.updatedAt],
  );
  await ctx.db.execute(
    `UPDATE ${name} SET last_error='PR became inactive during review',updated_at=now()
       WHERE company_id=$1 AND repository=$2 AND pr_number=$3
         AND status IN ('dispatching','running')`,
    [companyId, event.repository, event.number],
  );
}

async function loadReady(ctx, companyId) {
  return ctx.db.query(
    `SELECT * FROM ${table(ctx)}
       WHERE company_id=$1 AND status='queued'
         AND next_attempt_at<=now()
       ORDER BY priority DESC,created_at ASC LIMIT ${MAX_QUEUE_SCAN}`,
    [companyId],
  );
}

async function claim(ctx, job) {
  try {
    const result = await ctx.db.execute(
      `UPDATE ${table(ctx)} SET
           status='dispatching',dispatch_lease_until=now()+interval '3 minutes',
           updated_at=now()
         WHERE id=$1 AND company_id=$2 AND status='queued'
           AND next_attempt_at<=now()
           AND NOT EXISTS (
             SELECT 1 FROM ${table(ctx)} busy
             WHERE busy.company_id=$2 AND busy.reviewer_agent_id=$3
               AND busy.status IN ('dispatching','running')
           )`,
      [job.id, job.company_id, job.reviewer_agent_id],
    );
    return result.rowCount === 1;
  } catch (error) {
    if (isUniqueConflict(error)) return false;
    throw error;
  }
}

async function findOrCreateIssue(ctx, job) {
  const existing = await ctx.issues.list({
    companyId: job.company_id,
    originKind: ORIGIN_KIND,
    originId: `github:${job.repository}#${job.pr_number}@${job.head_sha}`,
    limit: 5,
  });
  if (existing.length > 1) throw new Error("Duplicate Paperclip Issues for one PR/SHA");
  if (existing[0]) return existing[0];

  const [agent, project] = await Promise.all([
    ctx.agents.get(job.reviewer_agent_id, job.company_id),
    ctx.projects.get(job.project_id, job.company_id),
  ]);
  if (!agent || agent.status === "terminated" || agent.status === "paused") {
    throw new Error("Reviewer agent not available in target company");
  }
  if (!project) throw new Error("Target project not found in reviewer company");

  return ctx.issues.create({
    companyId: job.company_id,
    projectId: job.project_id,
    title: `Review ${job.repository}#${job.pr_number} · ${job.head_sha.slice(0, 8)}`,
    description: reviewIssueDescription(job),
    status: "todo",
    priority: "high",
    assigneeAgentId: job.reviewer_agent_id,
    originKind: ORIGIN_KIND,
    originId: `github:${job.repository}#${job.pr_number}@${job.head_sha}`,
  });
}

async function saveIssue(ctx, job, issueId) {
  await ctx.db.execute(
    `UPDATE ${table(ctx)} SET issue_id=$3,updated_at=now()
     WHERE id=$1 AND company_id=$2 AND status='dispatching'`,
    [job.id, job.company_id, issueId],
  );
}

async function failDispatch(ctx, job, error, maxAttempts) {
  const attempts = Number(job.attempts || 0) + 1;
  const retry = attempts < maxAttempts;
  await ctx.db.execute(
    `UPDATE ${table(ctx)}
       SET status=$3, attempts=$4,
           next_attempt_at=now()+($5 * interval '1 second'),
           last_error=$6,dispatch_lease_until=NULL,updated_at=now()
       WHERE id=$1 AND company_id=$2 AND status='dispatching'`,
    [
      job.id, job.company_id, retry ? "queued" : "failed",
      attempts, Math.min(600, 30 * (2 ** attempts)),
      String(error?.message ?? error).slice(0, 400),
    ],
  );
}

async function dispatchOne(ctx, job, maxAttempts) {
  if (!await claim(ctx, job)) return false;
  try {
    const issue = await findOrCreateIssue(ctx, job);
    await saveIssue(ctx, job, issue.id);
    const wake = await ctx.issues.requestWakeup(issue.id, job.company_id, {
      reason: "github_pull_request_review",
      contextSource: "pr-review-orchestrator",
      idempotencyKey: `pr-review:${job.repository}#${job.pr_number}@${job.head_sha}`,
    });
    if (!wake.queued && !wake.runId) {
      throw new Error("Paperclip declined the review wakeup");
    }
    await ctx.db.execute(
      `UPDATE ${table(ctx)}
         SET status='running',wake_run_id=$3,dispatch_lease_until=NULL,
             attempts=attempts+1,last_error=NULL,updated_at=now()
         WHERE id=$1 AND company_id=$2 AND status='dispatching'`,
      [job.id, job.company_id, wake.runId ?? null],
    );
    return true;
  } catch (error) {
    await failDispatch(ctx, job, error, maxAttempts);
    ctx.logger.warn("PR review dispatch failed", {
      companyId: job.company_id,
      repository: job.repository,
      prNumber: job.pr_number,
      error: String(error?.message ?? error).slice(0, 300),
    });
    return false;
  }
}

export async function dispatchQueued(ctx, companyId, options = {}) {
  const maxAttempts = options.maxAttempts ?? 2;
  let dispatched = 0;
  for (const job of await loadReady(ctx, companyId)) {
    if (await dispatchOne(ctx, job, maxAttempts)) dispatched++;
  }
  return { dispatched };
}

export async function finishReview(ctx, companyId, issueId, succeeded, maxAttempts = 2) {
  if (!issueId) return { updated: false };
  const rows = await ctx.db.query(
    `SELECT * FROM ${table(ctx)} WHERE company_id=$1 AND issue_id=$2 AND status='running' LIMIT 1`,
    [companyId, issueId],
  );
  const job = rows[0];
  if (!job) return { updated: false };
  if (succeeded) {
    const updated = await ctx.db.execute(
      `UPDATE ${table(ctx)} SET status='awaiting_publication',updated_at=now()
         WHERE id=$1 AND company_id=$2 AND status='running'`,
      [job.id, companyId],
    );
    // The JOU-490 publisher is authoritative for GitHub review receipts.
    return { updated: updated.rowCount > 0, awaitingPublication: updated.rowCount > 0 };
  }
  const attempts = Number(job.attempts);
  const mayRetry = attempts < maxAttempts;
  const updated = await ctx.db.execute(
    `UPDATE ${table(ctx)}
       SET status=$3,next_attempt_at=now()+interval '2 minutes',
           last_error='Reviewer run failed or cancelled',updated_at=now()
       WHERE id=$1 AND company_id=$2 AND status='running'`,
    [job.id, companyId, mayRetry ? "queued" : "failed"],
  );
  return { updated: updated.rowCount > 0, retry: mayRetry };
}

export async function finishByRunId(ctx, companyId, runId, succeeded, maxAttempts = 2) {
  if (!runId) return { updated: false };
  const rows = await ctx.db.query(
    `SELECT issue_id FROM ${table(ctx)}
       WHERE company_id=$1 AND wake_run_id=$2 AND status='running' LIMIT 1`,
    [companyId, runId],
  );
  if (!rows[0]?.issue_id) return { updated: false };
  return finishReview(ctx, companyId, rows[0].issue_id, succeeded, maxAttempts);
}

export async function reconcileCompany(ctx, companyId, options = {}) {
  const maxAttempts = options.maxAttempts ?? 2;
  const name = table(ctx);
  // Recover a crash between claim and wakeup only after rechecking Issue
  // state. Never blindly issue another wake for a running Issue.
  const expiring = await ctx.db.query(
    `SELECT * FROM ${name} WHERE company_id=$1 AND status='dispatching'
       AND dispatch_lease_until<now() LIMIT 40`,
    [companyId],
  );
  for (const job of expiring) {
    const issue = job.issue_id ? await ctx.issues.get(job.issue_id, companyId) : null;
    if (issue && ["in_progress", "in_review", "done"].includes(issue.status)) {
      await ctx.db.execute(
        `UPDATE ${name} SET status=$3,dispatch_lease_until=NULL,updated_at=now()
           WHERE id=$1 AND company_id=$2 AND status='dispatching'`,
        [job.id, companyId, issue.status === "in_progress" ? "running" : "awaiting_publication"],
      );
    } else {
      await ctx.db.execute(
        `UPDATE ${name} SET status='queued',dispatch_lease_until=NULL,
         next_attempt_at=now()+interval '30 seconds',updated_at=now()
         WHERE id=$1 AND company_id=$2 AND status='dispatching'`,
        [job.id, companyId],
      );
    }
  }
  // The event bus may drop a run terminal notification; the Issue is
  // canonical. Do not free capacity solely due to an elapsed wall-clock lease.
  const running = await ctx.db.query(
    `SELECT * FROM ${name} WHERE company_id=$1 AND status='running' LIMIT 40`,
    [companyId],
  );
  for (const job of running) {
    if (!job.issue_id) continue;
    const issue = await ctx.issues.get(job.issue_id, companyId);
    if (issue?.status === "done" || issue?.status === "in_review") {
      await finishReview(ctx, companyId, issue.id, true, maxAttempts);
    } else if (issue?.status === "cancelled") {
      await finishReview(ctx, companyId, issue.id, false, maxAttempts);
    }
  }
  return dispatchQueued(ctx, companyId, { maxAttempts });
}

export async function queueStats(ctx, companyId) {
  return ctx.db.query(
    `SELECT status,count(*)::int AS count FROM ${table(ctx)}
       WHERE company_id=$1 GROUP BY status ORDER BY status LIMIT 20`,
    [companyId],
  );
}
