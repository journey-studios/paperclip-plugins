import { createHash } from "node:crypto";
import { getPost, tablePrefix, canonical, contentHash, updatePostStatus, appendAuditLog, CatalogError } from "./catalog.js";
import { composeText } from "./adapters/common.js";
import { approvalMediaLinks } from "./media.js";

const scope = (companyId, postId) => ({
  scopeKind: "company",
  scopeId: companyId,
  stateKey: `approval:${postId}`,
});
const approvalLocks = new Map();
const approvalKey = (post) => `social:${post.id}:${post.version}:${post.contentHash}`;
const obsoleteStates = new Set(["cancelled", "superseded", "approval_expired"]);
function serialApproval(key, operation) {
  const previous = approvalLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  approvalLocks.set(key, current);
  return current.finally(() => { if (approvalLocks.get(key) === current) approvalLocks.delete(key); });
}
function questionDigest(payload) {
  const normalized = payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload } : {};
  // Null optional text has no presentation. Every actual presentation field, including questionSet,
  // submitLabel, option descriptions and freeText, must remain part of the authenticated digest.
  if (normalized.submitLabel === null) delete normalized.submitLabel;
  if (Array.isArray(normalized.questions)) normalized.questions = normalized.questions.map((question) => ({
    ...question,
    ...(Array.isArray(question.options) ? { options: question.options.map((option) => {
      const result = { ...option };
      if (result.description === null) delete result.description;
      return result;
    }) } : {}),
  }));
  return createHash("sha256").update(canonical(normalized)).digest("hex");
}
function bindingMatches(binding, post, issueId) {
  return Boolean(binding && (binding.companyId === undefined || binding.companyId === post.companyId) &&
    binding.issueId === issueId && binding.postId === post.id && binding.version === post.version &&
    binding.contentHash === post.contentHash && canonical(binding.targets) === canonical(post.targets) &&
    new Date(binding.expiresAt).getTime() === new Date(post.approvalExpiresAt).getTime());
}
function nativeScopeMatches(interaction, companyId, issueId, config) {
  return interaction?.companyId === companyId && interaction.issueId === issueId &&
    interaction.kind === "ask_user_questions" && interaction.createdByAgentId === config.telegramAgentId &&
    interaction.addresseeUserId === config.founderUserId && interaction.resolverPolicy === "human_only" &&
    (!interaction.effectiveResolverPolicy || interaction.effectiveResolverPolicy === "human_only");
}
function expirationReason(interaction) {
  if (interaction?.result?.expirationReason) return "native_superseded";
  if (interaction?.result?.cancelled || interaction?.status === "cancelled") return "native_cancelled";
  if (interaction?.result?.outcome && interaction.result.outcome !== "resolved") return "native_withdrawn";
  if (["expired", "failed", "rejected", "accepted"].includes(interaction?.status)) return "native_expired";
  return null;
}
function deadlineExpired(post) {
  const deadline = new Date(post.approvalExpiresAt).getTime();
  return !Number.isFinite(deadline) || deadline <= Date.now();
}

/** Expiry is a system lifecycle event, never a fabricated rejection or human approval. */
export async function expirePostApproval(ctx, companyId, post, reason, interactionId = post.approvalRequestId) {
  if (post.status !== "pending_approval") return post;
  let expired;
  try {
    expired = await updatePostStatus(ctx, companyId, post.id, "approval_expired", {
      expectedStatuses: ["pending_approval"], expectedHash: post.contentHash,
      decisionReason: reason, approvalRequestId: interactionId ?? null,
      approvedAt: null, approvedBy: null, approvalHash: null,
    });
  } catch (error) {
    if (error.message === "POST_STATE_CONFLICT") return getPost(ctx, companyId, post.id);
    throw error;
  }
  await appendAuditLog(ctx, companyId, {
    postId: post.id, actorType: "system", actorId: "telegram_approval_queue", action: "approval_expired",
    details: { reason, version: post.version, contentHash: post.contentHash, targets: post.targets, interactionId },
  });
  return expired;
}

export async function approvalPreview(post, mediaLinks = []) {
  const { channelContent } = await import("./service.js");
  const lines = [
    post.dryRun
      ? "DRY-RUN: esta decisão não autoriza publicação pública."
      : "Publicação nas redes selecionadas após aprovação.",
    `Post ${post.id} · versão ${post.version}`,
    `SHA-256 ${post.contentHash}`,
    `Validade: ${new Date(post.approvalExpiresAt).toISOString()}`,
    `Agenda: ${post.scheduledAt ? new Date(post.scheduledAt).toISOString() : "a definir"}`,
  ];
  for (const target of post.targets) {
    const content = channelContent(post, target);
    lines.push(
      "",
      `${target.platform} · conta ${target.accountId ?? "NÃO CONECTADA"}`,
      composeText(content),
    );
    for (const url of content.mediaUrls) lines.push(`Mídia: ${url}`);
    for (const ref of content.mediaRefs ?? [])
      lines.push(`JPEG ${ref.width}×${ref.height} · SHA-256 ${ref.sha256}`);
    if (content.linkUrl) lines.push(`CTA: ${content.linkUrl}`);
  }
  for (const link of mediaLinks) lines.push(
    "", `Ver JPEG ${link.media.sha256} (acesso autenticado do fundador):`, link.previewUrl,
  );
  lines.push("", "As afirmações e fontes devem ser verificadas antes de aprovar.");
  for (const evidence of post.metadata?.factualEvidence ?? [])
    lines.push(`${evidence.claim} — ${evidence.sourceUrl}`);
  const preview = lines.join("\n");
  // A truncated approval would authorize content the recipient has not seen.
  if (preview.length > 3800)
    throw new Error("TELEGRAM_PREVIEW_TOO_LONG: reduza o conteúdo ou separe os destinos");
  return preview;
}

export async function preparePostApproval(ctx, companyId, post, config) {
  if (config.telegramNotificationsEnabled === false) throw new Error("TELEGRAM_APPROVAL_DISABLED");
  if (!config.telegramConversationIssueId || !config.telegramAgentId || !config.founderUserId)
    throw new Error("TELEGRAM_APPROVAL_NOT_CONFIGURED");
  const conversation = await ctx.issues.get(config.telegramConversationIssueId, companyId);
  if (!conversation || conversation.companyId !== companyId || conversation.id !== config.telegramConversationIssueId ||
      conversation.originKind !== "chat_channel" || !conversation.originId?.includes(":telegram:"))
    throw new Error("TELEGRAM_CONVERSATION_REQUIRED");
  // The native question schema trims helpText; persist and hash the same canonical presentation.
  const preview = (await approvalPreview(post, await approvalMediaLinks(ctx, companyId, post, config))).trim();
  return {
    conversation,
    request: {
      idempotencyKey: approvalKey(post), resolverPolicy: "human_only", addresseeUserId: config.founderUserId,
      title: "Tessel Social Daily — decisão",
      summary: `Post ${post.id}, versão ${post.version}; destinos e conteúdo vinculados ao hash.`,
      continuationPolicy: "none",
      payload: {
        version: 1, title: "Tessel Social Daily", supersedeOnUserComment: false,
        questions: [{
          id: "social_decision", prompt: "Decisão para esta versão e estes destinos", helpText: preview,
          selectionMode: "single", required: true, allowOther: false,
          options: [
            { id: "approved", label: "Aprovar" },
            { id: "revision_requested", label: "Solicitar ajustes" },
            { id: "rejected", label: "Rejeitar" },
          ],
        }],
      },
    },
  };
}
function approvalBinding(post, issueId, request, interactionId = null) {
  return {
    companyId: post.companyId, issueId, postId: post.id, version: post.version,
    contentHash: post.contentHash, targets: post.targets,
    expiresAt: new Date(post.approvalExpiresAt).toISOString(),
    idempotencyKey: request.idempotencyKey, questionDigest: questionDigest(request.payload), interactionId,
  };
}
async function bindNativeInteraction(ctx, companyId, post, interaction, config, request) {
  const saved = await ctx.state.get(scope(companyId, post.id));
  const digest = saved?.questionDigest ?? questionDigest(request.payload);
  if ((saved && !bindingMatches(saved, post, config.telegramConversationIssueId)) ||
      (saved?.interactionId && saved.interactionId !== interaction.id) ||
      !nativeScopeMatches(interaction, companyId, config.telegramConversationIssueId, config) ||
      interaction.idempotencyKey !== approvalKey(post) || questionDigest(interaction.payload) !== digest ||
      contentHash(post) !== post.contentHash)
    throw new CatalogError("TELEGRAM_APPROVAL_BINDING_MISMATCH", 409);
  const binding = { ...approvalBinding(post, config.telegramConversationIssueId, request, interaction.id), questionDigest: digest };
  await ctx.state.set(scope(companyId, post.id), binding);
  return binding;
}
async function provenOwner(ctx, companyId, interaction, config) {
  if (!nativeScopeMatches(interaction, companyId, config.telegramConversationIssueId, config)) return null;
  const key = /^social:([0-9a-f-]{36}):[1-9][0-9]*:[a-f0-9]{64}$/.exec(interaction.idempotencyKey ?? "");
  if (!key) return null;
  const post = await getPost(ctx, companyId, key[1]);
  if (!post || contentHash(post) !== post.contentHash) return null;
  const binding = await ctx.state.get(scope(companyId, post.id));
  if (!bindingMatches(binding, post, config.telegramConversationIssueId) ||
      (binding.interactionId !== interaction.id && !(binding.interactionId === null && binding.idempotencyKey === interaction.idempotencyKey)))
    return null;
  if (binding.questionDigest && binding.questionDigest !== questionDigest(interaction.payload)) return null;
  return { post, binding };
}

/** A single Social conversation lock protects list/create; external plugins still own independent native writes. */
export async function requestPostApproval(ctx, companyId, post, _validation, config, prepared = null) {
  return serialApproval(`${companyId}:${config.telegramConversationIssueId}`, async () => {
    if (deadlineExpired(post)) {
      await expirePostApproval(ctx, companyId, post, "local_ttl_expired");
      return { status: "approval_expired", delivered: false };
    }
    const { conversation, request } = prepared ?? await preparePostApproval(ctx, companyId, post, config);
    const interactions = await ctx.issues.listInteractions(conversation.id, companyId);
    if (!Array.isArray(interactions)) throw new Error("TELEGRAM_INTERACTIONS_UNAVAILABLE");
    const saved = await ctx.state.get(scope(companyId, post.id));
    const existing = interactions.find((item) => item.idempotencyKey === request.idempotencyKey ||
      item.id === post.approvalRequestId || item.id === saved?.interactionId);
    if (existing) {
      await bindNativeInteraction(ctx, companyId, post, existing, config, request);
      const reason = expirationReason(existing);
      if (reason) {
        await expirePostApproval(ctx, companyId, post, reason, existing.id);
        return { status: "approval_expired", interactionId: existing.id, delivered: false };
      }
      return { interactionId: existing.id, conversationIssueId: conversation.id, status: "queued_by_native_host", delivered: false, replayed: true };
    }
    for (const interaction of interactions.filter((item) => item.status === "pending")) {
      if (interaction.companyId !== companyId || interaction.issueId !== conversation.id)
        throw new Error("TELEGRAM_INTERACTION_SCOPE_MISMATCH");
      const owner = await provenOwner(ctx, companyId, interaction, config);
      if (owner && obsoleteStates.has(owner.post.status)) continue;
      if (owner?.post.status === "pending_approval" && deadlineExpired(owner.post)) {
        await expirePostApproval(ctx, companyId, owner.post, "local_ttl_expired", interaction.id);
        continue;
      }
      return { conversationIssueId: conversation.id, status: "queued", reason: "conversation_busy", delivered: false };
    }
    // Missing native receipts are never replaced speculatively; the local TTL closes them explicitly.
    if (post.approvalRequestId || saved?.interactionId)
      return { conversationIssueId: conversation.id, status: "queued", reason: "awaiting_native_reconciliation", delivered: false };
    const [head] = await ctx.db.query(
      `SELECT id FROM ${tablePrefix(ctx)}.social_posts WHERE company_id=$1 AND status='pending_approval' AND approval_request_id IS NULL ORDER BY created_at,id LIMIT 1`,
      [companyId],
    );
    if (head && head.id !== post.id)
      return { conversationIssueId: conversation.id, status: "queued", reason: "earlier_approval_waiting", delivered: false };
    const intent = approvalBinding(post, conversation.id, request);
    if (saved && (!bindingMatches(saved, post, conversation.id) ||
        (saved.questionDigest && saved.questionDigest !== intent.questionDigest)))
      throw new CatalogError("TELEGRAM_APPROVAL_BINDING_MISMATCH", 409);
    // Persist intent before the native side effect. A restart reuses its exact idempotency key and preview digest.
    await ctx.state.set(scope(companyId, post.id), intent);
    const interaction = await ctx.issues.askUserQuestions(conversation.id, request, companyId, { authorAgentId: config.telegramAgentId });
    await bindNativeInteraction(ctx, companyId, post, interaction, config, request);
    const reason = expirationReason(interaction);
    if (reason) {
      await expirePostApproval(ctx, companyId, post, reason, interaction.id);
      return { status: "approval_expired", interactionId: interaction.id, delivered: false };
    }
    return { interactionId: interaction.id, conversationIssueId: conversation.id, status: "queued_by_native_host", delivered: false };
  });
}

export async function reconcileTelegramApprovals(ctx, companyId, config) {
  const result = { checked: 0, applied: 0, expired: 0, submitted: 0, waiting: 0 };
  if (!config.telegramConversationIssueId) return result;
  const pending = await ctx.db.query(
    `SELECT id FROM ${tablePrefix(ctx)}.social_posts WHERE company_id=$1 AND status='pending_approval' ORDER BY created_at,id LIMIT 50`, [companyId],
  );
  result.checked = pending.length;
  if (!pending.length) return result;
  const interactions = await ctx.issues.listInteractions(config.telegramConversationIssueId, companyId);
  if (!Array.isArray(interactions)) throw new Error("TELEGRAM_INTERACTIONS_UNAVAILABLE");
  for (const row of pending) {
    let post = await getPost(ctx, companyId, row.id);
    if (post.status !== "pending_approval") continue;
    if (deadlineExpired(post)) {
      if ((await expirePostApproval(ctx, companyId, post, "local_ttl_expired")).status === "approval_expired") result.expired++;
      continue;
    }
    const saved = await ctx.state.get(scope(companyId, post.id));
    const interaction = interactions.find((item) => item.id === post.approvalRequestId ||
      item.id === saved?.interactionId || item.idempotencyKey === approvalKey(post));
    if (!interaction) continue;
    const { request } = await preparePostApproval(ctx, companyId, post, config);
    const binding = await bindNativeInteraction(ctx, companyId, post, interaction, config, request);
    if (!post.approvalRequestId) post = await updatePostStatus(ctx, companyId, post.id, "pending_approval", {
      approvalRequestId: interaction.id, expectedStatuses: ["pending_approval"], expectedHash: post.contentHash,
    });
    const reason = expirationReason(interaction);
    if (reason) {
      if ((await expirePostApproval(ctx, companyId, post, reason)).status === "approval_expired") result.expired++;
      continue;
    }
    if (interaction.status !== "answered" || interaction.resolvedByUserId !== config.founderUserId || interaction.resolvedByAgentId)
      continue;
    const answers = interaction.result?.answers;
    if (answers?.length !== 1 || answers[0].questionId !== "social_decision" || answers[0].optionIds?.length !== 1 || answers[0].otherText)
      continue;
    const decision = answers[0].optionIds[0];
    if (!["approved", "revision_requested", "rejected"].includes(decision)) continue;
    const { serviceDecideApproval } = await import("./service.js");
    try {
      await serviceDecideApproval(ctx, companyId, { ...binding, decision }, { actorType: "user", actorId: interaction.resolvedByUserId }, config);
      result.applied++;
    } catch (error) {
      if (!["APPROVAL_EXPIRED", "APPROVAL_VERSION_OR_TARGET_MISMATCH", "POST_STATE_CONFLICT"].includes(error.message)) throw error;
    }
  }
  // Re-read after decisions/expiry. The oldest queued version may now safely claim the conversation.
  const queued = await ctx.db.query(
    `SELECT id FROM ${tablePrefix(ctx)}.social_posts WHERE company_id=$1 AND status='pending_approval' AND approval_request_id IS NULL ORDER BY created_at,id LIMIT 50`, [companyId],
  );
  const { serviceRequestApproval } = await import("./service.js");
  for (const row of queued) {
    try {
      const response = await serviceRequestApproval(ctx, companyId, { postId: row.id }, { actorType: "system", actorId: "scheduler" }, config);
      if (response.status === "approval_expired") { result.expired++; continue; }
      if (response.delivery?.interactionId) result.submitted++;
      if (response.delivery?.status === "queued") { result.waiting++; break; }
    } catch (error) {
      const permanent = error.message.startsWith("TELEGRAM_PREVIEW_TOO_LONG") ||
        ["CONTENT_OR_FACTUAL_EVIDENCE_NOT_READY", "POST_CONTENT_INTEGRITY_FAILURE", "MEDIA_REFERENCE_INTEGRITY_FAILURE"].includes(error.message);
      const post = await getPost(ctx, companyId, row.id);
      if (permanent && post?.status === "pending_approval" && !post.approvalRequestId) {
        await expirePostApproval(ctx, companyId, post, "approval_preparation_invalid");
        result.expired++;
        continue;
      }
      ctx.logger.warn("Social approval preparation deferred", { companyId, postId: row.id, code: "APPROVAL_PREPARATION_UNAVAILABLE" });
      result.waiting++;
      break;
    }
  }
  return result;
}

export async function notifyPublicationReceipt(ctx, companyId, post, receipts, config) {
  if (config.telegramNotificationsEnabled === false || !config.telegramConversationIssueId)
    return { delivered: false };
  const lines = [
    post.dryRun
      ? "Social Publisher — dry-run concluído"
      : "Social Publisher — resultado por destino",
    `Post ${post.id} · versão ${post.version}`,
  ];
  for (const receipt of receipts) {
    lines.push(
      `${receipt.platform}: ${receipt.status}${receipt.platformPostId ? ` · ID ${receipt.platformPostId}` : ""}${receipt.platformPostUrl ? ` · ${receipt.platformPostUrl}` : ""}${receipt.errorCode ? ` · ${receipt.errorCode}` : ""}`,
    );
  }
  const comment = await ctx.issues.createComment(
    config.telegramConversationIssueId,
    lines.join("\n"),
    companyId,
    { authorAgentId: config.telegramAgentId },
  );
  const publication = await ctx.chat.publishComment(comment.id, companyId);
  return {
    publicationId: publication.id,
    status: publication.state,
    delivered: publication.state === "published",
  };
}
