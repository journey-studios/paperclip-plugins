import { useMemo, useState } from "react";
import {
  useHostNavigation,
  usePluginData,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";

type AgentRow = {
  id: string;
  name: string;
  status?: string | null;
  health?: string | null;
  runs?: number;
  successes?: number;
  failures?: number;
  retries?: number;
  knownCostCents?: number | null;
  unknownCostRuns?: number;
  avgDurationMs?: number | null;
  lastError?: string | null;
  errorCode?: string | null;
  lastRunId?: string | null;
};
type Failure = {
  id?: string;
  agentId?: string | null;
  agentName?: string | null;
  runId?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  attempt?: number | null;
  retryOfRunId?: string | null;
  errorCode?: string | null;
  status?: string | null;
};
type Anomaly = {
  id?: string;
  kind?: string | null;
  severity?: string | null;
  suspected?: boolean;
  agentId?: string | null;
  agentName?: string | null;
  runIds?: string[];
  occurredAt?: string | null;
  occurrences?: number;
  description?: string | null;
  evidence?: Record<string, unknown> | string[];
};
type Overview = {
  companyId: string;
  windowHours: number;
  generatedAt?: string;
  coverage?: { rawLogsAvailable?: boolean; eventsAvailable?: boolean; hasMoreRuns?: boolean; runsReturned?: number; runsLimit?: number; hasMoreAgents?: boolean; agentsReturned?: number; agentsLimit?: number; totalAgents?: number; notes?: string[] };
  summary?: {
    runsTotal?: number;
    agentsTotal?: number;
    avgDurationMs?: number | null;
    successes?: number;
    failures?: number;
    retries?: number;
    knownCostCents?: number | null;
    unknownCostRuns?: number;
      };
  agents?: AgentRow[];
  failures?: Failure[];
  anomalies?: Anomaly[];
};
type AgentDetail = {
  companyId: string;
  windowHours: number;
  agent: AgentRow;
  recentRuns?: Array<{ id: string; status?: string; createdAt?: string; startedAt?: string; finishedAt?: string; durationMs?: number; errorCode?: string | null }>;
  coverage?: Overview["coverage"];
};
type TraceData = {
  companyId: string;
  runId?: string;
  windowHours?: number;
  run?: { id: string; agentId?: string | null; agentName?: string | null; status?: string | null; createdAt?: string | null; startedAt?: string | null; finishedAt?: string | null; durationMs?: number | null; invocationSource?: string | null; errorCode?: string | null; retryOfRunId?: string | null; retryCount?: number };
  timeline?: Array<{ at?: string | null; type?: string | null }>;
  retryChain?: Array<{ id: string; agentName?: string | null; status?: string | null; createdAt?: string | null; errorCode?: string | null }>;
  coverage?: Overview["coverage"];
};

type Tab = "overview" | "failures" | "anomalies" | "trace" | "costs";
const tabs: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Visão geral" },
  { id: "failures", label: "Falhas" },
  { id: "anomalies", label: "Anomalias" },
  { id: "trace", label: "Trace" },
  { id: "costs", label: "Custos" },
];

const css = `
.jao{--jao-green:#178653;--jao-amber:#b7791f;--jao-red:#c44545;color:var(--foreground);font:inherit;min-width:0}.jao *{box-sizing:border-box}.jao button,.jao select{font:inherit}.jao h1,.jao h2,.jao h3,.jao p{margin:0}.jao h1{font-size:1.7rem;letter-spacing:-.04em;font-weight:650}.jao h2{font-size:1rem;font-weight:600}.jao button,.jao select{border:1px solid var(--border);border-radius:.45rem;background:var(--background);color:var(--foreground);padding:.55rem .75rem}.jao button{cursor:pointer}.jao button:hover{background:var(--accent)}.jao button:disabled{opacity:.55;cursor:wait}.jao button:focus-visible,.jao select:focus-visible,.jao a:focus-visible{outline:2px solid var(--ring);outline-offset:2px}.jao .muted{color:var(--muted-foreground)}.jao .small{font-size:.75rem}.jao .header{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;margin-bottom:1.25rem}.jao .intro{display:flex;align-items:center;gap:.85rem}.jao .logo{width:2.5rem;height:2.5rem;border:1px solid var(--border);border-radius:.7rem;display:grid;place-items:center;background:var(--card);color:var(--primary)}.jao .logo svg{width:1.35rem;height:1.35rem}.jao .subtitle{margin-top:.3rem;color:var(--muted-foreground);font-size:.82rem}.jao .actions{display:flex;align-items:center;gap:.55rem;flex-wrap:wrap}.jao .tabs{display:flex;gap:.25rem;overflow:auto;border-bottom:1px solid var(--border);margin-bottom:1.2rem}.jao .tabs button{border:0;border-radius:.35rem .35rem 0 0;background:transparent;color:var(--muted-foreground);padding:.65rem .8rem;white-space:nowrap;border-bottom:2px solid transparent}.jao .tabs button[aria-selected=true]{color:var(--foreground);border-bottom-color:var(--primary);font-weight:600}.jao .summary{display:grid;grid-template-columns:repeat(5,minmax(8rem,1fr));gap:.75rem;margin-bottom:1rem}.jao .card{background:var(--card);border:1px solid var(--border);border-radius:.65rem;padding:1rem;min-width:0}.jao .metric-label{font-size:.72rem;color:var(--muted-foreground)}.jao .metric-value{font-size:1.5rem;font-weight:650;letter-spacing:-.04em;margin-top:.4rem}.jao .metric-foot{font-size:.7rem;color:var(--muted-foreground);margin-top:.25rem}.jao .section{border:1px solid var(--border);border-radius:.65rem;background:var(--card);overflow:hidden;margin-top:1rem}.jao .section-head{padding:.85rem 1rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:.75rem}.jao .section-head p{margin-top:.25rem}.jao .scroll{overflow:auto;max-width:100%}.jao table{width:100%;border-collapse:collapse;min-width:950px;font-size:.78rem}.jao th{text-align:left;font-weight:500;color:var(--muted-foreground);font-size:.68rem;white-space:nowrap;padding:.72rem .8rem;background:var(--muted);position:sticky;top:0}.jao td{padding:.72rem .8rem;border-top:1px solid var(--border);vertical-align:middle;white-space:nowrap}.jao tbody tr:hover{background:var(--accent)}.jao .agent-name{font-weight:600}.jao .agent-id{font-size:.67rem;color:var(--muted-foreground);margin-top:.15rem}.jao .link-button{border:0;background:transparent;padding:0;color:var(--primary);font-weight:600;text-align:left;white-space:normal}.jao .link-button:hover{text-decoration:underline;background:transparent}.jao .pill{display:inline-flex;align-items:center;gap:.35rem;border-radius:99px;padding:.2rem .5rem;background:var(--secondary);color:var(--secondary-foreground);font-size:.68rem}.jao .dot{width:.42rem;height:.42rem;border-radius:50%;background:currentColor}.jao .pill.good{color:var(--jao-green)}.jao .pill.warn{color:var(--jao-amber)}.jao .pill.bad{color:var(--jao-red)}.jao .notice{padding:.7rem .9rem;border-bottom:1px solid var(--border);font-size:.75rem;color:var(--muted-foreground);background:var(--muted)}.jao .notice strong{color:var(--foreground)}.jao .list{display:grid}.jao .row{display:grid;grid-template-columns:minmax(9rem,1.1fr) minmax(12rem,2fr) minmax(9rem,1fr) minmax(6rem,.7fr);gap:1rem;align-items:start;padding:.85rem 1rem;border-top:1px solid var(--border);font-size:.8rem}.jao .row:first-child{border-top:0}.jao .row p{overflow-wrap:anywhere}.jao .empty{padding:3rem 1rem;text-align:center;color:var(--muted-foreground)}.jao .error{margin:1rem 0;padding:.85rem 1rem;border:1px solid var(--destructive);border-radius:.5rem;color:var(--destructive);background:var(--card);font-size:.82rem}.jao .detail{display:grid;grid-template-columns:minmax(15rem,1fr) minmax(17rem,1.2fr);gap:1rem;margin-top:1rem}.jao .detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem;margin-top:.9rem}.jao .detail-item{min-width:0}.jao .detail-item strong{display:block;font-size:.88rem;margin-top:.22rem;overflow-wrap:anywhere}.jao .timeline{padding:.25rem 1rem 1rem}.jao .event{position:relative;padding:.75rem 0 .75rem 1.2rem;border-left:1px solid var(--border);font-size:.78rem}.jao .event:before{content:"";position:absolute;left:-.25rem;top:1rem;width:.45rem;height:.45rem;border-radius:50%;background:var(--primary)}.jao .event p{margin-top:.22rem;color:var(--muted-foreground);white-space:pre-wrap;overflow-wrap:anywhere}.jao .nav-link{display:flex;align-items:center;gap:.55rem;padding:.55rem .65rem;border-radius:.4rem;text-decoration:none;color:var(--muted-foreground);font-size:.82rem}.jao .nav-link:hover,.jao .nav-link[aria-current=page]{background:var(--accent);color:var(--foreground)}.jao .nav-link svg{width:1rem;height:1rem}.jao .loading{padding:2rem;text-align:center;color:var(--muted-foreground)}@media(max-width:1000px){.jao .summary{grid-template-columns:repeat(3,minmax(7rem,1fr))}}@media(max-width:700px){.jao .header{flex-direction:column}.jao .summary{grid-template-columns:repeat(2,minmax(7rem,1fr))}.jao .detail{grid-template-columns:1fr}.jao .row{grid-template-columns:1fr 1fr}.jao h1{font-size:1.4rem}}@media(prefers-reduced-motion:reduce){.jao *{scroll-behavior:auto!important}}
`;

function Icon({ name }: { name: "pulse" | "refresh" | "arrow" }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {name === "pulse" ? <><path d="M3 12h4l3-8 4 16 3-8h4" /><circle cx="12" cy="12" r="10" /></> : name === "refresh" ? <path d="M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 14-1l1 6M4 12l1 6a8 8 0 0 0 14-1" /> : <path d="M5 12h14m-6-6 6 6-6 6" />}
  </svg>;
}

function count(value?: number | null) { return Number.isFinite(value) ? new Intl.NumberFormat("pt-BR").format(value as number) : "—"; }
function money(cents?: number | null) {
  if (cents == null || !Number.isFinite(cents)) return "Não informado";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD" }).format(cents / 100);
}
function duration(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 60_000 ? `${(value / 60_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} min` : `${(value / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`;
}
function date(value?: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(parsed);
}
function health(value?: string | null, status?: string | null) {
  const label = value || status || "desconhecido";
  const normalized = label.toLowerCase();
  const kind = /unhealthy|fail|error|crash|offline|blocked/.test(normalized) ? "bad" : /warn|degrad|retry|paused/.test(normalized) ? "warn" : /healthy|^ok$|active|running|success/.test(normalized) ? "good" : "";
  return <span className={`pill ${kind}`}><span className="dot" />{label}</span>;
}
function safeError(value?: string | null) { return value?.trim() || "Nenhum erro registrado"; }

export function SidebarLink(_: PluginSidebarProps) {
  const navigation = useHostNavigation();
  return <div className="jao"><style>{css}</style><a {...navigation.linkProps("/observatory")} className="nav-link"><Icon name="pulse" />Observatório</a></div>;
}

export function ObservatoryPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  if (!companyId) {
    return <main className="jao"><style>{css}</style><div className="empty">Selecione uma empresa para ver o Observatório.</div></main>;
  }
  return <ObservatoryDashboard companyId={companyId} />;
}

function ObservatoryDashboard({ companyId }: { companyId: string }) {
  const [windowHours, setWindowHours] = useState(24);
  const [tab, setTab] = useState<Tab>("overview");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const query = usePluginData<Overview>("overview", { companyId, windowHours, limit: 100 });
  const data = query.data?.companyId === companyId && query.data.windowHours === windowHours ? query.data : null;
  const agents = useMemo(() => data?.agents ?? [], [data]);
  const onSelectAgent = (id: string) => { setAgentId(id); setRunId(null); };

  return <main className="jao">
    <style>{css}</style>
    <header className="header">
      <div className="intro"><div className="logo"><Icon name="pulse" /></div><div><h1>Observatório de Agentes</h1><p className="subtitle">Saúde, execução e custos da organização em um só lugar.</p></div></div>
      <div className="actions">
        <label className="small muted" htmlFor="jao-window">Janela</label>
        <select id="jao-window" value={windowHours} onChange={(event) => { setWindowHours(Number(event.target.value)); setAgentId(null); setRunId(null); }}>
          <option value={1}>Última hora</option><option value={24}>24 horas</option><option value={168}>7 dias</option>
        </select>
        <button type="button" onClick={() => query.refresh()} disabled={query.loading} aria-label="Atualizar dados"><Icon name="refresh" /> Atualizar</button>
      </div>
    </header>
    <div className="tabs" role="tablist" aria-label="Seções do Observatório">
      {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => { setTab(item.id); setAgentId(null); setRunId(null); }}>{item.label}</button>)}
    </div>
    {query.error && <div className="error" role="alert">Não foi possível carregar o Observatório. Tente atualizar em instantes.</div>}
    {query.loading && !data ? <div className="loading" role="status">Carregando dados de execução…</div> : data ? <>
      <CoverageNotice coverage={data.coverage} generatedAt={data.generatedAt} />
      {tab === "overview" && <>
        <Summary summary={data.summary} />
        <AgentTable agents={agents} onSelect={onSelectAgent} onRun={setRunId} />
        {agentId && <AgentDetails companyId={companyId} agentId={agentId} windowHours={windowHours} onClose={() => setAgentId(null)} onRun={setRunId} />}
        {runId && <TracePanel companyId={companyId} runId={runId} onClose={() => setRunId(null)} />}
      </>}
      {tab === "failures" && <Records title="Falhas observadas" entries={data.failures ?? []} onAgent={onSelectAgent} onRun={setRunId} empty="Nenhuma falha registrada nesta janela." />}
      {tab === "anomalies" && <AnomalyList entries={data.anomalies ?? []} onAgent={onSelectAgent} onRun={setRunId} />}
      {tab === "trace" && <TracePicker agents={agents} onRun={setRunId} runId={runId} companyId={companyId} />}
      {tab === "costs" && <CostPanel agents={agents} summary={data.summary} />}
      {tab !== "overview" && runId && tab !== "trace" && <TracePanel companyId={companyId} runId={runId} onClose={() => setRunId(null)} />}
    </> : !query.error ? <div className="empty">Nenhum dado disponível para esta janela.</div> : null}
  </main>;
}

function CoverageNotice({ coverage, generatedAt }: { coverage?: Overview["coverage"]; generatedAt?: string }) {
  const notes: string[] = [];
  if (coverage?.rawLogsAvailable === false) notes.push("logs brutos não são exibidos");
  if (coverage?.eventsAvailable === false) notes.push("trace limitado aos dados resumidos de cada execução");
  if (coverage?.hasMoreRuns) notes.push("resumo cobre a janela completa; detecção de anomalias usa as execuções mais recentes");
  if (coverage?.hasMoreAgents) notes.push(`lista limitada a ${count(coverage.agentsReturned)} de ${count(coverage.totalAgents)} agentes`);
  return <div className="notice"><strong>Cobertura:</strong> {notes.length ? ` ${notes.join("; ")}.` : " histórico disponível para esta janela."} <span> Atualizado {date(generatedAt)}.</span></div>;
}
function Summary({ summary }: { summary?: Overview["summary"] }) {
  const metrics = [
    ["Execuções", count(summary?.runsTotal), "na janela selecionada"],
    ["Concluídas", count(summary?.successes), "execuções com sucesso"],
    ["Falhas", count(summary?.failures), "execuções com erro"],
    ["Retries", count(summary?.retries), "tentativas adicionais"],
    ["Custo conhecido", money(summary?.knownCostCents), `${count(summary?.unknownCostRuns)} execuções sem custo conhecido`],
  ];
  return <div className="summary">{metrics.map(([label, value, foot]) => <article className="card" key={label}><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-foot">{foot}</div></article>)}</div>;
}
function AgentTable({ agents, onSelect, onRun }: { agents: AgentRow[]; onSelect: (id: string) => void; onRun: (id: string) => void }) {
  return <section className="section"><div className="section-head"><div><h2>Agentes</h2><p className="small muted">Selecione um agente para ver o detalhe e as execuções recentes.</p></div><span className="pill">{count(agents.length)} agentes</span></div>
    {!agents.length ? <div className="empty">Nenhum agente com dados nesta janela.</div> : <div className="scroll"><table><thead><tr><th>Agente</th><th>Saúde / status</th><th>Runs</th><th>Falhas</th><th>Retries</th><th>Custo conhecido</th><th>Sem custo</th><th>Duração média</th><th>Último erro</th></tr></thead><tbody>
      {agents.map((agent) => <tr key={agent.id}><td><button className="link-button" type="button" onClick={() => onSelect(agent.id)}><span className="agent-name">{agent.name || "Agente sem nome"}</span><span className="agent-id">{agent.id}</span></button></td><td>{health(agent.health)}<div className="small muted" style={{ marginTop: ".25rem" }}>{agent.status || "Estado desconhecido"}</div></td><td>{count(agent.runs)}</td><td>{count(agent.failures)}</td><td>{count(agent.retries)}</td><td>{money(agent.knownCostCents)}</td><td>{count(agent.unknownCostRuns)}</td><td>{duration(agent.avgDurationMs)}</td><td title={safeError(agent.lastError)}>{agent.lastError ? `${agent.lastError.slice(0, 72)}${agent.lastError.length > 72 ? "…" : ""}` : "—"}{agent.lastRunId && <button className="link-button small" style={{ display: "block", marginTop: ".2rem" }} onClick={() => onRun(agent.lastRunId!)} type="button">Ver último run</button>}</td></tr>)}
    </tbody></table></div>}
  </section>;
}
function AgentDetails({ companyId, agentId, windowHours, onClose, onRun }: { companyId: string; agentId: string; windowHours: number; onClose: () => void; onRun: (id: string) => void }) {
  const query = usePluginData<AgentDetail>("agent", { companyId, agentId, windowHours });
  const payload = query.data?.companyId === companyId && query.data.windowHours === windowHours && query.data.agent?.id === agentId ? query.data : null;
  const agent = payload?.agent ?? null;
  return <section className="section"><div className="section-head"><div><h2>Detalhe do agente</h2><p className="small muted">Dados do agente no período selecionado.</p></div><button type="button" onClick={onClose}>Fechar</button></div>
    {query.loading && !agent ? <div className="loading" role="status">Carregando agente…</div> : query.error ? <div className="error" role="alert">Falha ao carregar os dados do agente.</div> : agent ? <div className="detail"><div className="card"><h3>{agent.name || agent.id}</h3><div style={{ marginTop: ".55rem" }}>{health(agent.health)} <span className="small muted">{agent.status || "Estado desconhecido"}</span></div><div className="detail-grid">{[["Runs", count(agent.runs)], ["Sucessos", count(agent.successes)], ["Falhas", count(agent.failures)], ["Retries", count(agent.retries)], ["Custo conhecido", money(agent.knownCostCents)], ["Execuções sem custo", count(agent.unknownCostRuns)], ["Duração média", duration(agent.avgDurationMs)]].map(([label, value]) => <div className="detail-item" key={label}><span className="small muted">{label}</span><strong>{value}</strong></div>)}</div><p className="small muted" style={{ marginTop: "1rem" }}>Último erro: {safeError(agent.lastError)}</p></div>
      <div className="card"><h3>Execuções recentes</h3>{payload?.recentRuns?.length ? <div className="timeline">{payload.recentRuns.map((run) => <div className="event" key={run.id}><button className="link-button" type="button" onClick={() => onRun(run.id)}>{run.id}</button><p>{run.status || "status desconhecido"} · {date(run.startedAt || run.createdAt)}</p>{run.errorCode && <p>{run.errorCode}</p>}</div>)}</div> : <p className="small muted" style={{ marginTop: ".75rem" }}>Sem execuções detalhadas neste período.</p>}</div></div> : <div className="empty">Detalhe indisponível.</div>}
  </section>;
}
function Records({ title, entries, onAgent, onRun, empty }: { title: string; entries: Failure[]; onAgent: (id: string) => void; onRun: (id: string) => void; empty: string }) {
  return <section className="section"><div className="section-head"><div><h2>{title}</h2><p className="small muted">Registros disponíveis no histórico consultado.</p></div><span className="pill bad">{count(entries.length)} itens</span></div>{entries.length ? <div className="list">{entries.map((entry, index) => <div className="row" key={entry.id || entry.runId || index}><div>{entry.agentId ? <button className="link-button" onClick={() => onAgent(entry.agentId!)} type="button">{entry.agentName || entry.agentId}</button> : entry.agentName || "Agente não identificado"}<p className="small muted">{date(entry.createdAt)}</p></div><p>{entry.errorCode || "Falha registrada; código indisponível"}</p><div>{entry.status || "status desconhecido"}{entry.attempt ? ` · tentativa ${entry.attempt}` : ""}{entry.retryOfRunId && <p className="small muted">Retry de {entry.retryOfRunId}</p>}</div><div>{entry.id ? <button className="link-button" onClick={() => onRun(entry.id!)} type="button">Abrir trace <Icon name="arrow" /></button> : "—"}</div></div>)}</div> : <div className="empty">{empty}</div>}</section>;
}
function AnomalyList({ entries, onAgent, onRun }: { entries: Anomaly[]; onAgent: (id: string) => void; onRun: (id: string) => void }) {
  return <section className="section"><div className="section-head"><div><h2>Anomalias sinalizadas</h2><p className="small muted">Sinais heurísticos para investigação; confirme cada item nos registros de origem.</p></div><span className="pill warn">{count(entries.length)} sinais</span></div>{entries.length ? <div className="list">{entries.map((item, index) => <div className="row" key={item.id || item.runIds?.[0] || index}><div>{item.agentId ? <button className="link-button" onClick={() => onAgent(item.agentId!)} type="button">{item.agentName || item.agentId}</button> : item.agentName || "Agente não identificado"}<p className="small muted">{date(item.occurredAt)}</p></div><p>{item.description || item.kind || "Anomalia sinalizada"}</p><div><span className={`pill ${item.severity === "high" ? "bad" : "warn"}`}>{item.suspected === false ? "sinal" : "suspeita"}</span><p className="small muted" style={{ marginTop: ".35rem" }}>{item.evidence ? JSON.stringify(item.evidence) : "Evidência indisponível"} · {count(item.occurrences)} ocorrências</p></div><div>{item.runIds?.[0] && <button className="link-button" onClick={() => onRun(item.runIds![0])} type="button">Abrir trace <Icon name="arrow" /></button>}</div></div>)}</div> : <div className="empty">Nenhuma anomalia sinalizada nesta janela.</div>}</section>;
}
function CostPanel({ agents, summary }: { agents: AgentRow[]; summary?: Overview["summary"] }) {
  return <><div className="summary"><article className="card"><div className="metric-label">Custo conhecido total</div><div className="metric-value">{money(summary?.knownCostCents)}</div><div className="metric-foot">Soma apenas de valores registrados.</div></article><article className="card"><div className="metric-label">Runs sem custo conhecido</div><div className="metric-value">{count(summary?.unknownCostRuns)}</div><div className="metric-foot">Custo desconhecido não equivale a zero.</div></article></div><section className="section"><div className="section-head"><div><h2>Custos por agente</h2><p className="small muted">Valores em dólar, conforme retorno do plugin.</p></div></div><div className="scroll"><table style={{ minWidth: 580 }}><thead><tr><th>Agente</th><th>Custo conhecido</th><th>Runs sem custo conhecido</th><th>Runs</th></tr></thead><tbody>{agents.map((agent) => <tr key={agent.id}><td>{agent.name}</td><td>{money(agent.knownCostCents)}</td><td>{count(agent.unknownCostRuns)}</td><td>{count(agent.runs)}</td></tr>)}</tbody></table></div></section></>;
}
function TracePicker({ agents, onRun, runId, companyId }: { agents: AgentRow[]; onRun: (id: string) => void; runId: string | null; companyId: string }) {
  const [draft, setDraft] = useState("");
  return <section className="section"><div className="section-head"><div><h2>Trace de execução</h2><p className="small muted">Abra um trace a partir do último run de um agente ou informe um ID disponível.</p></div></div><div style={{ padding: "1rem", display: "flex", gap: ".5rem", flexWrap: "wrap" }}><select aria-label="Última execução de agente" value="" onChange={(event) => event.target.value && onRun(event.target.value)}><option value="">Selecionar último run…</option>{agents.filter((agent) => agent.lastRunId).map((agent) => <option value={agent.lastRunId!} key={agent.id}>{agent.name} · {agent.lastRunId}</option>)}</select><label className="small muted" htmlFor="jao-run-id">ID do run</label><input id="jao-run-id" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Cole um ID de execução" style={{ minWidth: "14rem", padding: ".55rem .75rem", border: "1px solid var(--border)", borderRadius: ".45rem", background: "var(--background)", color: "var(--foreground)" }} /><button type="button" disabled={!draft.trim()} onClick={() => onRun(draft.trim())}>Abrir trace</button></div>{runId && <TracePanel companyId={companyId} runId={runId} onClose={() => onRun("")} />}</section>;
}
function TracePanel({ companyId, runId, onClose }: { companyId: string; runId: string; onClose: () => void }) {
  const query = usePluginData<TraceData>("trace", { companyId, runId });
  const trace = query.data?.run?.id === runId ? query.data : null;
  return <section className="section" aria-label="Trace do run"><div className="section-head"><div><h2>Trace da execução</h2><p className="small muted">{runId}</p></div><button type="button" onClick={onClose}>Fechar trace</button></div>{query.loading && !trace ? <div className="loading" role="status">Carregando trace…</div> : query.error ? <div className="error" role="alert">Trace indisponível. Verifique se o run pertence a esta organização.</div> : trace ? <div className="detail"><div className="card"><h3>{trace.run?.agentName || "Execução"}</h3><div style={{ marginTop: ".55rem" }}>{health(trace.run?.status, trace.run?.status)}</div><div className="detail-grid">{[["Criada", date(trace.run?.createdAt)], ["Início", date(trace.run?.startedAt)], ["Fim", date(trace.run?.finishedAt)], ["Duração", duration(trace.run?.durationMs)], ["Origem", trace.run?.invocationSource || "—"], ["Retries", count(trace.run?.retryCount)]].map(([label, value]) => <div className="detail-item" key={label}><span className="small muted">{label}</span><strong>{value}</strong></div>)}</div><p className="small muted" style={{ marginTop: "1rem" }}>{trace.run?.errorCode || "Sem código de erro."}</p></div><div className="card"><h3>Linha do tempo</h3>{trace.timeline?.length ? <div className="timeline">{trace.timeline.map((event, index) => <div className="event" key={`${event.at || "event"}-${index}`}><strong>{event.type || "Evento"}</strong><span className="small muted"> · {date(event.at)}</span></div>)}</div> : <p className="small muted" style={{ marginTop: ".75rem" }}>Sem eventos detalhados para este run.</p>}{trace.retryChain?.length ? <div className="timeline"><h3>Encadeamento de retries</h3>{trace.retryChain.map((retry) => <div className="event" key={retry.id}><strong>{retry.status || "Execução"}</strong><span className="small muted"> · {date(retry.createdAt)} · {retry.id}</span>{retry.errorCode && <p>{retry.errorCode}</p>}</div>)}</div> : null}</div></div> : <div className="empty">Trace não encontrado.</div>}</section>;
}
