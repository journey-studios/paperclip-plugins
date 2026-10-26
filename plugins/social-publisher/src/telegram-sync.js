import { getPost, tablePrefix } from "./catalog.js";
import { composeText } from "./adapters/common.js";
import { approvalMediaLinks } from "./media.js";

const scope = (companyId, postId) => ({
  scopeKind: "company",
  scopeId: companyId,
  stateKey: `approval:${postId}`,
});

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

export async function requestPostApproval(ctx, companyId, post, _validation, config) {
  if (config.telegramNotificationsEnabled === false) throw new Error("TELEGRAM_APPROVAL_DISABLED");
  if (!config.telegramConversationIssueId || !config.telegramAgentId || !config.founderUserId)
    throw new Error("TELEGRAM_APPROVAL_NOT_CONFIGURED");
  const conversation = await ctx.issues.get(config.telegramConversationIssueId, companyId);
  if (
    !conversation ||
    conversation.originKind !== "chat_channel" ||
    !conversation.originId?.includes(":telegram:")
  )
    throw new Error("TELEGRAM_CONVERSATION_REQUIRED");
  const preview = await approvalPreview(post, await approvalMediaLinks(ctx, companyId, post, config));
  // Native Paperclip owns the paired human, private chat, random callback tokens and anti-replay transaction.
  const interaction = await ctx.issues.askUserQuestions(
    conversation.id,
    {
      idempotencyKey: `social:${post.id}:${post.version}:${post.contentHash}`,
      resolverPolicy: "human_only",
      addresseeUserId: config.founderUserId,
      title: "Tessel Social Daily — decisão",
      summary: `Post ${post.id}, versão ${post.version}; destinos e conteúdo vinculados ao hash.`,
      continuationPolicy: "none",
      payload: {
        version: 1,
        title: "Tessel Social Daily",
        supersedeOnUserComment: false,
        questions: [
          {
            id: "social_decision",
            prompt: "Decisão para esta versão e estes destinos",
            helpText: preview,
            selectionMode: "single",
            required: true,
            allowOther: false,
            options: [
              { id: "approved", label: "Aprovar" },
              { id: "revision_requested", label: "Solicitar ajustes" },
              { id: "rejected", label: "Rejeitar" },
            ],
          },
        ],
      },
    },
    companyId,
    { authorAgentId: config.telegramAgentId },
  );
  if (
    !interaction?.id ||
    interaction.companyId !== companyId ||
    interaction.issueId !== conversation.id
  )
    throw new Error("TELEGRAM_INTERACTION_NOT_ACKNOWLEDGED");
  await ctx.state.set(scope(companyId, post.id), {
    interactionId: interaction.id,
    issueId: conversation.id,
    postId: post.id,
    version: post.version,
    contentHash: post.contentHash,
    targets: post.targets,
    expiresAt: new Date(post.approvalExpiresAt).toISOString(),
  });
  return {
    interactionId: interaction.id,
    conversationIssueId: conversation.id,
    status: "queued_by_native_host",
    delivered: false,
  };
}

export async function reconcileTelegramApprovals(ctx, companyId, config) {
  if (!config.telegramConversationIssueId) return { checked: 0, applied: 0 };
  const pending = await ctx.db.query(
    `SELECT id FROM ${tablePrefix(ctx)}.social_posts WHERE company_id=$1 AND status='pending_approval' ORDER BY created_at LIMIT 50`,
    [companyId],
  );
  if (!pending.length) return { checked: 0, applied: 0 };
  const interactions = await ctx.issues.listInteractions(
    config.telegramConversationIssueId,
    companyId,
  );
  let applied = 0;
  for (const row of pending) {
    const binding = await ctx.state.get(scope(companyId, row.id));
    if (!binding || binding.issueId !== config.telegramConversationIssueId) continue;
    const interaction = interactions.find((item) => item.id === binding.interactionId);
    if (
      !interaction ||
      interaction.companyId !== companyId ||
      interaction.issueId !== binding.issueId ||
      interaction.kind !== "ask_user_questions" ||
      interaction.status !== "answered" ||
      interaction.resolvedByUserId !== config.founderUserId ||
      interaction.resolvedByAgentId ||
      interaction.result?.cancelled ||
      interaction.result?.expirationReason
    )
      continue;
    const answers = interaction.result?.answers;
    if (
      answers?.length !== 1 ||
      answers[0].questionId !== "social_decision" ||
      answers[0].optionIds?.length !== 1 ||
      answers[0].otherText
    )
      continue;
    const decision = answers[0].optionIds[0];
    if (!["approved", "revision_requested", "rejected"].includes(decision)) continue;
    const post = await getPost(ctx, companyId, binding.postId);
    if (!post || post.approvalRequestId !== binding.interactionId) continue;
    const { serviceDecideApproval } = await import("./service.js");
    try {
      await serviceDecideApproval(
        ctx,
        companyId,
        { ...binding, decision },
        { actorType: "user", actorId: interaction.resolvedByUserId },
        config,
      );
      applied++;
    } catch (error) {
      if (
        ![
          "APPROVAL_EXPIRED",
          "APPROVAL_VERSION_OR_TARGET_MISMATCH",
          "POST_STATE_CONFLICT",
        ].includes(error.message)
      )
        throw error;
    }
  }
  return { checked: pending.length, applied };
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
