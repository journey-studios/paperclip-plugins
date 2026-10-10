import { getOverview } from "./service.js";

const MAX_TEXT = 3400;
const MAX_ROWS = 8;

function safe(value, limit = 125) {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  const compact = raw.length > limit ? raw.slice(0, limit - 1).trimEnd() + "…" : raw;
  const noLinks = compact.replace(/\b(?:https?:\/\/|www\.)\S+/gi,
    (url) => url.replace(/[:.]/g, "$&\u200b"));
  return noLinks.replace(/[\\*_{}\[\]()#+.!>|~-]/g, "\\$&")
    .replaceAll(String.fromCharCode(96), "\\" + String.fromCharCode(96));
}

function wholeRecords(title, rows, footer) {
  let text = "**" + title + "**";
  let displayed = 0;
  for (const row of rows) {
    if (displayed >= MAX_ROWS || text.length + row.length + footer.length + 90 >= MAX_TEXT) break;
    text += "\n\n" + row;
    displayed++;
  }
  if (displayed < rows.length) text += "\n\n_Exibindo " + displayed + " de " + rows.length + " registros._";
  if (text.length + footer.length <= MAX_TEXT) text += footer;
  return text;
}

/**
 * Bounded company-scoped snapshot from Observatory's existing run ledger.
 * Never infer a running state from the agent record alone.
 */
export async function getLiveRuns(ctx, companyId) {
  const query = ctx?.db?.query;
  if (typeof query !== "function") throw new Error("Observatory run ledger unavailable");
  const params = [companyId];
  const [rows, counts] = await Promise.all([
    query.call(ctx.db, "SELECT r.id, r.status, r.started_at AS \"startedAt\", " +
      "r.last_useful_action_at AS \"lastUsefulActionAt\", a.name AS \"agentName\", " +
      "COALESCE(r.native_issue_id::text, r.context_snapshot ->> 'issueId') AS \"issueId\" " +
      "FROM public.heartbeat_runs r JOIN public.agents a ON a.id = r.agent_id " +
      "AND a.company_id = r.company_id WHERE r.company_id = $1 " +
      "AND r.finished_at IS NULL AND r.status IN ('running','in_progress','active') " +
      "ORDER BY r.started_at DESC NULLS LAST, r.id DESC LIMIT 9", params),
    query.call(ctx.db, "SELECT COUNT(*)::int AS count FROM public.heartbeat_runs r " +
      "WHERE r.company_id = $1 AND r.finished_at IS NULL " +
      "AND r.status IN ('running','in_progress','active')", params),
  ]);
  return {
    rows: (Array.isArray(rows) ? rows : []).slice(0, 9),
    total: Number(counts?.[0]?.count ?? 0),
    generatedAt: new Date().toISOString(),
  };
}

export function formatLiveRuns(snapshot) {
  const now = Date.parse(snapshot.generatedAt);
  const rows = snapshot.rows.map((run) => {
    const start = Date.parse(run.startedAt);
    const duration = Number.isFinite(start) && Number.isFinite(now) ?
      Math.max(0, Math.floor((now - start) / 60000)) + " min" : "duração indisponível";
    return "• **" + safe(run.agentName ?? "Agente", 90) + "** · " + duration +
      "\n  Execução: " + safe(run.id, 45) +
      (run.issueId ? "\n  Tarefa: " + safe(run.issueId, 45) : "");
  });
  if (!rows.length) rows.push("_Nenhuma execução ativa encontrada._");
  const footer = "\n\n_Execuções ativas no banco: " + snapshot.total +
    ". Dados da execução; não é uma sondagem de processos do sistema._";
  return wholeRecords("Execuções ativas", rows, footer);
}

export function formatAgentHealth(overview) {
  const summary = overview.summary || {};
  const coverage = overview.coverage || {};
  const agents = Array.isArray(overview.agents) ? overview.agents : [];
  const degraded = agents.filter((agent) => agent.health === "degraded");
  const rows = [
    "**Últimas " + Number(overview.windowHours ?? 24) + "h**",
    "Agentes cadastrados: **" + Number(summary.agentsTotal ?? 0) + "**",
    "Execuções: **" + Number(summary.runsTotal ?? 0) + "**",
    "Falhas: **" + Number(summary.failures ?? 0) + "**",
    "Interrupções: **" + Number(summary.interrupted ?? 0) + "**",
    "Retries: **" + Number(summary.retries ?? 0) + "**",
    "Execuções sem custo reportado: **" + Number(summary.unknownCostRuns ?? 0) + "**",
  ];
  if (degraded.length) {
    rows.push("", "**Agentes com degradação observada**");
    rows.push(...degraded.slice(0, MAX_ROWS).map((agent) => "• " +
      safe(agent.name, 80) + ": " + Number(agent.failures ?? 0) + " falhas"));
  }
  if (coverage.hasMoreAgents || agents.length < Number(summary.agentsTotal ?? 0)) {
    rows.push("", "_Amostra parcial de agentes; confira o Observatory para a lista completa._");
  }
  rows.push("", "_Indicadores do Paperclip, não incluem saúde de VPS, rede ou Telegram._");
  const output = "**Saúde operacional dos agentes**\n\n" + rows.join("\n");
  return output.slice(0, MAX_TEXT);
}

export async function renderTelegramRuns(ctx, companyId, args = "") {
  if (args.trim()) return "**Uso:** /runs";
  return formatLiveRuns(await getLiveRuns(ctx, companyId));
}

export async function renderTelegramHealth(ctx, companyId, args = "") {
  if (args.trim()) return "**Uso:** /health";
  return formatAgentHealth(await getOverview(ctx, companyId, 24));
}
