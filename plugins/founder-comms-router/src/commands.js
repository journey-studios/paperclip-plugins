import { companyConfig } from "./core.js";

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

function displayList(heading, rows, emptyText) {
  return heading + "\n\n" + (rows.length ? rows.join("\n\n") : emptyText);
}

function displayAgents(agents) {
  const rows = agents.slice(0, DEFAULT_LIMIT).map((agent) =>
    "• " + compact(agent.name ?? agent.id ?? "Agente sem nome", 120) +
    "\n  Estado: " + statusLabel(agent.status, AGENT_STATUS_LABELS));
  return displayList("Agentes do Paperclip", rows, "Nenhum agente encontrado.");
}

function displayTasks(issues) {
  const rows = issues
    .filter((issue) => !["done", "cancelled"].includes(issue.status))
    .slice(0, DEFAULT_LIMIT)
    .map((issue) =>
      compact(issue.identifier ?? issue.id ?? "Sem ID", 28) +
      " · " + statusLabel(issue.status, TASK_STATUS_LABELS) +
      "\n" + compact(issue.title ?? "Sem título", TITLE_LIMIT));
  return displayList("Tarefas abertas", rows, "Nenhuma tarefa aberta encontrada.");
}

const commands = new Map([
  ["help", async () => [
    "Comandos do Founder Gateway",
    "",
    "/agents — Listar agentes",
    "/tasks — Listar tarefas abertas",
    "/help — Exibir esta ajuda",
    "",
    "Comandos nativos do Paperclip",
    "",
    "/status — Consultar tarefa atual",
    "/task — Iniciar tarefa com uma solicitação",
    "/new — Criar uma nova tarefa",
    "/close — Encerrar a conversa",
    "",
    "Mensagens normais continuam no Founder Liaison.",
  ].join("\n")],
  ["agents", async (ctx, companyId) => displayAgents(
    await ctx.agents.list({ companyId, limit: 30 }),
  )],
  ["tasks", async (ctx, companyId) => displayTasks(
    await ctx.issues.list({ companyId, limit: 100, includePluginOperations: false }),
  )],
]);

// Internal extensibility point: only trusted modules inside this installed
// plugin can register handlers. Remote plugins never inject executable code.
export function registerFounderCommand(command, handler) {
  if (typeof command !== "string" || !/^[a-z][a-z0-9_]{1,31}$/.test(command) ||
      typeof handler !== "function" || commands.has(command)) {
    throw new Error("Invalid or duplicate Founder Gateway command");
  }
  commands.set(command, handler);
}

export async function executeFounderCommand(ctx, params, invocation) {
  const name = typeof params?.command === "string" ? params.command.toLowerCase().trim() : "";
  const command = commands.get(name);
  if (!command || params?.provider !== "telegram") return { handled: false };
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
  const text = await command(ctx, companyId);
  return { handled: true, text: String(text).slice(0, MAX_TEXT) };
}
