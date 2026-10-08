import { createHash } from "node:crypto";
import {
  CARD_MARKER,
  INTERACTION_ISSUE_LIMIT_PER_STATUS,
  INTERACTION_ISSUE_STATUSES,
  approvalFingerprint,
  buildApprovalCardBody,
  buildInteractionCardBody,
  cardDeliveryId,
  interactionFingerprint,
  isFounderReachableInteraction,
} from "./human-decisions.js";
import { assertPublicationAccepted, nextPublicationFailure } from "./publication-policy.js";

const FINGERPRINTS_KEY = "human-decision-fingerprints";
const RECONCILED_AT_KEY = "human-decision-reconciled-at";
const ISSUE_OFFSETS_KEY = "human-decision-issue-offsets";
const MAX_PUBLISHED = 500;
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

function logDeliveryFailure(ctx, companyId, kind, entityId) {
  ctx.logger.error("Founder human decision card delivery failed", {
    companyId,
    kind,
    entityId,
    error: "delivery_failed",
  });
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function companyScope(companyId, stateKey) {
  return { scopeKind: "company", scopeId: companyId, stateKey };
}

async function humanDecisionFingerprints(ctx, companyId) {
  return asObject(await ctx.state.get(companyScope(companyId, FINGERPRINTS_KEY)));
}

async function rememberHumanDecisionFingerprint(ctx, companyId, trackKey, fingerprint, issueId = null, commentId = null) {
  const key = companyScope(companyId, FINGERPRINTS_KEY);
  const prior = await humanDecisionFingerprints(ctx, companyId);
  if (issueId || commentId) {
    const record = { fingerprint };
    if (issueId) record.issueId = issueId;
    if (commentId) record.commentId = commentId;
    prior[trackKey] = record;
  } else {
    prior[trackKey] = fingerprint;
  }
  await ctx.state.set(key, prior);
}

async function clearHumanDecisionFingerprint(ctx, companyId, trackKey) {
  const key = companyScope(companyId, FINGERPRINTS_KEY);
  const prior = await humanDecisionFingerprints(ctx, companyId);
  if (!(trackKey in prior)) return;
  delete prior[trackKey];
  await ctx.state.set(key, prior);
}

async function ensureHumanDecisionComment(ctx, companyId, conversation, config, deliveryId, cardBody) {
  if (!stringValue(cardBody)?.includes(CARD_MARKER)) {
    throw new Error("Invalid founder human decision card marker");
  }
  const token = createHash("sha256")
    .update(JSON.stringify([companyId, conversation.id, deliveryId]))
    .digest("hex");
  const key = companyScope(companyId, `human-decision-comment:${token}`);
  const prior = asObject(await ctx.state.get(key));
  if (prior.created === true && stringValue(prior.commentId)) {
    return { commentId: prior.commentId, issueId: conversation.id };
  }

  const deliveryLine = `delivery=${token}`;
  const tagged = cardBody.includes(deliveryLine) ? cardBody : `${cardBody}\n${deliveryLine}`;
  const existing = (await ctx.issues.listComments(conversation.id, companyId)).find((comment) =>
    comment.issueId === conversation.id && comment.companyId === companyId && !comment.deletedAt &&
    typeof comment.body === "string" && comment.body.includes(CARD_MARKER) && comment.body.includes(deliveryLine));
  const authorAgentId = stringValue(conversation.assigneeAgentId) ?? config.liaisonAgentId;
  const created = existing ?? await ctx.issues.createComment(
    conversation.id, tagged, companyId, { authorAgentId },
  );
  const record = { created: true, issueId: conversation.id, commentId: stringValue(created?.id) };
  await ctx.state.set(key, record);
  return record;
}

async function publishHumanDecisionCard(ctx, companyId, config, deliveryId, cardBody, resolveConversation) {
  const conversation = await resolveConversation(ctx, companyId, config);
  if (!conversation) return { delivered: false, reason: "conversation_not_bound" };

  const { commentId } = await ensureHumanDecisionComment(
    ctx, companyId, conversation, config, deliveryId, cardBody,
  );
  if (!commentId) return { delivered: false, reason: "comment_not_created" };

  // The Paperclip comment remains the canonical record when native publication is not enabled.
  if (!config.publicationEnabled) return { delivered: true, commentId, issueId: conversation.id, publication: "disabled" };

  const publishedKey = companyScope(companyId, "published-comment-ids");
  const prior = await ctx.state.get(publishedKey);
  const ids = Array.isArray(prior) ? prior.filter((value) => typeof value === "string") : [];
  if (ids.includes(commentId)) return { delivered: true, commentId, issueId: conversation.id };

  const ledgerKey = companyScope(companyId, `human-decision-publication:${commentId}`);
  const ledger = asObject(await ctx.state.get(ledgerKey));
  if (ledger.terminal === true) return { delivered: true, commentId, issueId: conversation.id, publication: "requires_review" };
  try {
    const result = await ctx.chat.publishComment(commentId, companyId);
    assertPublicationAccepted(result);
    ids.push(commentId);
    await ctx.state.set(publishedKey, ids.slice(-MAX_PUBLISHED));
    await ctx.state.delete(ledgerKey);
    return { delivered: true, commentId, issueId: conversation.id };
  } catch (error) {
    const attempts = Number.isSafeInteger(ledger.attempts) && ledger.attempts >= 0 ? ledger.attempts : 0;
    await ctx.state.set(ledgerKey, { ...ledger, ...nextPublicationFailure(attempts, error) });
    throw error;
  }
}

async function deliverHumanDecisionCard(ctx, companyId, config, delivery, resolveConversation) {
  const { kind, entityId, fingerprint, cardBody, wakeEventId } = delivery;
  const trackKey = `${kind}:${entityId}`;
  const prior = await humanDecisionFingerprints(ctx, companyId);
  const priorRecord = asObject(prior[trackKey]);
  const priorFingerprint = typeof prior[trackKey] === "string" ? prior[trackKey] : priorRecord.fingerprint;
  if (stringValue(priorFingerprint) === fingerprint) {
    if (!config.publicationEnabled) return { skipped: true };
    const priorCommentId = stringValue(priorRecord.commentId);
    if (priorCommentId) {
      const published = await ctx.state.get(companyScope(companyId, "published-comment-ids"));
      if (Array.isArray(published) && published.includes(priorCommentId)) return { skipped: true };
    }
  }

  const deliveryId = wakeEventId ?? cardDeliveryId(kind, entityId, fingerprint);
  const result = await publishHumanDecisionCard(ctx, companyId, config, deliveryId, cardBody, resolveConversation);
  if (result.delivered !== false) {
    await rememberHumanDecisionFingerprint(ctx, companyId, trackKey, fingerprint, delivery.issueId, result.commentId);
  }
  return result;
}

async function reconcilePendingApprovals(ctx, companyId, config, resolveConversation) {
  if (!config.immediateEnabled || !ctx.approvals?.list) return;
  const list = await ctx.approvals.list({ companyId, status: "pending" });
  const pendingIds = new Set();
  for (const approval of Array.isArray(list) ? list : []) {
    if (!approval?.id || approval.companyId !== companyId || approval.status !== "pending") continue;
    pendingIds.add(approval.id);
    const fingerprint = approvalFingerprint(approval);
    try {
      await deliverHumanDecisionCard(ctx, companyId, config, {
        kind: "approval",
        entityId: approval.id,
        fingerprint,
        cardBody: buildApprovalCardBody(approval, null, companyId),
      }, resolveConversation);
    } catch {
      logDeliveryFailure(ctx, companyId, "approval", approval.id);
    }
  }

  const tracked = await humanDecisionFingerprints(ctx, companyId);
  for (const trackKey of Object.keys(tracked)) {
    if (trackKey.startsWith("approval:") && !pendingIds.has(trackKey.slice("approval:".length))) {
      await clearHumanDecisionFingerprint(ctx, companyId, trackKey);
    }
  }
}

async function listOpenIssuesForInteractionPoll(ctx, companyId) {
  const cursorsKey = companyScope(companyId, ISSUE_OFFSETS_KEY);
  const offsets = asObject(await ctx.state.get(cursorsKey));
  const byId = new Map();
  for (const status of INTERACTION_ISSUE_STATUSES) {
    const offset = Number.isSafeInteger(offsets[status]) && offsets[status] >= 0 ? offsets[status] : 0;
    const batch = await ctx.issues.list({ companyId, status, limit: INTERACTION_ISSUE_LIMIT_PER_STATUS, offset });
    const issues = Array.isArray(batch) ? batch : [];
    for (const issue of issues) {
      if (issue?.id && issue.companyId === companyId) byId.set(issue.id, issue);
    }
    offsets[status] = issues.length === INTERACTION_ISSUE_LIMIT_PER_STATUS ? offset + issues.length : 0;
  }
  await ctx.state.set(cursorsKey, offsets);
  return [...byId.values()];
}

async function reconcilePendingInteractions(ctx, companyId, config, resolveConversation) {
  if (!config.immediateEnabled || !ctx.issues?.listInteractions) return;
  const issues = await listOpenIssuesForInteractionPoll(ctx, companyId);
  const pendingKeys = new Set();
  const visitedIssueIds = new Set(issues.map((issue) => issue.id));

  for (const issue of issues) {
    let interactions;
    try {
      interactions = await ctx.issues.listInteractions(issue.id, companyId);
    } catch {
      ctx.logger.error("Founder human decision issue scan failed", {
        companyId,
        issueId: issue.id,
        error: "interaction_list_failed",
      });
      continue;
    }
    for (const interaction of Array.isArray(interactions) ? interactions : []) {
      if (!isFounderReachableInteraction(interaction, config.founderUserId)) continue;
      pendingKeys.add(`interaction:${interaction.id}`);
      const fingerprint = interactionFingerprint(interaction);
      try {
        await deliverHumanDecisionCard(ctx, companyId, config, {
          kind: "interaction",
          entityId: interaction.id,
          issueId: issue.id,
          fingerprint,
          cardBody: buildInteractionCardBody(interaction, issue, companyId),
        }, resolveConversation);
      } catch {
        logDeliveryFailure(ctx, companyId, "interaction", interaction.id);
      }
    }
  }

  const tracked = await humanDecisionFingerprints(ctx, companyId);
  for (const trackKey of Object.keys(tracked)) {
    const issueId = stringValue(asObject(tracked[trackKey]).issueId);
    if (trackKey.startsWith("interaction:") && issueId && visitedIssueIds.has(issueId) && !pendingKeys.has(trackKey)) {
      await clearHumanDecisionFingerprint(ctx, companyId, trackKey);
    }
  }
}

async function reconcileHumanDecisions(ctx, companyId, config, resolveConversation, now = Date.now()) {
  if (!config.immediateEnabled) return { skipped: true };
  const reconciledAtKey = companyScope(companyId, RECONCILED_AT_KEY);
  const prior = Date.parse(await ctx.state.get(reconciledAtKey));
  if (Number.isFinite(prior) && now - prior < RECONCILE_INTERVAL_MS) return { skipped: true };
  // Claim the interval before network work so outages cannot trigger a hot retry every digest minute.
  await ctx.state.set(reconciledAtKey, new Date(now).toISOString());
  try {
    await reconcilePendingApprovals(ctx, companyId, config, resolveConversation);
    await reconcilePendingInteractions(ctx, companyId, config, resolveConversation);
  } catch {
    throw new Error("Human decision reconciliation failed");
  }
  return { skipped: false };
}

async function reconcileKnownHumanDecisions(ctx, companyConfig, resolveConversation, serialize = async (_companyId, fn) => fn()) {
  const known = await ctx.state.get({ scopeKind: "instance", stateKey: "known-companies" });
  for (const companyId of Array.isArray(known) ? known : []) {
    if (!stringValue(companyId)) continue;
    await serialize(companyId, async () => {
      try {
        await reconcileHumanDecisions(ctx, companyId, await companyConfig(ctx, companyId), resolveConversation);
      } catch {
        ctx.logger.error("Founder human decision reconciliation failed", {
          companyId,
          error: "reconciliation_failed",
        });
      }
    });
  }
}

async function handleApproval(ctx, event, config, resolveConversation) {
  if (!config.immediateEnabled || !event.entityId) return;
  try {
    const approval = await ctx.approvals.get(event.entityId, event.companyId);
    if (!approval || approval.companyId !== event.companyId || approval.status !== "pending") return;
    const fingerprint = approvalFingerprint(approval);
    await deliverHumanDecisionCard(ctx, event.companyId, config, {
      kind: "approval",
      entityId: approval.id,
      fingerprint,
      cardBody: buildApprovalCardBody(approval, null, event.companyId),
    }, resolveConversation);
  } catch {
    throw new Error("Human decision delivery failed");
  }
}

async function clearApprovalFingerprint(ctx, companyId, approvalId) {
  await clearHumanDecisionFingerprint(ctx, companyId, `approval:${approvalId}`);
}

async function retryTerminalHumanDecisionPublication(ctx, companyId, commentId, config) {
  if (!config.publicationEnabled) return { retried: false, reason: "publication_disabled" };
  const safeCompanyId = stringValue(companyId);
  const safeCommentId = stringValue(commentId);
  if (!safeCompanyId || !safeCommentId || safeCommentId.length > 128) {
    return { retried: false, reason: "invalid_request" };
  }

  const publishedKey = companyScope(safeCompanyId, "published-comment-ids");
  const published = await ctx.state.get(publishedKey);
  if (Array.isArray(published) && published.includes(safeCommentId)) {
    return { retried: false, reason: "already_published" };
  }
  const ledgerKey = companyScope(safeCompanyId, `human-decision-publication:${safeCommentId}`);
  const ledger = asObject(await ctx.state.get(ledgerKey));
  if (ledger.terminal !== true || ledger.lastFailure !== "publication_attempt_failed") {
    return { retried: false, reason: "not_retryable" };
  }

  try {
    const result = await ctx.chat.publishComment(safeCommentId, safeCompanyId);
    assertPublicationAccepted(result);
    const latest = await ctx.state.get(publishedKey);
    const ids = Array.isArray(latest) ? latest.filter((value) => typeof value === "string") : [];
    if (!ids.includes(safeCommentId)) ids.push(safeCommentId);
    await ctx.state.set(publishedKey, ids.slice(-MAX_PUBLISHED));
    await ctx.state.delete(ledgerKey);
    return { retried: true, commentId: safeCommentId, publication: result.state };
  } catch (error) {
    const attempts = Number.isSafeInteger(ledger.attempts) && ledger.attempts >= 0 ? ledger.attempts : 0;
    const failure = { ...nextPublicationFailure(attempts, error), terminal: true };
    await ctx.state.set(ledgerKey, { ...ledger, ...failure });
    return { retried: false, commentId: safeCommentId, reason: failure.lastFailure };
  }
}

function createHumanDecisionDelivery({ companyConfig, resolveConversation }) {
  return {
    handleApproval: (ctx, event, config) => handleApproval(ctx, event, config, resolveConversation),
    clearApprovalFingerprint,
    reconcileHumanDecisions: (ctx, companyId, config, now) =>
      reconcileHumanDecisions(ctx, companyId, config, resolveConversation, now),
    reconcileKnownHumanDecisions: (ctx, serialize) =>
      reconcileKnownHumanDecisions(ctx, companyConfig, resolveConversation, serialize),
    reconcilePendingApprovals: (ctx, companyId, config) =>
      reconcilePendingApprovals(ctx, companyId, config, resolveConversation),
    reconcilePendingInteractions: (ctx, companyId, config) =>
      reconcilePendingInteractions(ctx, companyId, config, resolveConversation),
  };
}

export {
  createHumanDecisionDelivery,
  listOpenIssuesForInteractionPoll,
  reconcileHumanDecisions,
  reconcileKnownHumanDecisions,
  reconcilePendingApprovals,
  reconcilePendingInteractions,
  retryTerminalHumanDecisionPublication,
};
