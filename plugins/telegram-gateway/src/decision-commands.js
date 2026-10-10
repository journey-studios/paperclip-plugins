import { isFounderReachableInteraction } from "./human-decisions.js";
import {
  allowDirectApproval,
  allowDirectInteraction,
  approvalActionRef,
  interactionActionRef,
  parseDecisionReference,
} from "./decision-references.js";

const MAX_INPUT = 60;
// Keep the same 60-character bound as the Paperclip Telegram ingress.
const PAGE_SIZE = 250;
const MAX_SCAN_ITEMS = 2000;

function parseResponse(action, args) {
  if (typeof args !== "string" || args.length > MAX_INPUT) return null;
  const trimmed = args.trim();
  const separator = trimmed.search(/\s/);
  const reference = separator < 0 ? trimmed : trimmed.slice(0, separator);
  const remainder = separator < 0 ? "" : trimmed.slice(separator).trim();
  const parsed = parseDecisionReference(reference);
  if (!parsed) return null;
  if (action === "approve") {
    // Explicit second word prevents accidental use of a copied reference.
    if (remainder.toUpperCase() !== "CONFIRMO") return null;
    return { ...parsed, action, reason: null };
  }
  if (!remainder || remainder.length < 4 || remainder.length > 40) return null;
  return { ...parsed, action, reason: remainder };
}

function guidance(action) {
  return action === "approve"
    ? "Formato: /aprovar CODIGO CONFIRMO. Use somente o código mostrado no card atual."
    : "Formato: /rejeitar CODIGO motivo. Motivo obrigatório (4–40 caracteres); para justificativas longas use o Paperclip.";
}

function notFoundText() {
  return "Esta decisão não está mais pendente, mudou desde o card ou não foi encontrada. Abra o link da mensagem para ver o estado atual no Paperclip.";
}

async function resolveApproval(ctx, companyId, reference) {
  const all = await ctx.approvals.list({ companyId, status: "pending" });
  const matches = (Array.isArray(all) ? all : []).filter((item) =>
    item.companyId === companyId && allowDirectApproval(item) && approvalActionRef(item) === reference);
  return matches.length === 1 ? { approval: matches[0] } : null;
}

async function resolveInteraction(ctx, companyId, reference, issueRef, founderUserId) {
  // Avoid a company-wide interaction scan for each command. Lookup is bounded,
  // after which a unique pending interaction is verified against its current
  // fingerprint and resolver policy by Paperclip at application time.
  let issue = null;
  for (let offset = 0; offset < MAX_SCAN_ITEMS; offset += PAGE_SIZE) {
    const page = await ctx.issues.list({
      companyId,
      limit: PAGE_SIZE,
      offset,
      includePluginOperations: false,
    });
    const rows = Array.isArray(page) ? page : [];
    issue = rows.find((item) => item.companyId === companyId && item.identifier === issueRef) ?? null;
    if (issue || rows.length < PAGE_SIZE) break;
  }
  if (!issue) return null;
  const list = await ctx.issues.listInteractions(issue.id, companyId);
  const matches = (Array.isArray(list) ? list : []).filter((item) =>
    isFounderReachableInteraction(item, founderUserId) && allowDirectInteraction(item) && interactionActionRef(item, issue) === reference);
  return matches.length === 1 ? { issue, interaction: matches[0] } : null;
}

/**
 * Called only after the host-attested Telegram actor passed the Gateway's
 * same-company, linked-Founder checks. The plugin never receives Telegram
 * credentials and never accepts an actorUserId from command parameters.
 * Host SDK write operations independently re-validate active human membership.
 */
export async function executeDecisionCommand(ctx, companyId, actorUserId, action, args, config) {
  if (config?.decisionCommandsEnabled !== true) {
    return "Decisões por comando estão desativadas. Use o link do Paperclip.";
  }
  if (typeof actorUserId !== "string" || actorUserId !== config.founderUserId) {
    return "Este comando exige a identidade do Founder vinculada ao Telegram.";
  }
  const request = parseResponse(action, args);
  if (!request) return guidance(action);

  try {
    if (request.kind === "approval") {
      const current = await resolveApproval(ctx, companyId, request.ref);
      if (!current) return notFoundText();
      const result = await ctx.approvals.decide(
        current.approval.id,
        {
          action: request.action === "approve" ? "approve" : "reject",
          actorUserId,
          decisionNote: request.reason,
        },
        companyId,
      );
      return result.applied
        ? (request.action === "approve" ? "Aprovação registrada no Paperclip." : "Rejeição registrada com justificativa no Paperclip.")
        : "Esta aprovação já havia sido resolvida. Consulte o Paperclip.";
    }

    const current = await resolveInteraction(ctx, companyId, request.ref, request.issueRef, actorUserId);
    if (!current) return notFoundText();
    // The host applies the current governance, creator, document revision and
    // concurrency checks; this isn't a second authority or state machine.
    const result = await ctx.issues.respondInteraction(
      current.issue.id,
      current.interaction.id,
      {
        action: request.action === "approve" ? "accept" : "reject",
        actorUserId,
        reason: request.reason,
      },
      companyId,
    );
    return result.applied
      ? (request.action === "approve" ? "Confirmação registrada no Paperclip." : "Recusa registrada com justificativa no Paperclip.")
      : "Esta interação já havia sido resolvida. Consulte o Paperclip.";
  } catch {
    // Don't disclose internal provider errors, credentials or unexpected host
    // response data to a user-controlled Telegram message.
    return "Não foi possível confirmar o resultado. Confira o estado no Paperclip antes de tentar novamente.";
  }
}
