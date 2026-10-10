const INTERACTION_ISSUE_STATUSES = ["todo", "in_progress", "in_review", "blocked"];
const INTERACTION_ISSUE_LIMIT_PER_STATUS = 12;
const MAX_TEXT_FIELD = 1200;
const MAX_CARD_CHARS = 3500;
const DEFAULT_WEB_BASE_URL = "https://paper.journeystudios.com.br";

const SENSITIVE_LINE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~-]{8,}\b/gi,
  /\bsk-[A-Za-z0-9_-]{10,}\b/gi,
  /\b(?:gh[oprsu]_[A-Za-z0-9_]{10,}|glpat-[A-Za-z0-9_-]{10,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/gi,
  // Match full dotenv/YAML/JSON assignments, including namespaced keys.
  /\b(?:[A-Za-z][A-Za-z0-9]*[_-])*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|SERVICE[_-]?ROLE[_-]?KEY|ACCESS[_-]?KEY|DATABASE[_-]?URL|DB[_-]?URL|COOKIE|SESSION[_-]?ID)\s*["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
  // The entire PEM block must be hidden, not just its BEGIN header.
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/gi,
];

const STATUS_LABELS = {
  pending: "Aguardando decisão",
  approved: "Aprovado",
  rejected: "Recusado",
  expired: "Expirado",
  cancelled: "Cancelado",
  done: "Concluído",
};

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

/**
 * Collapse arbitrary source text into one safe, human-readable line: secrets
 * redacted, Markdown structure flattened, whitespace normalized, length capped.
 * The published Telegram message must not depend on Markdown parsing.
 */
function humanText(value, maxLength = MAX_TEXT_FIELD) {
  const raw = stringValue(value);
  if (!raw) return null;
  let out = stripSensitiveText(raw);
  out = out.replace(/```[a-zA-Z0-9]*\n?/g, "");
  out = out.replace(/`/g, "");
  out = out.replace(/^\s*#{1,6}\s+/gm, "");
  out = out.replace(/^\s*[-*+]\s+/gm, "");
  out = out.replace(/\*\*/g, "");
  out = out.replace(/__/g, "");
  out = out.replace(/\r?\n/g, " ");
  out = out.replace(/\s+/g, " ").trim();
  if (!out) return null;
  return out.slice(0, maxLength);
}

function statusLabel(status) {
  const key = stringValue(status);
  if (!key) return "Estado desconhecido";
  return STATUS_LABELS[key] ?? key;
}

function redactPayloadForCard(kind, payload) {
  const body = asObject(payload);
  if (body.secretProposal) {
    const proposal = asObject(body.secretProposal);
    return {
      secretProposal: {
        label: humanText(proposal.label, 120) ?? "credencial",
        purpose: humanText(proposal.purpose, 200) ?? "credencial",
      },
    };
  }
  if (body.toolAction) {
    const action = asObject(body.toolAction);
    return {
      toolAction: {
        toolName: humanText(action.toolName, 120) ?? "ferramenta",
        summary: humanText(action.summary, 400) ?? "Execução de ferramenta",
      },
    };
  }
  if (body.connectionAuthorization || body.connectionIntent) {
    return { connection: "Autorização de conexão" };
  }
  const safe = {};
  for (const key of ["prompt", "detailsMarkdown", "title", "summary", "rejectReasonLabel"]) {
    const cleaned = sanitizeMarkdownField(body[key]);
    if (cleaned) safe[key] = cleaned;
  }
  return safe;
}

function companyPrefix(issue) {
  const identifier = stringValue(issue?.identifier);
  if (identifier && identifier.includes("-")) return identifier.split("-")[0];
  return null;
}

function normalizeWebBase(value) {
  const raw = stringValue(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Resolve the public Paperclip web base used for absolute decision links.
 * Config wins, then the host's own public URL env vars (the plugin worker
 * inherits the host environment), then the observed Journey Studios base.
 */
function resolveWebBaseUrl(configured) {
  const candidates = [
    configured,
    process.env?.PAPERCLIP_PUBLIC_URL,
    process.env?.PAPERCLIP_AUTH_PUBLIC_BASE_URL,
    process.env?.BETTER_AUTH_URL,
    process.env?.BETTER_AUTH_BASE_URL,
    process.env?.PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL,
    DEFAULT_WEB_BASE_URL,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeWebBase(candidate);
    if (normalized) return normalized;
  }
  return DEFAULT_WEB_BASE_URL;
}

function objectUrl(baseUrl, issuePrefix, path, fragment) {
  const base = normalizeWebBase(baseUrl);
  const prefix = stringValue(issuePrefix);
  const suffix = stringValue(path);
  if (!base || !prefix || !suffix) return null;
  try {
    const url = new URL(`${base}/${encodeURIComponent(prefix)}/${suffix}`);
    if (fragment) url.hash = fragment;
    return url.toString();
  } catch {
    return null;
  }
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

function sensitiveReasonText(interaction) {
  const payload = asObject(interaction.payload);
  const reasons = [];
  if (payload.secretProposal) reasons.push("envolve uma credencial");
  if (payload.toolAction) reasons.push("autoriza a execução de uma ferramenta");
  if (payload.connectionAuthorization || payload.connectionIntent) reasons.push("autoriza uma conexão externa");
  if (payload.target?.type === "issue_document") reasons.push("está vinculada a uma versão específica de documento");
  if (payload.rejectRequiresReason === true) reasons.push("uma recusa exige justificativa por escrito");
  if (interaction.effectiveResolverPolicy === "human_only") reasons.push("só o Founder pode resolver");
  return reasons;
}

function interactionRiskNotes(interaction) {
  const notes = [];
  const payload = asObject(interaction.payload);
  if (payload.secretProposal) notes.push("pode envolver segredo — responda apenas no Paperclip");
  if (payload.toolAction) notes.push("executa ferramenta e exige revisão no Paperclip");
  if (payload.target?.type === "issue_document") notes.push("vinculada a uma versão de documento que pode expirar");
  if (payload.rejectRequiresReason === true) notes.push("não há recusa em um toque no Telegram");
  if (interaction.effectiveResolverPolicy === "human_only") notes.push("botões nativos do Telegram estão desativados");
  if (notes.length === 0) notes.push("valide o objeto vinculado no Paperclip antes de agir");
  return notes;
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

/**
 * Build the human-readable, publishable approval card. The text is Portuguese,
 * carries no internal marker/UUID/hash/coverage/delivery metadata, and links to
 * the canonical absolute Paperclip route for the specific approval.
 */
function buildApprovalCardBody(approval, context = {}) {
  const { baseUrl, issuePrefix } = asObject(context);
  const payload = asObject(approval.payload);
  const title = humanText(payload.title, 180) ?? "Aprovação pendente";
  const summary = humanText(payload.summary, 700);
  const recommendation = humanText(payload.recommendedAction, 300);
  const risks = (Array.isArray(payload.risks) ? payload.risks : [])
    .slice(0, 6)
    .map((entry) => humanText(entry, 240))
    .filter(Boolean);
  const risksText = humanText(risks.join("; "), 600);

  const lines = [
    `Ação necessária · Aprovação — ${title}`,
    `Estado: ${statusLabel(approval.status)}`,
    "",
  ];
  if (summary && summary !== title) lines.push(`Pedido: ${summary}`);
  if (recommendation) lines.push(`Recomendação: ${recommendation}`);
  if (risksText) lines.push(`Risco/impacto: ${risksText}`);
  if (lines.at(-1) !== "") lines.push("");
  lines.push("Como responder: confirme ou recuse dentro do Paperclip. O Telegram é somente leitura.");

  const link = objectUrl(baseUrl, issuePrefix, `approvals/${encodeURIComponent(stringValue(approval.id) ?? "")}`);
  lines.push(link
    ? `Abrir: ${link}`
    : "Abra a página de aprovações no Paperclip para responder.");
  return lines.join("\n").slice(0, MAX_CARD_CHARS);
}

/**
 * Build the human-readable, publishable interaction card. Sensitive
 * interactions (secrets, tool actions, document targets, human-only) explain in
 * plain language why Paperclip confirmation is required, without exposing the
 * payload or fabricating an approval button.
 */
function buildInteractionCardBody(interaction, issue, context = {}) {
  const { baseUrl, issuePrefix } = asObject(context);
  const payload = asObject(interaction.payload);
  const sanitized = redactPayloadForCard(interaction.kind, payload);
  const restricted = Boolean(
    payload.secretProposal || payload.toolAction || payload.connectionAuthorization || payload.connectionIntent ||
    payload.target?.type === "issue_document" ||
    payload.rejectRequiresReason === true ||
    interaction.effectiveResolverPolicy === "human_only",
  );
  const ref = stringValue(issue?.identifier) ?? stringValue(issue?.id) ?? "tarefa";
  const heading = humanText(issue?.title ?? interaction.title, 180) ?? "Decisão pendente";

  const lines = [
    `Ação necessária · ${ref} — ${heading}`,
    `Estado: ${statusLabel(interaction.status)}`,
    "",
  ];

  if (restricted) {
    const reasons = sensitiveReasonText(interaction);
    const why = reasons.length ? ` (${reasons.join("; ")})` : "";
    lines.push(`Esta decisão é sensível${why} e precisa ser confirmada dentro do Paperclip — o Telegram não aprova nem exibe o segredo.`);
  } else {
    const prompt = humanText(sanitized.prompt ?? payload.prompt ?? interaction.title, 700);
    const details = humanText(sanitized.detailsMarkdown ?? payload.detailsMarkdown, 700);
    if (prompt) lines.push(`Pedido: ${prompt}`);
    if (details && details !== prompt) lines.push(`Motivo: ${details}`);
  }

  const risks = interactionRiskNotes(interaction);
  if (risks.length) lines.push(`Risco/impacto: ${risks.join("; ")}`);

  const hint = nativeTelegramButtonsLikely(interaction)
    ? "Como responder: abra o Paperclip para decidir; botões nativos podem aparecer no chat vinculado."
    : "Como responder: abra o Paperclip para responder. O Telegram não executa esta decisão.";
  lines.push("", hint);

  const link = objectUrl(baseUrl, issuePrefix, `issues/${encodeURIComponent(ref)}`, `interaction-${interaction.id}`);
  lines.push(link
    ? `Abrir: ${link}`
    : "Abra a tarefa no Paperclip para responder.");
  return lines.join("\n").slice(0, MAX_CARD_CHARS);
}

function cardDeliveryId(kind, id, fingerprint) {
  return `human-decision:${kind}:${id}:${fingerprint}`;
}

function cardEventType(kind) {
  return kind === "approval" ? "human_decision.approval" : "human_decision.interaction";
}

export {
  DEFAULT_WEB_BASE_URL,
  INTERACTION_ISSUE_LIMIT_PER_STATUS,
  INTERACTION_ISSUE_STATUSES,
  MAX_CARD_CHARS,
  approvalFingerprint,
  buildApprovalCardBody,
  buildInteractionCardBody,
  cardDeliveryId,
  cardEventType,
  companyPrefix,
  humanText,
  interactionFingerprint,
  isFounderReachableInteraction,
  normalizeWebBase,
  objectUrl,
  resolveWebBaseUrl,
  sanitizeMarkdownField,
  stripSensitiveText,
};
