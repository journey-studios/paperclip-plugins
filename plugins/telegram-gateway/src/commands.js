import { companyConfig } from "./core.js";
import { NATIVE_TELEGRAM_COMMANDS } from "./command-catalog.js";

const DEFAULT_LIMIT = 10;
const MAX_TEXT = 3600;
const TITLE_LIMIT = 210;
const TASK_STATUS_LABELS = {
  backlog: "Backlog",
  todo: "A fazer",
  in_progress: "Em andamento",
  in_review: "Em revisão",
  blocked: "Bloqueada",
  done: "Concluída",
  cancelled: "Cancelada",
};

const AGENT_STATUS_LABELS = {
  idle: "Ocioso",
  running: "Em execução",
  active: "Ativo",
  paused: "Pausado",
  error: "Com erro",
  offline: "Desconectado",
  unknown: "Desconhecido",
};

function compact(value, max = 90) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > max
    ? normalized.slice(0, max - 1).trimEnd() + "…"
    : normalized;
}

function statusLabel(value, labels) {
  const key = String(value ?? "unknown").toLowerCase().trim();
  return labels[key] ?? compact(value ?? "Desconhecido", 35);
}

/**
 * Escape user-controlled text before interpolating it into CommonMark.
 * Paperclip's existing native Telegram publisher converts this Markdown to
 * Telegram MarkdownV2 and safely escapes punctuation again for that format.
 */
function markdownContent(value, max = 90) {
  // Linkifiers may turn bare URLs into Markdown links even when punctuation
  // is escaped. Break URL patterns before rendering untrusted task/agent text.
  const safe = compact(value, max).replace(/\b(?:https?:\/\/|www\.)\S+/gi,
    (url) => url.replace(/[:.]/g, "$&\u200b"));
  return safe.replace(/[\\`*_{}\[\]()#+.!>|~-]/g, "\\$&");
}

function displayList(heading, rows, emptyText) {
  const header = `**${heading}**`;
  if (rows.length === 0) return `${header}\n\n_${emptyText}_`;
  // Append *whole records* only: slicing a Markdown reply mid-token can make
  // Telegram reject its format, or produce a partially formatted message.
  let output = header;
  let included = 0;
  for (const row of rows) {
    if (output.length + row.length + 2 > MAX_TEXT - 58) break;
    output += `\n\n${row}`;
    included++;
  }
  if (included < rows.length) {
    output += `\n\n_Exibindo ${included} de ${rows.length} registros._`;
  }
  return output;
}

function displayAgents(agents) {
  const rows = agents.slice(0, DEFAULT_LIMIT).map((agent) =>
    "• **" + markdownContent(agent.name ?? agent.id ?? "Agente sem nome", 120) + "**" +
    "\n  _Estado:_ " + markdownContent(statusLabel(agent.status, AGENT_STATUS_LABELS), 35));
  return displayList("Agentes do Paperclip", rows, "Nenhum agente encontrado.");
}

function displayTasks(issues) {
  const rows = issues
    .filter((issue) => !["done", "cancelled"].includes(issue.status))
    .slice(0, DEFAULT_LIMIT)
    .map((issue) =>
      "**" + markdownContent(issue.identifier ?? issue.id ?? "Sem ID", 28) + "**" +
      " · _" + markdownContent(statusLabel(issue.status, TASK_STATUS_LABELS), 35) + "_" +
      "\n" + markdownContent(issue.title ?? "Sem título", TITLE_LIMIT));
  return displayList("Tarefas abertas", rows, "Nenhuma tarefa aberta encontrada.");
}

/**
 * Normalize Paperclip's monthly spend values to non-negative integer cents.
 */
function cents(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : 0;
}

/**
 * Render integer cents as a stable pt-BR USD amount for Telegram.
 */
function formatUsd(value) {
  return "US$ " + new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents(value) / 100);
}

/**
 * Build a human-readable but identity-preserving label for an org group owner.
 */
function creditGroupLabel(agent) {
  const title = compact(agent?.title, 90);
  const identity = compact(agent?.name ?? agent?.id, 70);
  if (title && identity && title.toLocaleLowerCase("pt-BR") !== identity.toLocaleLowerCase("pt-BR")) {
    return `${title} · ${identity}`;
  }
  return title || identity || "Grupo sem nome";
}

/**
 * Aggregate each agent's native monthly spend into the CEO reporting hierarchy.
 */
function monthlyCreditGroups(agents) {
  const byId = new Map(agents.filter((agent) => agent?.id).map((agent) => [agent.id, agent]));
  const ceoIds = new Set(agents
    .filter((agent) => String(agent?.role ?? "").toLowerCase() === "ceo")
    .map((agent) => agent.id));
  const groups = new Map();

  const resolveGroup = (agent) => {
    if (ceoIds.has(agent.id)) {
      return { key: "ceo:" + agent.id, label: creditGroupLabel(agent) };
    }

    let current = agent;
    const seen = new Set([agent.id]);
    while (current?.reportsTo) {
      const parent = byId.get(current.reportsTo);
      if (!parent || seen.has(parent.id)) break;
      if (ceoIds.has(parent.id)) {
        return { key: "leader:" + current.id, label: creditGroupLabel(current) };
      }
      seen.add(parent.id);
      current = parent;
    }

    return { key: "outside-hierarchy", label: "Fora da hierarquia" };
  };

  for (const agent of agents) {
    if (!agent?.id) continue;
    const group = resolveGroup(agent);
    const existing = groups.get(group.key) ?? { ...group, cents: 0 };
    existing.cents += cents(agent.spentMonthlyCents);
    groups.set(group.key, existing);
  }

  return [...groups.values()].sort((left, right) =>
    right.cents - left.cents || left.label.localeCompare(right.label, "pt-BR"));
}

/**
 * Read every company agent through the native paginated Plugin SDK.
 * A repeated full page fails closed instead of silently returning a partial total.
 */
async function listAllAgents(ctx, companyId) {
  const agents = [];
  const seenIds = new Set();
  const pageSize = 100;
  let offset = 0;

  while (true) {
    const page = await ctx.agents.list({ companyId, limit: pageSize, offset });
    let added = 0;
    for (const agent of page) {
      if (!agent?.id || seenIds.has(agent.id)) continue;
      seenIds.add(agent.id);
      agents.push(agent);
      added++;
    }
    if (page.length < pageSize) return agents;
    if (added === 0) throw new Error("Agent pagination stalled while calculating monthly credits");
    offset += page.length;
  }
}

/**
 * Append only whole credit-group records while reserving room for the footer.
 */
function displayCreditRows(header, rows, footer, emptyMessage = "_Nenhum custo reportado neste mês._") {
  if (rows.length === 0) return `${header}\n${emptyMessage}${footer}`;

  let output = header;
  let included = 0;
  for (const row of rows) {
    const next = `${output}\n${row}`;
    const remaining = rows.length - included - 1;
    const omitted = remaining > 0 ? `\n_Exibindo ${included + 1} de ${rows.length} grupos; ${remaining} omitidos por limite de mensagem._` : "";
    if (next.length + omitted.length + footer.length > MAX_TEXT) break;
    output = next;
    included++;
  }

  const omitted = rows.length - included;
  if (omitted > 0) output += `\n_Exibindo ${included} de ${rows.length} grupos; ${omitted} omitidos por limite de mensagem._`;
  return output + footer;
}

/**
 * Produce the Founder-facing monthly total and organizational spend breakdown.
 */
async function displayCredits(ctx, companyId) {
  const [company, agents] = await Promise.all([
    ctx.companies.get({ companyId }),
    listAllAgents(ctx, companyId),
  ]);
  const groups = monthlyCreditGroups(agents);
  const agentTotal = groups.reduce((sum, group) => sum + group.cents, 0);
  const companyTotal = company ? cents(company.spentMonthlyCents) : agentTotal;
  const rows = groups
    .filter((group) => group.cents > 0)
    .map((group) => "• **" + markdownContent(group.label, 170) + "** — " + formatUsd(group.cents));
  const unassignedRow = companyTotal > agentTotal
    ? "• **Não atribuído** — " + formatUsd(companyTotal - agentTotal)
    : null;

  const header = [
    "**Créditos do mês**",
    "",
    "**Total reportado:** " + formatUsd(companyTotal),
    "",
    "**Por grupo**",
    ...(unassignedRow ? [unassignedRow] : []),
  ].join("\n");
  const footerLines = [
    "",
    "_Valores usam o gasto mensal reportado pelo Paperclip; uso não precificado ou coberto por assinatura não entra no total._",
  ];
  if (agentTotal > companyTotal) {
    footerLines.push("_A soma por grupo ainda está convergindo com o total da empresa._");
  }
  const emptyMessage = unassignedRow
    ? "_Nenhum custo atribuído a grupos neste mês._"
    : "_Nenhum custo reportado neste mês._";
  return displayCreditRows(header, rows, "\n" + footerLines.join("\n"), emptyMessage);
}

const commands = new Map([
  ["help", {
    description: "Exibir esta ajuda",
    handler: async () => [
    "**Comandos do Telegram Gateway**",
    "",
    ...listBuiltinTelegramCommands().map(({ name, description }) =>
      `\`/${name}\` — ${description}`),
    "",
    "**Comandos nativos do Paperclip**",
    "",
    ...NATIVE_TELEGRAM_COMMANDS.filter((command) => command.name !== "start")
      .map((command) => `\`/${command.name}\` — ${command.description}`),
    "",
    "_Mensagens normais continuam no Founder Liaison._",
    ].join("\n"),
  }],
  ["agents", {
    description: "Listar agentes",
    handler: async (ctx, companyId) => displayAgents(
      await ctx.agents.list({ companyId, limit: 30 }),
    ),
  }],
  ["tasks", {
    description: "Listar tarefas abertas",
    handler: async (ctx, companyId) => displayTasks(
      await ctx.issues.list({ companyId, limit: 100, includePluginOperations: false }),
    ),
  }],
  ["credits", {
    description: "Ver créditos gastos no mês por grupo",
    handler: async (ctx, companyId) => displayCredits(ctx, companyId),
  }],
]);

export function listBuiltinTelegramCommands() {
  return [...commands].map(([name, command]) => ({
    name,
    description: command.description,
    source: "gateway",
  })).sort((a, b) => a.name.localeCompare(b.name));
}

// Internal extensibility point: only trusted modules inside this installed
// plugin can register handlers. Remote plugins never inject executable code.
export function registerTelegramCommand(command, handler) {
  if (typeof command !== "string" || !/^[a-z][a-z0-9_]{1,31}$/.test(command) ||
      typeof handler !== "function" || commands.has(command)) {
    throw new Error("Invalid or duplicate Telegram Gateway command");
  }
  commands.set(command, { description: "Comando contribuído pelo plugin", handler });
}

export async function executeFounderCommand(ctx, params, invocation, registry = null) {
  const name = typeof params?.command === "string" ? params.command.toLowerCase().trim() : "";
  const command = commands.get(name)?.handler;
  if (params?.provider !== "telegram" || (!command && !registry)) return { handled: false };
  // This context is minted by the Paperclip host after the provider principal
  // has been linked and allowed; never trust the request's user ID.
  const actor = invocation?.actor;
  const companyId = typeof invocation?.companyId === "string" ? invocation.companyId : null;
  if (!companyId || actor?.companyId !== companyId || actor?.type !== "user" || !actor?.userId) {
    return { handled: false };
  }
  const config = await companyConfig(ctx, companyId);
  if (!config.liaisonAgentId || !config.founderUserId ||
      !config.commandsEnabled || !config.chatChannels.includes("telegram") ||
      params?.assigneeAgentId !== config.liaisonAgentId) return { handled: false };
  if (actor.userId !== config.founderUserId) return {
    handled: true,
    text: "Este comando é restrito ao Founder vinculado no Paperclip.",
  };
  if (command) {
    const text = await command(ctx, companyId);
    return { handled: true, text: String(text).slice(0, MAX_TEXT) };
  }
  // External providers never run before the linked Founder is authorized.
  const args = typeof params?.args === "string" ? params.args.trim() : "";
  return registry.execute(companyId, config.commandProviderIds, name, args);
}
