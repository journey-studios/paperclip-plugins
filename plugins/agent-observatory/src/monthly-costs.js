/**
 * Cost accounting lives in Agent Observatory. The Gateway receives only a
 * read-only, formatted response; it never reads the ledger or provider keys.
 */
const AGENT_LIMIT = 500;
const ROW_LIMIT = 2000;
const PERIOD_PATTERN = /^([12][0-9]{3})-(0[1-9]|1[0-2])$/;

export function parseCostPeriod(input = "", now = new Date()) {
  const arg = String(input ?? "").trim();
  if (!arg) {
    const parts = new Intl.DateTimeFormat("en-US", {
      year: "numeric", month: "2-digit", timeZone: "America/Sao_Paulo",
    }).formatToParts(now);
    return `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}`;
  }
  if (!PERIOD_PATTERN.test(arg)) throw new Error("Use /custos ou /custos AAAA-MM");
  return arg;
}

function nextMonth(month) {
  const [year, part] = month.split("-").map(Number);
  const next = part === 12 ? { year: year + 1, month: 1 } : { year, month: part + 1 };
  return `${String(next.year).padStart(4, "0")}-${String(next.month).padStart(2, "0")}`;
}

function number(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) throw new Error(`Invalid ${field} data`);
  return parsed;
}

function markdownText(value, max = 64) {
  const compact = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const safe = compact.replace(/\b(?:https?:\/\/|www\.)\S+/gi, (url) => url.replace(/[:.]/g, "$&\u200b"));
  return safe.replace(/[\\`*_{}\[\]()#+.!>|~-]/g, "\\$&");
}

function apiName(row) {
  const raw = String(row.biller || row.provider || "Não identificado").trim();
  const normalized = raw.toLowerCase();
  if (normalized === "google" || normalized === "gemini" || normalized === "google-ai") return "Gemini (Google)";
  if (normalized === "deepseek") return "DeepSeek";
  if (normalized === "cursor") return "Cursor";
  if (normalized === "omniroute") return "OmniRoute";
  return raw;
}

function teamFor(agentId, agentById, ceoId) {
  const visited = new Set();
  let agent = agentById.get(agentId);
  if (!agent) return "Sem classificação";
  if (ceoId && agent.id === ceoId) return "Diretoria (CEO)";
  while (agent && !visited.has(agent.id)) {
    visited.add(agent.id);
    if (agent.reportsTo === ceoId && ceoId) {
      const name = String(agent.name ?? "").toLowerCase();
      if (name === "cmo") return "Marketing (CMO)";
      if (name === "cto") return "Tecnologia (CTO)";
      return String(agent.name || "Outra equipe").slice(0, 80);
    }
    if (!agent.reportsTo) return "Fora da hierarquia";
    agent = agentById.get(agent.reportsTo);
  }
  return "Sem classificação";
}

function displayMoney(cents) {
  return "US$ " + (cents / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function addToSummary(summary, name, costCents, events, unpriced) {
  const item = summary.get(name) ?? { name, cents: 0, reportedEvents: 0, unpricedEvents: 0 };
  item.cents += costCents;
  item.reportedEvents += events - unpriced;
  item.unpricedEvents += unpriced;
  summary.set(name, item);
}

function sorted(items) {
  return [...items.values()].sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));
}

export async function getMonthlyCosts(ctx, companyId, inputPeriod = "") {
  const period = parseCostPeriod(inputPeriod);
  const startDate = period + "-01";
  const endDate = nextMonth(period) + "-01";
  const query = ctx?.db?.query;
  if (typeof query !== "function" || !companyId) throw new Error("Observatory cost database unavailable");

  // One bounded ledger query feeds total, provider and group breakdowns. They
  // reconcile by construction, even if another event arrives during the read.
  const [agentRows, costRows] = await Promise.all([
    ctx.db.query(`SELECT a.id, a.name, a.reports_to AS "reportsTo"
      FROM public.agents a WHERE a.company_id = $1 ORDER BY a.id LIMIT 501`, [companyId]),
    ctx.db.query(`SELECT c.agent_id AS "agentId", c.provider, c.biller,
      c.billing_type AS "billingType", c.cost_status AS "costStatus",
      COUNT(*)::int AS events, COALESCE(SUM(c.cost_cents), 0)::bigint AS "costCents"
      FROM public.cost_events c
      WHERE c.company_id = $1
        AND c.occurred_at >= ($2::date AT TIME ZONE 'America/Sao_Paulo')
        AND c.occurred_at < ($3::date AT TIME ZONE 'America/Sao_Paulo')
      GROUP BY c.agent_id, c.provider, c.biller, c.billing_type, c.cost_status
      ORDER BY c.provider, c.biller, c.agent_id, c.billing_type, c.cost_status LIMIT 2001`,
      [companyId, startDate, endDate]),
  ]);
  if (agentRows.length > AGENT_LIMIT || costRows.length > ROW_LIMIT) {
    throw new Error("Monthly cost data exceeds the safe report limit");
  }

  const agentById = new Map(agentRows.map((agent) => [agent.id, agent]));
  const ceo = agentRows.find((agent) => String(agent.name).toLowerCase() === "ceo" && !agent.reportsTo);
  const perApi = new Map();
  const perTeam = new Map();
  let cents = 0;
  let reportedEvents = 0;
  let unpricedEvents = 0;

  for (const row of costRows) {
    const count = number(row.events, "event count");
    const reported = row.costStatus === "reported";
    const known = reported ? number(row.costCents, "reported cost") : 0;
    const unknown = reported ? 0 : count;
    cents += known;
    reportedEvents += reported ? count : 0;
    unpricedEvents += unknown;
    addToSummary(perApi, apiName(row), known, count, unknown);
    addToSummary(perTeam, teamFor(row.agentId, agentById, ceo?.id), known, count, unknown);
  }

  if (!Number.isSafeInteger(cents)) throw new Error("Monthly cost exceeds safe precision");
  return {
    period, currency: "USD", source: "Paperclip cost_events",
    reportedCostCents: cents, reportedEvents, unpricedEvents,
    byApi: sorted(perApi), byGroup: sorted(perTeam),
    coverage: "reported_only",
  };
}

function itemLine(item) {
  if (!item.reportedEvents && item.unpricedEvents)
    return `• **${markdownText(item.name)}:** sem preço (${item.unpricedEvents} eventos)`;
  const unpriced = item.unpricedEvents ? ` · ${item.unpricedEvents} sem preço` : "";
  return `• **${markdownText(item.name)}:** ${markdownText(displayMoney(item.cents))}${unpriced}`;
}

export function formatMonthlyCosts(data) {
  const header = [
    `**Custos dos agentes · ${markdownText(data.period)}**`,
    "",
    `**Total reportado:** ${markdownText(displayMoney(data.reportedCostCents))}`,
  ];
  const footer = [
    "",
    `_Cobertura: ${data.reportedEvents} eventos com custo reportado; ${data.unpricedEvents} sem preço\._`,
    "_Valores do ledger Paperclip em USD, não saldos de créditos nem faturas dos provedores. Uso sem telemetria não está incluído._",
  ];
  const max = 3450 - footer.join("\n").length;
  let body = header.join("\n");
  for (const [heading, items] of [["**Por API / provedor**", data.byApi], ["**Por equipe**", data.byGroup]]) {
    body += "\n\n" + heading;
    let included = 0;
    for (const item of items) {
      const line = itemLine(item);
      if (body.length + line.length + 2 > max - 75) break;
      body += "\n" + line;
      included++;
    }
    if (included < items.length) body += `\n_${included} de ${items.length} categorias exibidas\._`;
    if (items.length === 0) body += "\n_Nenhum evento registrado._";
  }
  return body + "\n" + footer.join("\n");
}

/** Invalid arguments are user errors, not database or provider failures. */
export async function renderTelegramMonthlyCosts(ctx, companyId, args = "") {
  let month;
  try {
    month = parseCostPeriod(args);
  } catch {
    return "Uso: `/custos` para o mês atual ou `/custos AAAA-MM` (ex.: `/custos 2026-09`).";
  }
  return formatMonthlyCosts(await getMonthlyCosts(ctx, companyId, month));
}
