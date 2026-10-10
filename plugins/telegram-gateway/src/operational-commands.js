/**
 * Founder-only, company-scoped operational reads. Never performs a wake or a
 * decision, and never treats a bounded page as an exhaustive company total.
 */
const PAGE_SIZE = 100;
const ISSUE_LOOKUP_PAGE_LIMIT = 5;
const RESPONSE_LIMIT = 3500;
const ROW_LIMIT = 10;
const ISSUE_IDENTIFIER = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STATUSES = {
  backlog: "Backlog", todo: "A fazer", in_progress: "Em andamento",
  in_review: "Em revisão", blocked: "Bloqueada",
  done: "Concluída", cancelled: "Cancelada",
};

function short(value, limit = 140) {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  return clean.length > limit ? clean.slice(0, limit - 1).trimEnd() + "…" : clean;
}

function safe(value, limit = 140) {
  const text = short(value, limit).replace(/\b(?:https?:\/\/|www\.)\S+/gi,
    (url) => url.replace(/[:.]/g, "$&\u200b"));
  return text.replace(/[\\*_{}\[\]()#+.!>|~-]/g, "\\$&")
    .replaceAll(String.fromCharCode(96), "\\" + String.fromCharCode(96));
}

function label(status) {
  return STATUSES[status] ?? short(status || "Desconhecido", 40);
}

function line(issue, showReason = false) {
  const identifier = safe(issue.identifier ?? issue.id ?? "Sem ID", 36);
  const title = safe(issue.title ?? "Sem título", 170);
  let result = "• **" + identifier + "** · " + title;
  if (showReason) {
    const blockerCount = Array.isArray(issue.blockedByIssueIds) ? issue.blockedByIssueIds.length : 0;
    const reason = short(issue.unblockDescriptor?.action ?? issue.blockedReason ?? "", 150);
    result += "\n  " + (reason ? "Motivo: " + safe(reason, 150) :
      blockerCount ? "Dependências: " + blockerCount : "Motivo não informado");
  }
  return result;
}

function formatSections(title, sections, footer = "") {
  let output = "**" + title + "**";
  for (const section of sections) {
    if (!section) continue;
    const next = output + "\n\n" + section;
    if (next.length + footer.length > RESPONSE_LIMIT) break;
    output = next;
  }
  if (footer && output.length + footer.length <= RESPONSE_LIMIT) output += footer;
  return output;
}

function requireCompany(items, companyId) {
  return (Array.isArray(items) ? items : []).filter((item) =>
    item && item.companyId === companyId);
}

async function statusPage(ctx, companyId, status) {
  const rows = requireCompany(await ctx.issues.list({
    companyId, status, limit: PAGE_SIZE, offset: 0, includePluginOperations: false,
  }), companyId);
  return { rows, possiblyMore: rows.length >= PAGE_SIZE };
}

const quantity = (page) => page.rows.length + (page.possiblyMore ? "+" : "");

function approvalLine(approval) {
  return "• " + safe(approval.type ?? "Aprovação", 55) +
    (approval.id ? " · ID " + safe(approval.id, 45) : "");
}

async function pendingApprovals(ctx, companyId) {
  return requireCompany(await ctx.approvals.list({ companyId, status: "pending" }), companyId)
    .filter((approval) => approval.status === "pending");
}

export async function renderToday(ctx, companyId) {
  const [progress, review, blocked, approvals] = await Promise.all([
    statusPage(ctx, companyId, "in_progress"),
    statusPage(ctx, companyId, "in_review"),
    statusPage(ctx, companyId, "blocked"),
    pendingApprovals(ctx, companyId),
  ]);
  const important = blocked.rows.slice(0, 3).map((issue) => line(issue)).join("\n");
  return formatSections("Journey Studios · Resumo operacional", [
    "Em andamento: **" + quantity(progress) + "**\nEm revisão: **" +
      quantity(review) + "**\nBloqueadas: **" + quantity(blocked) +
      "**\nAprovações pendentes: **" + approvals.length + "**",
    important ? "**Bloqueios em destaque**\n" + important : "",
  ], "\n\n_Contagens por estado usam até 100 tarefas; + indica mais resultados. " +
     "Atividade de agentes: /runs · Saúde: /health._");
}

export async function renderInbox(ctx, companyId, founderUserId) {
  const [approvals, review, blocked] = await Promise.all([
    pendingApprovals(ctx, companyId),
    statusPage(ctx, companyId, "in_review"),
    statusPage(ctx, companyId, "blocked"),
  ]);
  const assigned = [...review.rows, ...blocked.rows]
    .filter((issue) => issue.assigneeUserId === founderUserId ||
      issue.responsibleUserId === founderUserId)
    .filter((issue, idx, items) => items.findIndex((candidate) => candidate.id === issue.id) === idx);
  const sections = [];
  if (approvals.length) sections.push("**Aprovações pendentes**\n" +
    approvals.slice(0, ROW_LIMIT).map(approvalLine).join("\n"));
  if (assigned.length) sections.push("**Tarefas atribuídas a você**\n" +
    assigned.slice(0, ROW_LIMIT).map(line).join("\n"));
  if (!sections.length) sections.push("_Nenhuma aprovação ou tarefa atribuída encontrada nesta consulta._");
  return formatSections("Sua atenção", sections, "\n\n_Tarefas consultadas: até 100 por estado. " +
    "Aprovações são pendências da empresa; não significam necessariamente atribuição pessoal._");
}

export async function renderBlocked(ctx, companyId) {
  const page = await statusPage(ctx, companyId, "blocked");
  const lines = page.rows.slice(0, ROW_LIMIT).map((issue) => line(issue, true));
  const sections = lines.length ? lines : ["_Nenhuma tarefa bloqueada encontrada._"];
  const footer = "\n\n_Exibindo " + Math.min(ROW_LIMIT, page.rows.length) + " de " +
    quantity(page) + " tarefas consultadas._";
  return formatSections("Tarefas bloqueadas", sections, footer);
}

async function locateIssue(ctx, companyId, reference) {
  if (UUID.test(reference)) return ctx.issues.get(reference, companyId);
  for (let page = 0; page < ISSUE_LOOKUP_PAGE_LIMIT; page++) {
    const issues = requireCompany(await ctx.issues.list({
      companyId, limit: PAGE_SIZE, offset: page * PAGE_SIZE,
      includePluginOperations: false,
    }), companyId);
    const match = issues.find((issue) =>
      String(issue.identifier ?? "").toUpperCase() === reference);
    if (match) return match;
    if (issues.length < PAGE_SIZE) return null;
  }
  return undefined; // scan limit, not a verified absence
}

export async function renderIssue(ctx, companyId, rawReference) {
  const reference = short(rawReference, 60).toUpperCase();
  if (!ISSUE_IDENTIFIER.test(reference) && !UUID.test(reference)) {
    return "**Uso:** /issue JOU-38\n_Informe o identificador da tarefa ou um UUID._";
  }
  const issue = await locateIssue(ctx, companyId, reference);
  if (issue === undefined) {
    return "_A tarefa não está nas primeiras 500 tarefas consultadas. " +
      "Abra o Paperclip para uma busca completa._";
  }
  if (!issue || issue.companyId !== companyId) return "_Tarefa não encontrada nesta empresa._";
  const rows = [
    "**" + safe(issue.identifier ?? issue.id, 48) + "**",
    safe(issue.title ?? "Sem título", 230),
    "",
    "**Estado:** " + safe(label(issue.status), 40),
    "**Prioridade:** " + safe(issue.priority ?? "Não informada", 30),
    "**Responsável:** " + safe(issue.assigneeAgentId ?? issue.assigneeUserId ?? "Não atribuído", 60),
  ];
  const blockerIds = Array.isArray(issue.blockedByIssueIds) ? issue.blockedByIssueIds : [];
  if (blockerIds.length) rows.push("**Dependências:** " + blockerIds.length);
  if (issue.unblockDescriptor?.action) rows.push("**Próxima ação:** " + safe(issue.unblockDescriptor.action, 200));
  if (issue.description) rows.push("", "**Descrição (trecho)**", safe(issue.description, 420));
  return rows.join("\n").slice(0, RESPONSE_LIMIT);
}
