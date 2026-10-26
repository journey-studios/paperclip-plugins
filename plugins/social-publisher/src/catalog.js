import { createHash, randomUUID } from "node:crypto";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PLATFORMS = ["instagram", "facebook_page", "threads", "x"];
export class CatalogError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "CatalogError";
    this.status = status;
  }
}
export function assertUuid(value, label = "id") {
  if (typeof value !== "string" || !UUID_REGEX.test(value))
    throw new CatalogError(`Invalid ${label}: must be a valid UUID`);
  return value.toLowerCase();
}
export function tablePrefix(ctx) {
  const schema = ctx.db?.namespace;
  if (typeof schema !== "string" || !/^plugin_[a-z0-9_]+$/.test(schema))
    throw new CatalogError("INVALID_NAMESPACE", 500);
  return schema;
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function contentHash(post) {
  return createHash("sha256")
    .update(
      canonical({
        text: post.text,
        mediaUrls: post.mediaUrls ?? [],
        platformCustomizations: post.platformCustomizations ?? {},
        linkUrl: post.linkUrl ?? null,
        campaign: post.campaign ?? null,
        targets: post.targets ?? [],
        dryRun: post.dryRun !== false,
        metadata: post.metadata ?? {},
      }),
    )
    .digest("hex");
}
const accountColumns = `id, company_id AS "companyId", platform, account_name AS "accountName", account_id_external AS "accountIdExternal", credentials_ref AS "credentialsRef", scopes, policy, autonomous_opt_in AS "autonomousOptIn", kill_switch AS "killSwitch", daily_limit AS "dailyLimit", CASE WHEN last_reset_date = to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') THEN posts_today ELSE 0 END AS "postsToday", status, verification_status AS "verificationStatus", verified_at AS "verifiedAt", allowed_agent_ids AS "allowedAgentIds", api_cost_approved AS "apiCostApproved", estimated_post_cost_cents AS "estimatedPostCostCents", daily_cost_limit_cents AS "dailyCostLimitCents", last_error AS "lastError", created_at AS "createdAt", updated_at AS "updatedAt"`;
const postColumns = `id, company_id AS "companyId", project_id AS "projectId", idempotency_key AS "idempotencyKey", root_post_id AS "rootPostId", version, content_hash AS "contentHash", campaign, default_text AS text, platforms, targets, platform_customizations AS "platformCustomizations", media_urls AS "mediaUrls", link_url AS "linkUrl", dry_run AS "dryRun", status, scheduled_at AS "scheduledAt", next_attempt_at AS "nextAttemptAt", published_at AS "publishedAt", approved_at AS "approvedAt", approved_by AS "approvedBy", approval_hash AS "approvalHash", approval_expires_at AS "approvalExpiresAt", approval_request_id AS "approvalRequestId", decision_reason AS "decisionReason", created_by_type AS "createdByType", created_by_id AS "createdById", created_by_run_id AS "createdByRunId", metadata, created_at AS "createdAt", updated_at AS "updatedAt"`;
const receiptColumns = `id, post_id AS "postId", company_id AS "companyId", platform, account_id AS "accountId", destination_key AS "destinationKey", status, platform_post_id AS "platformPostId", platform_post_url AS "platformPostUrl", error_message AS "errorMessage", error_code AS "errorCode", checkpoint, attempt_count AS "attemptCount", next_attempt_at AS "nextAttemptAt", cost_cents AS "costCents", CASE WHEN status='dry_run' THEN 'VERIFIED_NO_PROVIDER_WRITE' WHEN cost_cents IS NULL THEN 'UNKNOWN' ELSE 'ESTIMATED' END AS "costStatus", CASE WHEN status='dry_run' THEN 0 ELSE NULL END AS "actualCostCents", CASE WHEN status<>'dry_run' THEN cost_cents ELSE NULL END AS "estimatedCostCents", attempted_at AS "attemptedAt"`;
export async function listAccounts(ctx, companyId) {
  return ctx.db.query(
    `SELECT ${accountColumns} FROM ${tablePrefix(ctx)}.social_accounts WHERE company_id = $1 ORDER BY platform, account_name LIMIT 100`,
    [assertUuid(companyId, "companyId")],
  );
}
export async function getAccount(ctx, companyId, accountId) {
  const rows = await ctx.db.query(
    `SELECT ${accountColumns} FROM ${tablePrefix(ctx)}.social_accounts WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [assertUuid(companyId), assertUuid(accountId, "accountId")],
  );
  return rows[0] ?? null;
}
export async function getAccountByPlatform(ctx, companyId, platform) {
  const rows = await ctx.db.query(
    `SELECT ${accountColumns} FROM ${tablePrefix(ctx)}.social_accounts WHERE company_id = $1 AND platform = $2 ORDER BY updated_at DESC LIMIT 2`,
    [assertUuid(companyId), platform],
  );
  if (rows.length > 1) throw new CatalogError("EXPLICIT_ACCOUNT_REQUIRED", 409);
  return rows[0] ?? null;
}
function validateAccount(data) {
  if (!PLATFORMS.includes(data.platform)) throw new CatalogError("INVALID_PLATFORM");
  if (
    typeof data.accountIdExternal !== "string" ||
    !/^[a-zA-Z0-9_.:-]{1,150}$/.test(data.accountIdExternal)
  )
    throw new CatalogError("INVALID_EXTERNAL_ACCOUNT_ID");
  if (
    typeof data.accountName !== "string" ||
    data.accountName.length < 1 ||
    data.accountName.length > 200
  )
    throw new CatalogError("INVALID_ACCOUNT_NAME");
  const ref = data.credentialsRef;
  if (!ref || !["oauth_encrypted", "secret_ref"].includes(ref.type))
    throw new CatalogError("CREDENTIAL_REFERENCE_REQUIRED");
  if (ref.type === "oauth_encrypted") assertUuid(ref.credentialId, "credentialId");
  if (ref.type === "secret_ref") assertUuid(ref.secretId, "secretId");
}
export async function upsertAccount(ctx, companyId, data) {
  validateAccount(data);
  const id = assertUuid(data.id ?? randomUUID());
  const schema = tablePrefix(ctx);
  await ctx.db.execute(
    `INSERT INTO ${schema}.social_accounts (id, company_id, platform, account_name, account_id_external, credentials_ref, scopes, policy, autonomous_opt_in, kill_switch, daily_limit, status, verification_status, verified_at, allowed_agent_ids, api_cost_approved, estimated_post_cost_cents, daily_cost_limit_cents) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,false,$9,$10,$11,$12,$13,$14::jsonb,false,$15,$16) ON CONFLICT (company_id,platform,account_id_external) DO UPDATE SET account_name = EXCLUDED.account_name, credentials_ref = EXCLUDED.credentials_ref, scopes = EXCLUDED.scopes, status = EXCLUDED.status, verification_status = EXCLUDED.verification_status, verified_at = EXCLUDED.verified_at, updated_at = now()`,
    [
      id,
      assertUuid(companyId),
      data.platform,
      data.accountName,
      data.accountIdExternal,
      JSON.stringify(data.credentialsRef),
      Array.isArray(data.scopes) ? data.scopes.join(" ") : String(data.scopes ?? ""),
      data.policy ?? "disabled",
      data.killSwitch !== false,
      data.dailyLimit ?? 1,
      data.status ?? "connected",
      data.verificationStatus ?? "CONNECTED_UNVERIFIED",
      data.verifiedAt ?? null,
      JSON.stringify(data.allowedAgentIds ?? []),
      data.estimatedPostCostCents ?? null,
      data.dailyCostLimitCents ?? 0,
    ],
  );
  const rows = await ctx.db.query(
    `SELECT ${accountColumns} FROM ${schema}.social_accounts WHERE company_id = $1 AND platform = $2 AND account_id_external = $3 LIMIT 1`,
    [companyId, data.platform, data.accountIdExternal],
  );
  return rows[0] ?? null;
}
export async function updateAccount(ctx, companyId, accountId, patch) {
  const columns = {
    policy: "policy",
    autonomousOptIn: "autonomous_opt_in",
    killSwitch: "kill_switch",
    dailyLimit: "daily_limit",
    status: "status",
    lastError: "last_error",
    verificationStatus: "verification_status",
    verifiedAt: "verified_at",
    allowedAgentIds: "allowed_agent_ids",
    apiCostApproved: "api_cost_approved",
    estimatedPostCostCents: "estimated_post_cost_cents",
    dailyCostLimitCents: "daily_cost_limit_cents",
  };
  if (
    patch.policy !== undefined &&
    !["disabled", "approval_required", "autonomous"].includes(patch.policy)
  )
    throw new CatalogError("INVALID_POLICY");
  for (const key of ["dailyLimit", "estimatedPostCostCents", "dailyCostLimitCents"])
    if (
      patch[key] !== undefined &&
      patch[key] !== null &&
      (!Number.isInteger(patch[key]) || patch[key] < 0 || patch[key] > 100000)
    )
      throw new CatalogError(`INVALID_${key}`);
  if (
    patch.allowedAgentIds !== undefined &&
    (!Array.isArray(patch.allowedAgentIds) ||
      patch.allowedAgentIds.some((id) => !UUID_REGEX.test(id)))
  )
    throw new CatalogError("INVALID_AGENT_ALLOWLIST");
  const values = [assertUuid(companyId), assertUuid(accountId)];
  const updates = [];
  for (const [key, column] of Object.entries(columns))
    if (patch[key] !== undefined) {
      values.push(key === "allowedAgentIds" ? JSON.stringify(patch[key]) : patch[key]);
      updates.push(`${column} = $${values.length}${key === "allowedAgentIds" ? "::jsonb" : ""}`);
    }
  if (updates.length)
    await ctx.db.execute(
      `UPDATE ${tablePrefix(ctx)}.social_accounts SET ${updates.join(",")}, updated_at = now() WHERE company_id = $1 AND id = $2`,
      values,
    );
  return getAccount(ctx, companyId, accountId);
}
export async function createPost(ctx, companyId, data, actor) {
  const schema = tablePrefix(ctx);
  const id = assertUuid(data.id ?? randomUUID());
  const key = String(data.idempotencyKey ?? id);
  if (key.length < 1 || key.length > 160) throw new CatalogError("INVALID_IDEMPOTENCY_KEY");
  const hash = contentHash(data);
  const semantic = createHash("sha256")
    .update(String(data.text).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase())
    .digest("hex");
  await ctx.db.execute(
    `INSERT INTO ${schema}.social_posts (id,company_id,project_id,idempotency_key,root_post_id,version,content_hash,semantic_hash,campaign,default_text,platforms,targets,platform_customizations,media_urls,link_url,dry_run,status,created_by_type,created_by_id,created_by_run_id,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,'draft',$17,$18,$19,$20::jsonb) ON CONFLICT (company_id,idempotency_key) DO NOTHING`,
    [
      id,
      assertUuid(companyId),
      data.projectId ?? null,
      key,
      data.rootPostId ?? id,
      data.version ?? 1,
      hash,
      semantic,
      data.campaign ?? null,
      data.text,
      JSON.stringify(data.platforms),
      JSON.stringify(data.targets ?? []),
      JSON.stringify(data.platformCustomizations ?? {}),
      JSON.stringify(data.mediaUrls ?? []),
      data.linkUrl ?? null,
      data.dryRun !== false,
      actor.actorType,
      actor.actorId,
      actor.runId ?? null,
      JSON.stringify(data.metadata ?? {}),
    ],
  );
  const rows = await ctx.db.query(
    `SELECT ${postColumns} FROM ${schema}.social_posts WHERE company_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [companyId, key],
  );
  const post = rows[0];
  if (!post || post.contentHash !== hash)
    throw new CatalogError("IDEMPOTENCY_CONTENT_CONFLICT", 409);
  return post;
}
export async function getPost(ctx, companyId, postId) {
  const rows = await ctx.db.query(
    `SELECT ${postColumns} FROM ${tablePrefix(ctx)}.social_posts WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [assertUuid(companyId), assertUuid(postId, "postId")],
  );
  return rows[0] ?? null;
}
export async function listPosts(ctx, companyId, limit = 10) {
  return ctx.db.query(
    `SELECT ${postColumns} FROM ${tablePrefix(ctx)}.social_posts WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [assertUuid(companyId), Math.min(50, Math.max(1, Number(limit) || 10))],
  );
}
export async function updatePostStatus(ctx, companyId, postId, status, extra = {}) {
  const fields = {
    publishedAt: "published_at",
    approvedAt: "approved_at",
    approvedBy: "approved_by",
    scheduledAt: "scheduled_at",
    nextAttemptAt: "next_attempt_at",
    approvalHash: "approval_hash",
    approvalExpiresAt: "approval_expires_at",
    approvalRequestId: "approval_request_id",
    decisionReason: "decision_reason",
  };
  const values = [assertUuid(companyId), assertUuid(postId), status];
  const updates = ["status = $3", "updated_at = now()"];
  for (const [key, column] of Object.entries(fields))
    if (extra[key] !== undefined) {
      values.push(extra[key]);
      updates.push(`${column} = $${values.length}`);
    }
  let condition = "";
  if (extra.expectedStatuses) {
    values.push(extra.expectedStatuses);
    condition = ` AND status = ANY($${values.length}::text[])`;
  }
  if (extra.expectedHash) {
    values.push(extra.expectedHash);
    condition += ` AND content_hash = $${values.length}`;
  }
  const result = await ctx.db.execute(
    `UPDATE ${tablePrefix(ctx)}.social_posts SET ${updates.join(",")} WHERE company_id = $1 AND id = $2${condition}`,
    values,
  );
  if (result?.rowCount !== 1) throw new CatalogError("POST_STATE_CONFLICT", 409);
  return getPost(ctx, companyId, postId);
}
export async function claimPost(ctx, companyId, postId) {
  const result = await ctx.db.execute(
    `UPDATE ${tablePrefix(ctx)}.social_posts SET status = 'publishing',updated_at = now() WHERE company_id = $1 AND id = $2 AND status IN ('draft','approved','scheduled','retry')`,
    [assertUuid(companyId), assertUuid(postId)],
  );
  return result?.rowCount === 1;
}
export async function recordReceipt(ctx, companyId, receipt) {
  const values = [
    receipt.id ?? randomUUID(),
    assertUuid(receipt.postId),
    assertUuid(companyId),
    receipt.platform,
    receipt.accountId ?? null,
    receipt.destinationKey ?? `${receipt.platform}:${receipt.accountId ?? "unconnected"}`,
    receipt.status,
    receipt.platformPostId ?? null,
    receipt.platformPostUrl ?? null,
    receipt.errorMessage ?? null,
    receipt.errorCode ?? null,
    JSON.stringify(receipt.checkpoint ?? {}),
    receipt.attemptCount ?? 0,
    receipt.nextAttemptAt ?? null,
    receipt.costCents ?? null,
  ];
  await ctx.db.execute(
    `INSERT INTO ${tablePrefix(ctx)}.social_receipts (id,post_id,company_id,platform,account_id,destination_key,status,platform_post_id,platform_post_url,error_message,error_code,checkpoint,attempt_count,next_attempt_at,cost_cents,attempted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,now()) ON CONFLICT (post_id,destination_key) DO UPDATE SET status=EXCLUDED.status,platform_post_id=EXCLUDED.platform_post_id,platform_post_url=EXCLUDED.platform_post_url,error_message=EXCLUDED.error_message,error_code=EXCLUDED.error_code,checkpoint=EXCLUDED.checkpoint,attempt_count=EXCLUDED.attempt_count,next_attempt_at=EXCLUDED.next_attempt_at,cost_cents=EXCLUDED.cost_cents,attempted_at=now()`,
    values,
  );
}
export async function listReceiptsForPost(ctx, companyId, postId) {
  return ctx.db.query(
    `SELECT ${receiptColumns} FROM ${tablePrefix(ctx)}.social_receipts WHERE company_id = $1 AND post_id = $2 ORDER BY platform,destination_key`,
    [assertUuid(companyId), assertUuid(postId)],
  );
}
export async function appendAuditLog(ctx, companyId, entry) {
  await ctx.db.execute(
    `INSERT INTO ${tablePrefix(ctx)}.social_audit_log (id,company_id,post_id,account_id,actor_type,actor_id,run_id,action,details,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,now())`,
    [
      randomUUID(),
      assertUuid(companyId),
      entry.postId ?? null,
      entry.accountId ?? null,
      entry.actorType ?? "system",
      entry.actorId ?? "scheduler",
      entry.runId ?? null,
      entry.action,
      JSON.stringify(entry.details ?? {}),
    ],
  );
}
export async function findScheduledPostsDue(ctx, companyId) {
  return ctx.db.query(
    `SELECT ${postColumns} FROM ${tablePrefix(ctx)}.social_posts WHERE company_id = $1 AND status IN ('scheduled','retry') AND COALESCE(next_attempt_at,scheduled_at) <= now() ORDER BY COALESCE(next_attempt_at,scheduled_at) LIMIT 10`,
    [assertUuid(companyId)],
  );
}
export async function recoverInterruptedPosts(ctx, companyId) {
  const schema = tablePrefix(ctx);
  await ctx.db.execute(
    `UPDATE ${schema}.social_receipts SET status = 'unknown',error_code='INTERRUPTED_PUBLICATION',error_message='Remote outcome requires operator reconciliation' WHERE company_id=$1 AND status='processing' AND attempted_at < now() - interval '10 minutes'`,
    [assertUuid(companyId)],
  );
  await ctx.db.execute(
    `UPDATE ${schema}.social_posts SET status='unknown',updated_at=now() WHERE company_id=$1 AND status='publishing' AND updated_at < now() - interval '10 minutes'`,
    [companyId],
  );
}
export async function reserveAccountBudget(ctx, companyId, accountId, estimatedCost) {
  const result = await ctx.db.execute(
    `UPDATE ${tablePrefix(ctx)}.social_accounts SET posts_today = CASE WHEN last_reset_date = to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') THEN posts_today + 1 ELSE 1 END, cost_today_cents = CASE WHEN last_reset_date = to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') THEN cost_today_cents + $3 ELSE $3 END, last_reset_date=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD'),updated_at=now() WHERE company_id=$1 AND id=$2 AND kill_switch=false AND policy <> 'disabled' AND daily_limit>0 AND (last_reset_date <> to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') OR posts_today < daily_limit) AND (last_reset_date <> to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') OR cost_today_cents + $3 <= daily_cost_limit_cents) AND $3 <= daily_cost_limit_cents`,
    [assertUuid(companyId), assertUuid(accountId), estimatedCost],
  );
  return result?.rowCount === 1;
}

export async function claimDestinationContent(ctx, companyId, accountId, postId, content) {
  const stripTracking = (raw) => {
    try {
      const url = new URL(raw);
      for (const key of [...url.searchParams.keys()])
        if (
          key.startsWith("utm_") ||
          ["internal_post_id", "social_post_id", "post_id"].includes(key)
        )
          url.searchParams.delete(key);
      return url.toString();
    } catch {
      return raw;
    }
  };
  const text = String(content.text ?? "")
    .replace(/https:\/\/[^\s]+/g, (url) => stripTracking(url))
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const digest = createHash("sha256")
    .update(
      canonical({
        text,
        mediaUrls: (content.mediaUrls ?? []).map(stripTracking),
        linkUrl: content.linkUrl ? stripTracking(content.linkUrl) : null,
      }),
    )
    .digest("hex");
  const schema = tablePrefix(ctx);
  await ctx.db.execute(
    `INSERT INTO ${schema}.social_content_claims (id,company_id,account_id,content_digest,post_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(company_id,account_id,content_digest) DO NOTHING`,
    [randomUUID(), assertUuid(companyId), assertUuid(accountId), digest, assertUuid(postId)],
  );
  const rows = await ctx.db.query(
    `SELECT post_id AS "postId" FROM ${schema}.social_content_claims WHERE company_id=$1 AND account_id=$2 AND content_digest=$3 LIMIT 1`,
    [companyId, accountId, digest],
  );
  return rows[0]?.postId === postId;
}
