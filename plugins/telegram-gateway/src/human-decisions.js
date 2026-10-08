const CARD_MARKER = "[FOUNDER_HUMAN_DECISION_CARD]";
const INTERACTION_ISSUE_STATUSES = ["todo", "in_progress", "in_review", "blocked"];
const INTERACTION_ISSUE_LIMIT_PER_STATUS = 12;
const MAX_TEXT_FIELD = 1200;

const SENSITIVE_LINE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
  /\bsk-[A-Za-z0-9]{10,}\b/g,
  /\bghp_[A-Za-z0-9]{10,}\b/g,
  /\b(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
  /-----BEGIN [A-Z ]+-----/g,
];

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stripSensitiveText(text) {
  if (!text) return "";
  let out = String(text);
  for (const pattern of SENSITIVE_LINE_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out.slice(0, MAX_TEXT_FIELD);
}

function sanitizeMarkdownField(value) {
  const raw = stringValue(value);
  if (!raw) return null;
  return stripSensitiveText(raw.replace(/\r\n/g, "\n"));
}

function redactPayloadForCard(kind, payload) {
  const body = asObject(payload);
  if (body.secretProposal) {
    const proposal = asObject(body.secretProposal);
    return {
      secretProposal: {
        label: stringValue(proposal.label) ?? "Secret proposal",
        purpose: stringValue(proposal.purpose) ?? "credential",
        value: "[redacted — open in Paperclip]",
      },
    };
  }
  if (body.toolAction) {
    const action = asObject(body.toolAction);
    return {
      toolAction: {
        toolName: stringValue(action.toolName) ?? "tool",
        summary: sanitizeMarkdownField(action.summary) ?? "Tool approval",
        arguments: "[redacted — open in Paperclip]",
      },
    };
  }
  if (body.connectionAuthorization || body.connectionIntent) {
    return { connection: "Connection authorization — details in Paperclip only" };
  }
  const safe = {};
  for (const key of ["prompt", "detailsMarkdown", "title", "summary", "rejectReasonLabel"]) {
    const cleaned = sanitizeMarkdownField(body[key]);
    if (cleaned) safe[key] = cleaned;
  }
  if (body.target?.type === "issue_document") {
    safe.target = { type: "issue_document", note: "Bound to issue document revision" };
  }
  return safe;
}

function companyPrefix(issue) {
  const identifier = stringValue(issue?.identifier);
  if (identifier && identifier.includes("-")) return identifier.split("-")[0];
  return "COMPANY";
}

function canonicalIssueLink(issue) {
  const prefix = companyPrefix(issue);
  const ref = stringValue(issue?.identifier) ?? stringValue(issue?.id) ?? "unknown";
  return `/${prefix}/issues/${ref}`;
}

function canonicalInteractionLink(issue, interactionId) {
  const prefix = companyPrefix(issue);
  const ref = stringValue(issue?.identifier) ?? stringValue(issue?.id) ?? "unknown";
  return `/${prefix}/issues/${ref}#interaction-${interactionId}`;
}

function canonicalApprovalLink(approval, issueHint) {
  const prefix = issueHint ? companyPrefix(issueHint) : "COMPANY";
  return `/${prefix}/approvals/${approval.id}`;
}

function nativeTelegramButtonsLikely(interaction) {
  const payload = asObject(interaction.payload);
  if (interaction.kind !== "request_confirmation") return false;
  if (payload.rejectRequiresReason === true) return false;
  if (payload.target?.type === "issue_document") return false;
  if (payload.secretProposal || payload.toolAction || payload.connectionAuthorization) return false;
  if (interaction.effectiveResolverPolicy === "human_only") return false;
  return true;
}

function interactionRisks(interaction) {
  const risks = [];
  const payload = asObject(interaction.payload);
  if (payload.secretProposal) risks.push("May involve credentials or secrets — respond only in Paperclip.");
  if (payload.toolAction) risks.push("Tool execution requires board review in Paperclip.");
  if (payload.target?.type === "issue_document") risks.push("Target is bound to a document revision; stale targets expire.");
  if (payload.rejectRequiresReason === true) risks.push("Rejection requires a written reason (no one-tap decline in Telegram).");
  if (interaction.effectiveResolverPolicy === "human_only") risks.push("Human-only resolver policy — native Telegram quick actions are disabled.");
  if (risks.length === 0) risks.push("Validate the linked Paperclip object before acting.");
  return risks;
}

function isFounderReachableInteraction(interaction, founderUserId) {
  if (!interaction || interaction.status !== "pending") return false;
  if (stringValue(interaction.addresseeAgentId)) return false;
  const addresseeUserId = stringValue(interaction.addresseeUserId);
  if (addresseeUserId && addresseeUserId !== founderUserId) return false;
  const policy = stringValue(interaction.effectiveResolverPolicy) ?? "anyone";
  if (addresseeUserId === founderUserId) return true;
  if (policy === "human_only") return true;
  if (policy === "anyone" || policy === "not_creator") return true;
  return false;
}

function approvalFingerprint(approval) {
  return `${approval.status}:${approval.updatedAt ?? approval.createdAt ?? ""}:${approval.type ?? ""}`;
}

function interactionFingerprint(interaction) {
  return `${interaction.status}:${interaction.updatedAt ?? interaction.createdAt ?? ""}:${interaction.kind ?? ""}`;
}

function buildApprovalCardBody(approval, issueHint, companyId) {
  const payload = asObject(approval.payload);
  const summary = sanitizeMarkdownField(payload.summary) ?? sanitizeMarkdownField(payload.title) ?? "Approval pending";
  const recommendation = sanitizeMarkdownField(payload.recommendedAction);
  const risksRaw = Array.isArray(payload.risks) ? payload.risks : [];
  const risks = risksRaw.map((entry) => stripSensitiveText(String(entry))).filter(Boolean);
  if (risks.length === 0) risks.push("Validate linked issues and payload in Paperclip before deciding.");

  const lines = [
    CARD_MARKER,
    `kind=approval`,
    `companyId=${companyId}`,
    `approvalId=${approval.id}`,
    `status=${approval.status}`,
    `fingerprint=${approvalFingerprint(approval)}`,
    "",
    "## Human decision (read-only)",
    "",
    `- **ID:** ${approval.id}`,
    `- **Type:** ${approval.type ?? "approval"}`,
    `- **State:** ${approval.status}`,
    `- **Link:** ${canonicalApprovalLink(approval, issueHint)}`,
    "",
    "### Summary",
    summary,
  ];
  if (recommendation) {
    lines.push("", "### Recommendation", recommendation);
  }
  lines.push("", "### Risks", ...risks.map((line) => `- ${line}`));
  lines.push(
    "",
    "### Coverage note",
    "- Standalone `decisions` and board-only `attention` APIs are not available to plugins; this card uses `approvals.read` only.",
    "",
    "Open the canonical link in Paperclip to approve or reject. This is a sanitized read card — not an authorization to act from Telegram.",
  );
  return lines.join("\n");
}

function buildInteractionCardBody(interaction, issue, companyId) {
  const payload = asObject(interaction.payload);
  const sanitizedPayload = redactPayloadForCard(interaction.kind, payload);
  const prompt = sanitizeMarkdownField(sanitizedPayload.prompt ?? (payload.secretProposal ? null : payload.prompt) ?? interaction.title);
  const details = sanitizeMarkdownField(sanitizedPayload.detailsMarkdown ?? (payload.secretProposal ? null : payload.detailsMarkdown));
  const risks = interactionRisks(interaction);
  const telegramHint = nativeTelegramButtonsLikely(interaction)
    ? "Native Telegram confirmation buttons may be available when this interaction is linked to the founder chat."
    : "Native Telegram one-tap buttons are not available for this card — use the Paperclip link.";

  const lines = [
    CARD_MARKER,
    `kind=interaction`,
    `companyId=${companyId}`,
    `interactionId=${interaction.id}`,
    `issueId=${issue.id}`,
    `status=${interaction.status}`,
    `fingerprint=${interactionFingerprint(interaction)}`,
    "",
    "## Human decision (read-only)",
    "",
    `- **ID:** ${interaction.id}`,
    `- **Issue:** ${issue.identifier ?? issue.id}`,
    `- **Type:** ${interaction.kind}`,
    `- **State:** ${interaction.status}`,
    `- **Resolver:** ${interaction.effectiveResolverPolicy ?? "anyone"}`,
    `- **Link:** ${canonicalInteractionLink(issue, interaction.id)}`,
    "",
    "### Prompt",
    prompt ?? "(no prompt)",
  ];
  if (details) {
    lines.push("", "### Details", details);
  }
  if (sanitizedPayload.secretProposal) {
    const proposal = asObject(sanitizedPayload.secretProposal);
    lines.push(
      "",
      "### Credential proposal",
      `- **Label:** ${proposal.label ?? "secret"}`,
      `- **Value:** ${proposal.value ?? "[redacted — open in Paperclip]"}`,
    );
  }
  lines.push("", "### Risks", ...risks.map((line) => `- ${line}`));
  lines.push("", "### Telegram", `- ${telegramHint}`);
  lines.push(
    "",
    "### Coverage note",
    "- No `issue.thread_interaction.*` plugin events exist; this item was discovered via polling `issues.list` + `issues.listInteractions`.",
    "- Plugin `decisions` SDK is unavailable; board-only attention feed is not polled.",
    "",
    "Open the canonical link in Paperclip to respond. This is a sanitized read card — never paste secrets into chat.",
  );
  return lines.join("\n");
}

function cardDeliveryId(kind, id, fingerprint) {
  return `human-decision:${kind}:${id}:${fingerprint}`;
}

function cardEventType(kind) {
  return kind === "approval" ? "human_decision.approval" : "human_decision.interaction";
}

export {
  CARD_MARKER,
  INTERACTION_ISSUE_LIMIT_PER_STATUS,
  INTERACTION_ISSUE_STATUSES,
  approvalFingerprint,
  buildApprovalCardBody,
  buildInteractionCardBody,
  cardDeliveryId,
  cardEventType,
  interactionFingerprint,
  isFounderReachableInteraction,
  sanitizeMarkdownField,
  stripSensitiveText,
};
