const en = {
  loading: "Loading…",
  loadError: "Could not load dashboards: {message}",
  refresh: "Refresh",
  emptyTitle: "No dashboards yet",
  emptyBody:
    "Agents publish dashboards with the upsert_dashboard tool. Ask an agent to track a project and it will appear here.",
  emptyProject:
    "This project has no dashboard yet. Agents create one with the upsert_dashboard tool (the run's project is used automatically). MCP clients use paperclipUpsertDashboard with this project's ID:",
  projectIdLabel: "Project ID",
  copyProjectId: "Copy ID",
  projectIdCopied: "ID copied",
  noProject: "No project",
  noProjectHint:
    "These dashboards belong to no project (their project was deleted). Move each one to a project.",
  moveToProject: "Move to project",
  moveFailed: "Could not move the dashboard: {message}",
  projectLine: "Project:",
  orphanWarning: "This dashboard belongs to no project.",
  dashboardsOne: "1 dashboard",
  dashboardsMany: "{count} dashboards",
  selectDashboard: "Dashboard",
  backToList: "All dashboards",
  notFound: "Dashboard not found.",
  invalidStored: "The stored spec of this dashboard no longer validates and cannot be shown.",
  metaLine: "Revision {revision} · updated {when} by {who}",
  byAgent: "agent {name}",
  byAgentUnknown: "an agent",
  byUser: "a board user",
  bySystem: "the system",
  sources: "Sources",
  sourcesHint: "Where each dataset comes from and when it was last updated.",
  sourceOrigin: "Origin",
  sourceUpdated: "Updated",
  sourceRows: "{count} rows",
  sourceUnknown: "not stated",
  allFilter: "All",
  allOf: "All {label}",
  search: "Search",
  searchPlaceholder: "Search…",
  shownOf: "{shown} of {total}",
  noRows: "No rows match.",
  of: "of",
  chartData: "Chart data",
  other: "Other",
  total: "Total",
  history: "Revision history",
  restore: "Restore",
  restoreConfirm: "Restore revision {revision}? This creates a new revision.",
  remove: "Delete dashboard",
  removeConfirm: "Delete this dashboard and all of its revisions?",
  actionFailed: "Action failed: {message}",
  noData: "No data",
  toneOk: "ok",
  toneWarn: "warning",
  toneBad: "problem",
  toneMuted: "pending",
  toneInfo: "info",
  liveOn: "Live \u00b7 checked {seconds}s ago",
  liveOff: "Automatic refresh is off",
  updatedNotice: "Updated to revision {revision}",
  staleSourcesOne: "1 stale source",
  staleSourcesMany: "{count} stale sources",
  staleBadge: "Stale",
  copyLink: "Copy link",
  linkCopied: "Link copied",
  linkCopyFailed: "Could not copy the link",
} as const;

export type MessageKey = keyof typeof en;
type Dictionary = Record<MessageKey, string>;

const ptBR: Dictionary = {
  loading: "Carregando…",
  loadError: "Não foi possível carregar os dashboards: {message}",
  refresh: "Atualizar",
  emptyTitle: "Nenhum dashboard ainda",
  emptyBody:
    "Os agentes publicam dashboards com a ferramenta upsert_dashboard. Peça a um agente para acompanhar um projeto e ele aparecerá aqui.",
  emptyProject:
    "Este projeto ainda não tem dashboard. Os agentes criam um com a ferramenta upsert_dashboard (o projeto da execução é usado automaticamente). Clientes MCP usam paperclipUpsertDashboard com o ID deste projeto:",
  projectIdLabel: "ID do projeto",
  copyProjectId: "Copiar ID",
  projectIdCopied: "ID copiado",
  noProject: "Sem projeto",
  noProjectHint:
    "Estes dashboards não pertencem a nenhum projeto (o projeto foi excluído). Mova cada um para um projeto.",
  moveToProject: "Mover para projeto",
  moveFailed: "Não foi possível mover o dashboard: {message}",
  projectLine: "Projeto:",
  orphanWarning: "Este dashboard não pertence a nenhum projeto.",
  dashboardsOne: "1 dashboard",
  dashboardsMany: "{count} dashboards",
  selectDashboard: "Dashboard",
  backToList: "Todos os dashboards",
  notFound: "Dashboard não encontrado.",
  invalidStored: "A especificação salva deste dashboard não é mais válida e não pode ser exibida.",
  metaLine: "Revisão {revision} · atualizado {when} por {who}",
  byAgent: "o agente {name}",
  byAgentUnknown: "um agente",
  byUser: "um usuário do board",
  bySystem: "o sistema",
  sources: "Fontes",
  sourcesHint: "De onde vem cada conjunto de dados e quando foi atualizado pela última vez.",
  sourceOrigin: "Origem",
  sourceUpdated: "Atualizado",
  sourceRows: "{count} linhas",
  sourceUnknown: "não informada",
  allFilter: "Todos",
  allOf: "Todos: {label}",
  search: "Buscar",
  searchPlaceholder: "Buscar…",
  shownOf: "{shown} de {total}",
  noRows: "Nenhuma linha encontrada.",
  of: "de",
  chartData: "Dados do gráfico",
  other: "Outros",
  total: "Total",
  history: "Histórico de revisões",
  restore: "Restaurar",
  restoreConfirm: "Restaurar a revisão {revision}? Isso cria uma nova revisão.",
  remove: "Excluir dashboard",
  removeConfirm: "Excluir este dashboard e todas as suas revisões?",
  actionFailed: "A ação falhou: {message}",
  noData: "Sem dados",
  toneOk: "ok",
  toneWarn: "atenção",
  toneBad: "problema",
  toneMuted: "pendente",
  toneInfo: "info",
  liveOn: "Ao vivo \u00b7 verificado h\u00e1 {seconds}s",
  liveOff: "Atualiza\u00e7\u00e3o autom\u00e1tica desligada",
  updatedNotice: "Atualizado para a revis\u00e3o {revision}",
  staleSourcesOne: "1 fonte desatualizada",
  staleSourcesMany: "{count} fontes desatualizadas",
  staleBadge: "Desatualizada",
  copyLink: "Copiar link",
  linkCopied: "Link copiado",
  linkCopyFailed: "N\u00e3o foi poss\u00edvel copiar o link",
};

const DICTIONARIES: Record<string, Dictionary> = { en, "pt-BR": ptBR };

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Pick a dictionary for a BCP-47 tag; unknown languages fall back to English. */
export function dictionaryLocale(locale: string): "en" | "pt-BR" {
  const lower = locale.toLowerCase();
  return lower === "pt" || lower.startsWith("pt-") ? "pt-BR" : "en";
}

export function createTranslator(locale: string): Translate {
  const dictionary = DICTIONARIES[dictionaryLocale(locale)] ?? en;
  return (key, vars) => {
    const template = dictionary[key] ?? en[key];
    if (!vars) {
      return template;
    }
    return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));
  };
}
