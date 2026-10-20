/**
 * @param {import("@paperclipai/plugin-sdk").PluginContext} ctx
 */
export function table(ctx) {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) {
    throw new Error("Invalid plugin database namespace");
  }
  return `${ctx.db.namespace}.review_receipts`;
}

/**
 * @param {import("@paperclipai/plugin-sdk").PluginContext} ctx
 * @param {string} receiptKey
 */
export async function getReceipt(ctx, receiptKey) {
  const rows = await ctx.db.query(
    `SELECT * FROM ${table(ctx)} WHERE receipt_key = $1 LIMIT 1`,
    [receiptKey],
  );
  return rows[0] ?? null;
}

/**
 * @param {import("@paperclipai/plugin-sdk").PluginContext} ctx
 * @param {Record<string, unknown>} row
 */
export async function upsertReceipt(ctx, row) {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx)} (
      receipt_key, company_id, issue_id, decision_id, owner, repo, pull_number,
      head_sha, github_event, status, github_review_id, github_review_url,
      error_code, error_message, marker, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now()
    )
    ON CONFLICT (receipt_key) DO UPDATE SET
      status = EXCLUDED.status,
      github_review_id = COALESCE(EXCLUDED.github_review_id, ${table(ctx)}.github_review_id),
      github_review_url = COALESCE(EXCLUDED.github_review_url, ${table(ctx)}.github_review_url),
      error_code = EXCLUDED.error_code,
      error_message = EXCLUDED.error_message,
      marker = EXCLUDED.marker,
      updated_at = now()`,
    [
      row.receiptKey,
      row.companyId,
      row.issueId,
      row.decisionId,
      row.owner,
      row.repo,
      row.pullNumber,
      row.headSha,
      row.githubEvent,
      row.status,
      row.githubReviewId ?? null,
      row.githubReviewUrl ?? null,
      row.errorCode ?? null,
      row.errorMessage ?? null,
      row.marker ?? null,
    ],
  );
}
