import { companyConfig } from "./core.js";

const DEFAULT_LIMIT = 10;
const MAX_TEXT = 3600;

function compact(value, max = 90) {
  return String(value ?? "").replace(/[\r\n\t]/g, " ").trim().slice(0, max);
}

function displayAgents(agents) {
  const rows = agents.slice(0, DEFAULT_LIMIT).map((agent) =>
    `• ${compact(agent.name ?? agent.id, 60)} — ${compact(agent.status ?? "unknown", 30)}`);
  return ["Agentes do Paperclip", ...(rows.length ? rows : ["Nenhum agente encontrado."])].join("\n").slice(0, MAX_TEXT);
}

function displayTasks(issues) {
  const rows = issues
    .filter((issue) => !["done", "cancelled"].includes(issue.status))
    .slice(0, DEFAULT_LIMIT)
    .map((issue) => `• ${compact(issue.identifier ?? issue.id, 28)} — ${compact(issue.title ?? "", 70)} (${compact(issue.status, 20)})`);
  return ["Tarefas abertas", ...(rows.length ? rows : ["Nenhuma tarefa aberta encontrada."])].join("\n").slice(0, MAX_TEXT);
}

const commands = new Map([
  ["help", async () => (
    "Comandos: /agents (agentes), /tasks (tarefas abertas), /help (ajuda). " +
    "Comandos nativos: /status (tarefa do chat), /task, /new e /close. " +
    "Mensagens normais continuam no Founder Liaison."
  )],
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
  if (!config.commandsEnabled || !config.chatChannels.includes("telegram") ||
      params?.assigneeAgentId !== config.liaisonAgentId) return { handled: false };
  if (actor.userId !== config.founderUserId) return {
    handled: true,
    text: "Este comando é restrito ao Founder vinculado no Paperclip.",
  };
  const text = await command(ctx, companyId);
  return { handled: true, text: String(text).slice(0, MAX_TEXT) };
}
