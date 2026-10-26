import { randomUUID } from "node:crypto";
import { getAdapter } from "./adapters/index.js";
import { loadConfig } from "./config.js";
import { resolveAccountCredentials, refreshOAuthAccount } from "./oauth.js";
import { makeFetch, makeMediaFetch } from "./transport.js";
import {
  listAccounts,
  getAccount,
  getAccountByPlatform,
  createPost,
  getPost,
  listPosts,
  updatePostStatus,
  recordReceipt,
  listReceiptsForPost,
  appendAuditLog,
  findScheduledPostsDue,
  claimPost,
  contentHash,
  assertUuid,
  PLATFORMS,
  reserveAccountBudget,
  recoverInterruptedPosts,
  claimDestinationContent,
  CatalogError,
} from "./catalog.js";
import {
  evaluateChannelPolicy,
  validateContentForPlatforms,
  PolicyError,
  approvalMatches,
  factualEvidenceStatus,
  sameTargets,
} from "./governance.js";
import { notifyPublicationReceipt, requestPostApproval } from "./telegram-sync.js";

export function getExactOAuthUrls(baseUrl = "https://paper.journeystudios.com.br") {
  const base = baseUrl.replace(/\/+$/, "");
  const prefix = `${base}/api/plugins/journey-studios.social-publisher/api/oauth`;
  return {
    instagramCallbackUrl: `${prefix}/instagram/callback`,
    facebookCallbackUrl: `${prefix}/facebook/callback`,
    threadsCallbackUrl: `${prefix}/threads/callback`,
    metaCallbackUrl: `${prefix}/facebook/callback`,
    xCallbackUrl: `${prefix}/x/callback`,
    metaScopes: {
      instagram: ["instagram_business_basic", "instagram_business_content_publish"],
      facebook: ["pages_show_list", "pages_manage_posts", "pages_read_engagement"],
      threads: ["threads_basic", "threads_content_publish"],
    },
    xScopes: ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"],
  };
}
export function sanitizeAccountForModel(account) {
  return {
    id: account.id,
    platform: account.platform,
    accountName: account.accountName,
    accountIdExternal: account.accountIdExternal,
    scopes: account.scopes,
    policy: account.policy,
    autonomousOptIn: account.autonomousOptIn,
    killSwitch: account.killSwitch,
    dailyLimit: account.dailyLimit,
    postsToday: account.postsToday,
    remainingPostsToday: Math.max(0, (account.dailyLimit ?? 0) - (account.postsToday ?? 0)),
    status: account.status,
    verificationStatus: account.verificationStatus ?? "CONNECTED_UNVERIFIED",
    verifiedAt: account.verifiedAt ?? null,
    apiCostApproved: account.apiCostApproved ?? false,
    estimatedPostCostCents: account.estimatedPostCostCents ?? null,
    lastError: account.lastError,
  };
}
function authorize(actor, config, post = null) {
  if (!actor || !actor.actorId)
    throw new PolicyError("Authenticated actor required", "actor_required");
  if (actor.actorType === "user") {
    if (actor.actorId !== config.founderUserId)
      throw new PolicyError("Founder access required", "founder_required");
    return;
  }
  if (actor.actorType === "system" && actor.actorId === "scheduler" && post) {
    return authorize({ actorType: post.createdByType, actorId: post.createdById }, config);
  }
  if (
    actor.actorType !== "agent" ||
    !Array.isArray(config.allowedAgentIds) ||
    !config.allowedAgentIds.includes(actor.actorId)
  )
    throw new PolicyError(
      "Agent has not been granted Social Publisher access",
      "agent_not_allowed",
    );
  if (
    post &&
    post.createdByType === "agent" &&
    post.createdById !== actor.actorId &&
    !config.manageAllPostsAgentIds?.includes(actor.actorId)
  )
    throw new PolicyError("Agent cannot mutate another author's post", "post_owner_required");
}
async function configFor(ctx, companyId, provided) {
  assertUuid(companyId, "companyId");
  return provided ?? loadConfig(ctx, companyId);
}
function safeMetadata(input = {}) {
  const result = {};
  for (const key of [
    "factualEvidence",
    "hypothesis",
    "audience",
    "editorialDate",
    "editorialSlot",
    "productionCostCents",
    "currency",
    "evidenceReviewedBy",
    "imageAssetId",
    "imagePromptRef",
  ])
    if (input[key] !== undefined) result[key] = input[key];
  if (JSON.stringify(result).length > 20000) throw new CatalogError("METADATA_TOO_LARGE");
  if (
    result.productionCostCents !== undefined &&
    (!Number.isInteger(result.productionCostCents) || result.productionCostCents < 0)
  )
    throw new CatalogError("INVALID_PRODUCTION_COST");
  return result;
}
async function targetsFor(ctx, companyId, args, dryRun) {
  const targets = [];
  for (const platform of args.platforms) {
    const selected = args.targets?.find((target) => target.platform === platform);
    let account = null;
    if (selected?.accountId) account = await getAccount(ctx, companyId, selected.accountId);
    else account = await getAccountByPlatform(ctx, companyId, platform);
    if (selected?.accountId && !account) throw new CatalogError("ACCOUNT_NOT_FOUND", 404);
    if (account && account.platform !== platform)
      throw new CatalogError("ACCOUNT_PLATFORM_MISMATCH");
    if (!account && !dryRun)
      throw new PolicyError(`Account for ${platform} is not connected`, "not_connected");
    targets.push({ platform, accountId: account?.id ?? null });
  }
  return targets.sort((a, b) => a.platform.localeCompare(b.platform));
}
export function trackedUrl(raw, post, target) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new CatalogError("INVALID_LINK_URL");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new CatalogError("HTTPS_LINK_REQUIRED");
  url.searchParams.set("utm_source", target.platform);
  url.searchParams.set("utm_medium", "social");
  url.searchParams.set("utm_campaign", post.campaign ?? "tessel-social-daily");
  url.searchParams.set(
    "utm_content",
    `${post.rootPostId ?? post.id}.v${post.version}.${target.platform}.${target.accountId ?? "unconnected"}`,
  );
  url.searchParams.set("internal_post_id", post.rootPostId ?? post.id);
  url.searchParams.set("post_id", post.rootPostId ?? post.id);
  return url.toString();
}
export function channelContent(post, target) {
  const custom = post.platformCustomizations?.[target.platform] ?? {};
  const url = trackedUrl(custom.linkUrl ?? post.linkUrl, post, target);
  let text = custom.text ?? post.text;
  const original = custom.linkUrl ?? post.linkUrl;
  if (url && original && text.includes(original)) text = text.split(original).join(url);
  return {
    text,
    mediaUrls: custom.mediaUrls ?? post.mediaUrls ?? [],
    linkUrl: url,
    mediaTypes: custom.mediaTypes,
  };
}
function receiptKey(target) {
  return `${target.platform}:${target.accountId ?? "unconnected"}`;
}
async function audit(ctx, companyId, post, actor, action, details = {}) {
  await appendAuditLog(ctx, companyId, {
    postId: post?.id,
    actorType: actor.actorType,
    actorId: actor.actorId,
    runId: actor.runId,
    action,
    details,
  });
}
export async function serviceListAccounts(ctx, companyId) {
  const accounts = await listAccounts(ctx, companyId);
  return {
    accounts: accounts.map(sanitizeAccountForModel),
    connectivity: PLATFORMS.map((platform) => ({
      platform,
      status:
        accounts.find((account) => account.platform === platform)?.verificationStatus ??
        "NOT_CONNECTED",
    })),
  };
}
export async function serviceCreateDraft(
  ctx,
  companyId,
  args,
  actor,
  providedConfig,
  revisionContext = null,
) {
  const config = await configFor(ctx, companyId, providedConfig);
  authorize(actor, config);
  if (!revisionContext && (args.rootPostId !== undefined || args.version !== undefined))
    throw new CatalogError("REVISION_API_REQUIRED");
  const validation = validateContentForPlatforms(args, args.platforms);
  if (!validation.valid) throw new CatalogError(`CONTENT_INVALID: ${validation.errors.join("; ")}`);
  const dryRun = args.dryRun !== false;
  if (!dryRun && config.dryRunOnly !== false)
    throw new PolicyError("Production is restricted to dry runs", "dry_run_only");
  if (args.projectId) {
    assertUuid(args.projectId, "projectId");
    if (!(await ctx.projects?.get(args.projectId, companyId)))
      throw new CatalogError("PROJECT_NOT_IN_COMPANY");
  }
  const targets = await targetsFor(ctx, companyId, args, dryRun);
  const id = randomUUID();
  const post = await createPost(
    ctx,
    companyId,
    {
      ...args,
      id,
      targets,
      dryRun,
      metadata: safeMetadata(args.metadata),
      rootPostId: revisionContext?.rootPostId ?? id,
      version: revisionContext?.version ?? 1,
    },
    actor,
  );
  await audit(ctx, companyId, post, actor, "draft_created", {
    version: post.version,
    contentHash: post.contentHash,
    targets: post.targets,
    dryRun: post.dryRun,
  });
  const finalValidation = await serviceValidatePost(ctx, companyId, { postId: post.id }, config);
  return { post, validation: finalValidation };
}
export async function serviceValidatePost(ctx, companyId, args, providedConfig) {
  const config = await configFor(ctx, companyId, providedConfig);
  let post = args;
  if (args.postId) {
    post = await getPost(ctx, companyId, args.postId);
    if (!post) throw new CatalogError("POST_NOT_FOUND", 404);
  }
  const validation = validateContentForPlatforms(post, post.platforms);
  if (Array.isArray(post.targets)) {
    for (const target of post.targets) {
      const exact = getAdapter(target.platform).validate(channelContent(post, target));
      validation.platforms[target.platform] = exact;
      if (!exact.valid) {
        validation.valid = false;
        validation.errors.push(...exact.errors.map((error) => `[${target.platform}] ${error}`));
      }
    }
  }
  const factual = factualEvidenceStatus(post, config);
  return {
    ...validation,
    factualEvidence: factual,
    publicationReady:
      validation.valid && (config.requireFactualEvidence === false || factual.valid),
    contentHash: post.contentHash ?? null,
  };
}
export async function servicePreviewPost(ctx, companyId, args, providedConfig) {
  const config = await configFor(ctx, companyId, providedConfig);
  let post = args;
  if (args.postId) {
    post = await getPost(ctx, companyId, args.postId);
    if (!post) throw new CatalogError("POST_NOT_FOUND", 404);
  }
  if (!post.targets) {
    post = {
      ...post,
      id: randomUUID(),
      version: 1,
      dryRun: true,
      targets: await targetsFor(ctx, companyId, args, true),
    };
  }
  const previews = {};
  const policies = {};
  for (const target of post.targets) {
    const content = channelContent(post, target);
    previews[target.platform] = {
      ...getAdapter(target.platform).preview(content),
      accountId: target.accountId,
      trackingUrl: content.linkUrl,
      internalPostId: post.rootPostId ?? post.id,
      version: post.version,
    };
    const account = target.accountId ? await getAccount(ctx, companyId, target.accountId) : null;
    policies[target.platform] = evaluateChannelPolicy(account, post, { config });
  }
  return {
    postId: post.id ?? null,
    version: post.version ?? null,
    contentHash: post.contentHash ?? null,
    targets: post.targets,
    previews,
    policies,
    dryRun: post.dryRun !== false,
    factualEvidence: factualEvidenceStatus(post, config),
  };
}
export async function serviceRequestApproval(ctx, companyId, args, actor, providedConfig) {
  const config = await configFor(ctx, companyId, providedConfig);
  const post = await getPost(ctx, companyId, args.postId);
  if (!post) throw new CatalogError("POST_NOT_FOUND", 404);
  authorize(actor, config, post);
  if (!["draft", "pending_approval"].includes(post.status))
    throw new CatalogError("POST_CANNOT_REQUEST_APPROVAL", 409);
  const validation = await serviceValidatePost(ctx, companyId, { postId: post.id }, config);
  if (!validation.publicationReady) throw new CatalogError("CONTENT_OR_FACTUAL_EVIDENCE_NOT_READY");
  if (contentHash(post) !== post.contentHash)
    throw new CatalogError("POST_CONTENT_INTEGRITY_FAILURE", 409);
  let pending = post;
  if (post.status === "draft")
    pending = await updatePostStatus(ctx, companyId, post.id, "pending_approval", {
      approvalExpiresAt: new Date(
        Date.now() + Math.min(86400, Math.max(60, config.approvalTtlSeconds ?? 86400)) * 1000,
      ).toISOString(),
      expectedStatuses: ["draft"],
    });
  let delivery = null;
  if (!pending.approvalRequestId) {
    delivery = await requestPostApproval(ctx, companyId, pending, validation, config);
    if (delivery?.interactionId)
      pending = await updatePostStatus(ctx, companyId, pending.id, "pending_approval", {
        approvalRequestId: delivery.interactionId,
        expectedStatuses: ["pending_approval"],
      });
  }
  await audit(ctx, companyId, pending, actor, "approval_requested", {
    contentHash: pending.contentHash,
    version: pending.version,
    targets: pending.targets,
    interactionId: pending.approvalRequestId,
  });
  return {
    status: "pending_approval",
    post: pending,
    validation,
    approval: {
      postId: pending.id,
      version: pending.version,
      contentHash: pending.contentHash,
      targets: pending.targets,
      expiresAt: pending.approvalExpiresAt,
    },
    delivery,
  };
}
export async function serviceDecideApproval(ctx, companyId, args, actor, providedConfig) {
  const config = await configFor(ctx, companyId, providedConfig);
  authorize(actor, config);
  if (actor.actorType !== "user")
    throw new PolicyError("Human approval required", "human_required");
  const post = await getPost(ctx, companyId, args.postId);
  if (!post) throw new CatalogError("POST_NOT_FOUND", 404);
  if (
    post.status !== "pending_approval" ||
    args.version !== post.version ||
    args.contentHash !== post.contentHash ||
    !sameTargets(args.targets, post.targets) ||
    contentHash(post) !== post.contentHash
  )
    throw new CatalogError("APPROVAL_VERSION_OR_TARGET_MISMATCH", 409);
  if (new Date(post.approvalExpiresAt).getTime() <= Date.now())
    throw new CatalogError("APPROVAL_EXPIRED", 409);
  if (!["approved", "rejected", "revision_requested"].includes(args.decision))
    throw new CatalogError("INVALID_DECISION");
  if (!args.interactionId || args.interactionId !== post.approvalRequestId)
    throw new CatalogError("APPROVAL_INTERACTION_MISMATCH", 409);
  const extra = {
    expectedStatuses: ["pending_approval"],
    expectedHash: post.contentHash,
    decisionReason: String(args.reason ?? "").slice(0, 2000),
  };
  if (args.decision === "approved") {
    extra.approvedAt = new Date().toISOString();
    extra.approvedBy = actor.actorId;
    extra.approvalHash = post.contentHash;
  }
  let decidedStatus = args.decision;
  if (args.decision === "approved" && post.scheduledAt) {
    if (new Date(post.scheduledAt).getTime() >= new Date(post.approvalExpiresAt).getTime())
      throw new CatalogError("SCHEDULE_EXCEEDS_APPROVAL_EXPIRY");
    decidedStatus = "scheduled";
  }
  const updated = await updatePostStatus(ctx, companyId, post.id, decidedStatus, extra);
  await audit(ctx, companyId, updated, actor, args.decision, {
    version: post.version,
    contentHash: post.contentHash,
    targets: post.targets,
    interactionId: args.interactionId,
  });
  return { status: updated.status, post: updated };
}
export async function serviceReviseDraft(ctx, companyId, args, actor, providedConfig) {
  const config = await configFor(ctx, companyId, providedConfig);
  const previous = await getPost(ctx, companyId, args.postId);
  if (!previous) throw new CatalogError("POST_NOT_FOUND", 404);
  authorize(actor, config, previous);
  if (
    ![
      "draft",
      "pending_approval",
      "approved",
      "scheduled",
      "revision_requested",
      "rejected",
      "superseded",
    ].includes(previous.status)
  )
    throw new CatalogError("POST_CANNOT_BE_REVISED", 409);
  if (args.version !== previous.version) throw new CatalogError("REVISION_VERSION_CONFLICT", 409);
  const next = {
    text: args.text ?? previous.text,
    platforms: args.platforms ?? previous.platforms,
    platformCustomizations: args.platformCustomizations ?? previous.platformCustomizations,
    mediaUrls: args.mediaUrls ?? previous.mediaUrls,
    linkUrl: args.linkUrl ?? previous.linkUrl,
    campaign: previous.campaign,
    projectId: previous.projectId,
    dryRun: previous.dryRun,
    targets: args.targets ?? previous.targets,
    metadata: args.metadata ?? previous.metadata,
    rootPostId: previous.rootPostId,
    version: previous.version + 1,
    idempotencyKey: `${previous.rootPostId}:v${previous.version + 1}`,
  };
  const validation = validateContentForPlatforms(next, next.platforms);
  if (!validation.valid) throw new CatalogError("CONTENT_INVALID");
  next.targets = await targetsFor(ctx, companyId, next, next.dryRun);
  next.metadata = safeMetadata(next.metadata);
  if (next.projectId && !(await ctx.projects?.get(next.projectId, companyId)))
    throw new CatalogError("PROJECT_NOT_IN_COMPANY");
  if (!next.dryRun && config.dryRunOnly !== false)
    throw new PolicyError("Production is restricted to dry runs", "dry_run_only");
  // The deterministic next-version key also recovers a crash after superseding the previous version.
  if (previous.status !== "superseded")
    await updatePostStatus(ctx, companyId, previous.id, "superseded", {
      expectedStatuses: [previous.status],
    });
  const created = await serviceCreateDraft(ctx, companyId, next, actor, config, {
    rootPostId: previous.rootPostId,
    version: previous.version + 1,
  });
  await audit(ctx, companyId, created.post, actor, "draft_revised", {
    previousPostId: previous.id,
    version: created.post.version,
    contentHash: created.post.contentHash,
  });
  return created;
}
export async function prepareAccountCredentials(ctx, companyId, account, config) {
  let credentials;
  let shouldRefresh = false;
  try {
    credentials = await resolveAccountCredentials(ctx, companyId, account, config);
  } catch (error) {
    if (error.code !== "OAUTH_REAUTHENTICATION_OR_REFRESH_REQUIRED") throw error;
    shouldRefresh = true;
  }
  if (credentials?.expiresAt && new Date(credentials.expiresAt).getTime() <= Date.now() + 120000)
    shouldRefresh = true;
  if (!shouldRefresh) return { account, credentials };
  await refreshOAuthAccount(ctx, companyId, account.id, config);
  const refreshed = await getAccount(ctx, companyId, account.id);
  if (!refreshed) throw new CatalogError("ACCOUNT_NOT_FOUND", 404);
  return {
    account: refreshed,
    credentials: await resolveAccountCredentials(ctx, companyId, refreshed, config),
  };
}
export async function servicePublishPost(ctx, companyId, args, actor, providedConfig, fetchImpl) {
  const config = await configFor(ctx, companyId, providedConfig);
  let post;
  if (args.postId) post = await getPost(ctx, companyId, args.postId);
  else post = (await serviceCreateDraft(ctx, companyId, args, actor, config)).post;
  if (!post) throw new CatalogError("POST_NOT_FOUND", 404);
  authorize(actor, config, post);
  if (["published", "dry_run_completed"].includes(post.status))
    return {
      status: post.status,
      postId: post.id,
      receipts: await listReceiptsForPost(ctx, companyId, post.id),
      replayed: true,
    };
  if (
    [
      "unknown",
      "publishing",
      "cancelled",
      "rejected",
      "superseded",
      "revision_requested",
      "failed",
    ].includes(post.status)
  )
    throw new PolicyError(
      `Post status '${post.status}' prevents publication`,
      "post_not_publishable",
    );
  if (contentHash(post) !== post.contentHash)
    throw new CatalogError("POST_CONTENT_INTEGRITY_FAILURE", 409);
  if (!post.dryRun && config.dryRunOnly !== false)
    throw new PolicyError("Production is restricted to dry runs", "dry_run_only");
  if (!post.dryRun && config.killSwitch)
    throw new PolicyError("Global kill switch is active", "kill_switch");
  const validation = await serviceValidatePost(ctx, companyId, { postId: post.id }, config);
  if (!validation.publicationReady)
    throw new PolicyError("Content or factual evidence is not ready", "validation_required");
  const budgetDate = new Date().toISOString().slice(0, 10);
  const previousReceipts = await listReceiptsForPost(ctx, companyId, post.id);
  const accounts = new Map();
  const decisions = {};
  let needApproval = false;
  const originalActor =
    actor.actorType === "system"
      ? { actorType: post.createdByType, actorId: post.createdById }
      : actor;
  for (const target of post.targets) {
    const account = target.accountId ? await getAccount(ctx, companyId, target.accountId) : null;
    accounts.set(receiptKey(target), account);
    const existingReceipt = previousReceipts.find(
      (receipt) => receipt.destinationKey === receiptKey(target),
    );
    const policyAccount =
      account &&
      existingReceipt?.checkpoint?.budgetReserved &&
      existingReceipt.checkpoint.budgetReservedDate === budgetDate
        ? { ...account, postsToday: Math.max(0, account.postsToday - 1) }
        : account;
    const decision = evaluateChannelPolicy(policyAccount, post, {
      config,
      actor: originalActor,
      factsVerified: validation.factualEvidence.independentlyVerified,
      requireApproval: post.campaign === "tessel-social-daily" || post.campaign === "JOU-1051",
    });
    decisions[target.platform] = decision;
    if (decision.requiresApproval) needApproval = true;
  }
  if (needApproval) {
    if (post.status === "draft" || post.status === "pending_approval")
      return serviceRequestApproval(ctx, companyId, { postId: post.id }, actor, config);
    throw new PolicyError("Approval expired or does not match this version", "approval_required");
  }
  if (!Object.values(decisions).some((decision) => decision.allowed))
    throw new PolicyError("All destinations are blocked", "destinations_blocked");
  if (!(await claimPost(ctx, companyId, post.id)))
    return {
      status: "in_progress",
      postId: post.id,
      receipts: await listReceiptsForPost(ctx, companyId, post.id),
    };
  await audit(ctx, companyId, post, actor, "publish_started", {
    version: post.version,
    contentHash: post.contentHash,
    targets: post.targets,
    dryRun: post.dryRun,
  });
  const existing = previousReceipts;
  const maxAttempts = Math.min(5, Math.max(1, config.maxAttempts ?? 3));
  for (const target of post.targets) {
    const key = receiptKey(target);
    const prior = existing.find((item) => item.destinationKey === key);
    if (prior && ["published", "dry_run", "unknown", "failed", "blocked"].includes(prior.status))
      continue;
    if (prior?.status === "processing") {
      await recordReceipt(ctx, companyId, {
        ...prior,
        status: "unknown",
        errorCode: "INTERRUPTED_PUBLICATION",
        errorMessage: "Remote outcome requires reconciliation",
      });
      continue;
    }
    if (prior?.nextAttemptAt && new Date(prior.nextAttemptAt).getTime() > Date.now()) continue;
    const account = accounts.get(key);
    let receipt = {
      postId: post.id,
      platform: target.platform,
      accountId: target.accountId,
      destinationKey: key,
      status: "processing",
      attemptCount: (prior?.attemptCount ?? 0) + 1,
      checkpoint: prior?.checkpoint ?? {},
      costCents: null,
    };
    const decision = decisions[target.platform];
    if (!decision.allowed) {
      await recordReceipt(ctx, companyId, {
        ...receipt,
        status: "blocked",
        errorCode: "POLICY_DENIED",
        errorMessage: decision.reason,
      });
      continue;
    }
    if (post.dryRun) {
      await recordReceipt(ctx, companyId, {
        ...receipt,
        status: "dry_run",
        attemptCount: 0,
        checkpoint: {
          validation: "passed",
          contentHash: post.contentHash,
          version: post.version,
          connectivity: account?.verificationStatus ?? "NOT_CONNECTED",
        },
        costCents: 0,
      });
      continue;
    }
    if (
      !(await claimDestinationContent(
        ctx,
        companyId,
        account.id,
        post.id,
        channelContent(post, target),
      ))
    ) {
      await recordReceipt(ctx, companyId, {
        ...receipt,
        status: "blocked",
        errorCode: "DUPLICATE_DESTINATION_CONTENT",
        errorMessage: "This exact content is already claimed by another post for this account",
      });
      continue;
    }
    if (
      account.estimatedPostCostCents === null ||
      !Number.isInteger(account.estimatedPostCostCents)
    ) {
      await recordReceipt(ctx, companyId, {
        ...receipt,
        status: "blocked",
        errorCode: "API_COST_UNKNOWN",
        errorMessage: "Configure verified API cost and daily budget",
      });
      continue;
    }
    if (
      (!receipt.checkpoint.budgetReserved ||
        receipt.checkpoint.budgetReservedDate !== budgetDate) &&
      !(await reserveAccountBudget(ctx, companyId, account.id, account.estimatedPostCostCents))
    ) {
      await recordReceipt(ctx, companyId, {
        ...receipt,
        status: "blocked",
        errorCode: "DAILY_LIMIT_OR_BUDGET",
        errorMessage: "Daily limit, budget or kill switch prevents publication",
      });
      continue;
    }
    receipt.checkpoint = {
      ...receipt.checkpoint,
      budgetReserved: true,
      budgetReservedDate: budgetDate,
    };
    await recordReceipt(ctx, companyId, receipt);
    let prepared;
    try {
      prepared = await prepareAccountCredentials(ctx, companyId, account, config);
    } catch (error) {
      const code =
        error.code === "OAUTH_REFRESH_IN_PROGRESS"
          ? "AUTH_REFRESH_IN_PROGRESS"
          : "AUTH_REAUTH_REQUIRED";
      await recordReceipt(ctx, companyId, {
        ...receipt,
        status: "blocked",
        errorCode: code,
        errorMessage: "Authorization must be refreshed or reconnected before publication",
      });
      await audit(ctx, companyId, post, actor, "authorization_blocked", {
        platform: target.platform,
        accountId: account.id,
        code,
      });
      continue;
    }
    const refreshedDecision = evaluateChannelPolicy(
      { ...prepared.account, postsToday: Math.max(0, prepared.account.postsToday - 1) },
      post,
      {
        config,
        actor: originalActor,
        factsVerified: validation.factualEvidence.independentlyVerified,
      },
    );
    if (!refreshedDecision.allowed) {
      await recordReceipt(ctx, companyId, {
        ...receipt,
        status: "blocked",
        errorCode: "POLICY_CHANGED",
        errorMessage: "Account policy changed before publication",
      });
      continue;
    }
    try {
      const adapter = getAdapter(target.platform);
      const response = await adapter.publish({
        account: { ...prepared.account, credentials: prepared.credentials },
        content: channelContent(post, target),
        idempotencyKey: `${post.id}:${key}:v${post.version}`,
        fetchImpl: fetchImpl ?? makeFetch(ctx),
        mediaFetch: makeMediaFetch(config.mediaAllowedHosts ?? []),
        mediaAllowedHosts: config.mediaAllowedHosts ?? [],
        maxMediaBytes: config.maxMediaBytes,
        apiCostApproved: account.apiCostApproved,
        resume: receipt.checkpoint.platform ? receipt.checkpoint : undefined,
        onCheckpoint: async (checkpoint) => {
          receipt = { ...receipt, checkpoint: { ...receipt.checkpoint, ...checkpoint } };
          await recordReceipt(ctx, companyId, receipt);
        },
      });
      if (!response?.platformPostId || !response?.platformPostUrl)
        throw Object.assign(new Error("Receipt requires remote verification"), {
          code: "RECEIPT_UNVERIFIED",
          needsReconciliation: true,
          checkpoint: response?.checkpoint,
        });
      receipt = {
        ...receipt,
        status: "published",
        platformPostId: response.platformPostId,
        platformPostUrl: response.platformPostUrl,
        costCents: account.estimatedPostCostCents,
      };
      await recordReceipt(ctx, companyId, receipt);
    } catch (error) {
      const checkpoint = { ...receipt.checkpoint, ...(error.checkpoint ?? {}) };
      const code =
        typeof error.code === "string" && /^[A-Za-z0-9_:-]{1,100}$/.test(error.code)
          ? error.code
          : "PUBLICATION_OUTCOME_UNKNOWN";
      const ambiguous = error.needsReconciliation === true || error.retryable !== true;
      let status = "unknown";
      let nextAttemptAt = null;
      if (error.needsReconciliation === false && error.retryable === false) status = "failed";
      if (!ambiguous && receipt.attemptCount < maxAttempts) {
        status = "retry";
        const delay = Math.min(
          86400000,
          Math.max(60000, Number(error.retryAfterMs) || 60000 * 2 ** (receipt.attemptCount - 1)),
        );
        nextAttemptAt = new Date(Date.now() + delay).toISOString();
      }
      if (!ambiguous && receipt.attemptCount >= maxAttempts) status = "failed";
      await recordReceipt(ctx, companyId, {
        ...receipt,
        status,
        checkpoint,
        errorCode: code,
        errorMessage:
          status === "unknown"
            ? "Remote outcome requires operator reconciliation"
            : `Publication failed (${code})`,
        nextAttemptAt,
      });
    }
  }
  const receipts = await listReceiptsForPost(ctx, companyId, post.id);
  let status = "failed";
  if (receipts.some((receipt) => receipt.status === "unknown" || receipt.status === "processing"))
    status = "unknown";
  else if (receipts.some((receipt) => receipt.status === "retry")) status = "retry";
  else if (
    receipts.length === post.targets.length &&
    receipts.every((receipt) => receipt.status === "dry_run")
  )
    status = "dry_run_completed";
  else if (
    receipts.length === post.targets.length &&
    receipts.every((receipt) => receipt.status === "published")
  )
    status = "published";
  else if (receipts.some((receipt) => receipt.status === "published"))
    status = "partially_published";
  const next = receipts
    .filter((receipt) => receipt.nextAttemptAt)
    .map((receipt) => new Date(receipt.nextAttemptAt).getTime());
  const updated = await updatePostStatus(ctx, companyId, post.id, status, {
    nextAttemptAt: next.length ? new Date(Math.min(...next)).toISOString() : null,
    publishedAt: receipts.some((receipt) => receipt.status === "published")
      ? new Date().toISOString()
      : null,
    expectedStatuses: ["publishing"],
  });
  await audit(ctx, companyId, updated, actor, status, {
    receiptStatuses: receipts.map((receipt) => ({
      platform: receipt.platform,
      status: receipt.status,
      externalPostId: receipt.platformPostId ?? null,
    })),
    contentHash: post.contentHash,
  });
  try {
    await notifyPublicationReceipt(ctx, companyId, updated, receipts, config);
  } catch {
    await audit(ctx, companyId, updated, actor, "receipt_notification_failed");
  }
  return { status, postId: post.id, receipts, dryRun: post.dryRun };
}
export async function serviceSchedulePost(ctx, companyId, args, actor, providedConfig) {
  const config = await configFor(ctx, companyId, providedConfig);
  const at = new Date(args.scheduledAt);
  if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now())
    throw new CatalogError("FUTURE_SCHEDULE_REQUIRED");
  const post = args.postId
    ? await getPost(ctx, companyId, args.postId)
    : (await serviceCreateDraft(ctx, companyId, args, actor, config)).post;
  if (!post) throw new CatalogError("POST_NOT_FOUND", 404);
  authorize(actor, config, post);
  if (!["draft", "approved"].includes(post.status))
    throw new CatalogError("POST_CANNOT_BE_SCHEDULED", 409);
  const factual = factualEvidenceStatus(post, config);
  let autonomous = !post.dryRun;
  for (const target of post.targets) {
    const account = target.accountId ? await getAccount(ctx, companyId, target.accountId) : null;
    const decision = evaluateChannelPolicy(account, post, {
      config,
      actor,
      factsVerified: factual.independentlyVerified,
    });
    if (!decision.allowed || decision.mode !== "autonomous_publish") autonomous = false;
  }
  if (!approvalMatches(post) && !autonomous) {
    if (
      at.getTime() >=
      Date.now() + Math.min(86400, Math.max(60, config.approvalTtlSeconds ?? 86400)) * 1000
    )
      throw new CatalogError("SCHEDULE_EXCEEDS_APPROVAL_EXPIRY");
    await updatePostStatus(ctx, companyId, post.id, post.status, {
      scheduledAt: at.toISOString(),
      expectedStatuses: [post.status],
    });
    return serviceRequestApproval(ctx, companyId, { postId: post.id }, actor, config);
  }
  if (!autonomous && new Date(post.approvalExpiresAt).getTime() <= at.getTime())
    throw new CatalogError("SCHEDULE_EXCEEDS_APPROVAL_EXPIRY");
  const updated = await updatePostStatus(ctx, companyId, post.id, "scheduled", {
    scheduledAt: at.toISOString(),
    expectedStatuses: [autonomous ? post.status : "approved"],
  });
  await audit(ctx, companyId, updated, actor, "scheduled", {
    scheduledAt: at.toISOString(),
    contentHash: post.contentHash,
  });
  return { status: "scheduled", post: updated };
}
export async function serviceGetPostStatus(ctx, companyId, args = {}) {
  if (args.postId) {
    const post = await getPost(ctx, companyId, args.postId);
    if (!post) throw new CatalogError("POST_NOT_FOUND", 404);
    return { post, receipts: await listReceiptsForPost(ctx, companyId, post.id) };
  }
  return { posts: await listPosts(ctx, companyId, args.limit) };
}
export async function serviceCancelPost(ctx, companyId, args, actor, providedConfig) {
  const config = await configFor(ctx, companyId, providedConfig);
  const post = await getPost(ctx, companyId, args.postId);
  if (!post) throw new CatalogError("POST_NOT_FOUND", 404);
  authorize(actor, config, post);
  if (
    !["draft", "pending_approval", "approved", "scheduled", "retry", "revision_requested"].includes(
      post.status,
    )
  )
    throw new CatalogError("POST_CANNOT_BE_CANCELLED", 409);
  const updated = await updatePostStatus(ctx, companyId, post.id, "cancelled", {
    expectedStatuses: [post.status],
  });
  await audit(ctx, companyId, updated, actor, "cancelled", {
    reason: String(args.reason ?? "").slice(0, 1000),
  });
  return { status: "cancelled", post: updated };
}
export async function serviceTriggerScheduledJob(ctx, companyId, providedConfig, fetchImpl) {
  const config = await configFor(ctx, companyId, providedConfig);
  await recoverInterruptedPosts(ctx, companyId);
  const posts = await findScheduledPostsDue(ctx, companyId);
  const results = [];
  for (const post of posts) {
    try {
      results.push({
        postId: post.id,
        result: await servicePublishPost(
          ctx,
          companyId,
          { postId: post.id },
          { actorType: "system", actorId: "scheduler" },
          config,
          fetchImpl,
        ),
      });
    } catch (error) {
      results.push({ postId: post.id, error: error.code ?? "SCHEDULE_BLOCKED" });
      await audit(
        ctx,
        companyId,
        post,
        { actorType: "system", actorId: "scheduler" },
        "schedule_blocked",
        { code: error.code ?? "SCHEDULE_BLOCKED" },
      );
    }
  }
  return { processedCount: posts.length, results };
}

/** Only exact persisted provider checkpoints may settle an ambiguous write; text matching is never evidence. */
export async function serviceReconcilePost(ctx, companyId, args, actor, providedConfig, fetchImpl) {
  const config = await configFor(ctx, companyId, providedConfig);
  authorize(actor, config);
  if (actor.actorType !== "user")
    throw new PolicyError("Founder reconciliation required", "founder_required");
  const post = await getPost(ctx, companyId, args.postId);
  if (!post) throw new CatalogError("POST_NOT_FOUND", 404);
  if (post.status !== "unknown" || post.dryRun)
    throw new CatalogError("AMBIGUOUS_LIVE_POST_REQUIRED", 409);
  const receipts = await listReceiptsForPost(ctx, companyId, post.id);
  for (const receipt of receipts) {
    if (receipt.status !== "unknown" || !receipt.accountId || !receipt.checkpoint?.platform)
      continue;
    const account = await getAccount(ctx, companyId, receipt.accountId);
    if (!account) continue;
    const target = post.targets.find(
      (item) => item.platform === receipt.platform && item.accountId === receipt.accountId,
    );
    if (!target) continue;
    try {
      const credentials = await resolveAccountCredentials(ctx, companyId, account);
      const response = await getAdapter(receipt.platform).reconcile({
        account: { ...account, credentials },
        content: channelContent(post, target),
        idempotencyKey: `${post.id}:${receiptKey(target)}:v${post.version}`,
        resume: receipt.checkpoint,
        fetchImpl: fetchImpl ?? makeFetch(ctx),
      });
      if (response?.platformPostId && response?.platformPostUrl)
        await recordReceipt(ctx, companyId, {
          ...receipt,
          status: "published",
          platformPostId: response.platformPostId,
          platformPostUrl: response.platformPostUrl,
          checkpoint: response.checkpoint ?? receipt.checkpoint,
          errorCode: null,
          errorMessage: null,
        });
    } catch {
      await audit(ctx, companyId, post, actor, "reconciliation_unresolved", {
        platform: receipt.platform,
        destinationKey: receipt.destinationKey,
      });
    }
  }
  const current = await listReceiptsForPost(ctx, companyId, post.id);
  let status = "unknown";
  if (
    current.length === post.targets.length &&
    current.every((receipt) => receipt.status === "published")
  )
    status = "published";
  else if (
    current.every((receipt) => !["unknown", "processing", "retry"].includes(receipt.status)) &&
    current.some((receipt) => receipt.status === "published")
  )
    status = "partially_published";
  const updated = await updatePostStatus(ctx, companyId, post.id, status, {
    expectedStatuses: ["unknown"],
    publishedAt: current.some((receipt) => receipt.status === "published")
      ? new Date().toISOString()
      : null,
  });
  await audit(ctx, companyId, updated, actor, "reconciled", {
    status,
    receiptStatuses: current.map((receipt) => ({
      platform: receipt.platform,
      status: receipt.status,
      externalPostId: receipt.platformPostId,
    })),
  });
  return { status, post: updated, receipts: current };
}

export async function serviceRetryAuthorization(ctx, companyId, args, actor, providedConfig) {
  const config = await configFor(ctx, companyId, providedConfig);
  authorize(actor, config);
  if (actor.actorType !== "user")
    throw new PolicyError("Founder authorization retry required", "founder_required");
  const post = await getPost(ctx, companyId, args.postId);
  if (!post) throw new CatalogError("POST_NOT_FOUND", 404);
  if (!["failed", "approved"].includes(post.status) || post.dryRun || !approvalMatches(post))
    throw new CatalogError("VALID_APPROVED_AUTH_BLOCK_REQUIRED", 409);
  const receipts = await listReceiptsForPost(ctx, companyId, post.id);
  if (
    receipts.length !== post.targets.length ||
    receipts.some(
      (receipt) =>
        !(
          (receipt.status === "blocked" &&
            ["AUTH_REAUTH_REQUIRED", "AUTH_REFRESH_IN_PROGRESS"].includes(receipt.errorCode)) ||
          (receipt.status === "retry" && receipt.checkpoint?.authorizationRetry === true)
        ) ||
        receipt.checkpoint?.publicationAttempted ||
        receipt.checkpoint?.externalPostId,
    )
  )
    throw new CatalogError("AUTH_RETRY_REQUIRES_UNAMBIGUOUS_PREWRITE_FAILURE", 409);
  for (const receipt of receipts) {
    const account = await getAccount(ctx, companyId, receipt.accountId);
    if (!account) throw new CatalogError("ACCOUNT_NOT_FOUND", 404);
    const prepared = await prepareAccountCredentials(ctx, companyId, account, config);
    const sameDay =
      receipt.checkpoint?.budgetReservedDate === new Date().toISOString().slice(0, 10);
    const checkAccount = {
      ...prepared.account,
      postsToday: Math.max(0, prepared.account.postsToday - (sameDay ? 1 : 0)),
    };
    if (
      !evaluateChannelPolicy(checkAccount, { ...post, status: "approved" }, { config, actor })
        .allowed
    )
      throw new PolicyError(
        "Account must be reconnected and authorized before retry",
        "authorization_required",
      );
  }
  const nextAttemptAt = new Date().toISOString();
  // Claim the post first; a partial DB failure can be retried before any receipt becomes runnable.
  if (post.status === "failed")
    await updatePostStatus(ctx, companyId, post.id, "approved", { expectedStatuses: ["failed"] });
  for (const receipt of receipts)
    await recordReceipt(ctx, companyId, {
      ...receipt,
      status: "retry",
      nextAttemptAt,
      errorCode: null,
      errorMessage: null,
      checkpoint: { ...receipt.checkpoint, authorizationRetry: true },
    });
  const updated = await updatePostStatus(ctx, companyId, post.id, "retry", {
    nextAttemptAt,
    expectedStatuses: ["approved"],
  });
  await audit(ctx, companyId, updated, actor, "authorization_retry_requested", {
    contentHash: post.contentHash,
    version: post.version,
    targets: post.targets,
  });
  return { status: "retry", post: updated };
}
