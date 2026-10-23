import { useEffect, useRef, useState } from "react";
import Chart from "./chart.js";
import { useHostNavigation, usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";

type Cohort = { cache: string; score: number; lcp: number; fcp: number; tbt: number; cls: number; bytes: number; requests: number; uiReadyMs: number | null };
type Run = { id: string; target_key: string; title: string; environment: string; scenario: string; profile: string; status: string; source: string; created_at: string; error_code: string | null;
  result: null | { buildId: string; lighthouseVersion: string; chromeVersion: string; cohorts: Cohort[]; samples: unknown[] } };
type Target = { key: string; title: string; projectId: string; environment: string; scenario: string; profile: string; enabled: boolean; intervalMinutes: number };
const statuses: Record<string, string> = { queued: "Na fila", running: "Em execução", passed: "Metas atingidas", regression: "Abaixo da meta", failed: "Coleta inválida" };
const metrics: Record<string, string> = { score: "Performance · 0–100", lcp: "LCP · ms", fcp: "FCP · ms", tbt: "TBT · ms", cls: "CLS", bytes: "Transferência · bytes", requests: "Requisições", uiReadyMs: "Interface pronta · ms" };
const css = `
.po{color:var(--foreground);font:inherit;padding:24px;max-width:1600px;margin:auto}
.po *{box-sizing:border-box}.po h1{font-size:28px;letter-spacing:-.04em;margin:0}.po h2{font-size:16px;margin:0}
.po p{color:var(--muted-foreground);font-size:13px;line-height:1.6}.po-top,.po-tools,.po-kpis{display:flex;gap:16px;align-items:center;flex-wrap:wrap}.po-top{justify-content:space-between;margin-bottom:24px}
.po-panel{border:1px solid var(--border);border-radius:10px;background:var(--card);padding:20px;margin:18px 0}.po-kpis{gap:32px}.po-kpi strong{display:block;font-size:26px;font-variant-numeric:tabular-nums;letter-spacing:-.04em}.po-kpi span,.po-small{font-size:12px;color:var(--muted-foreground)}
.po select,.po button{font:inherit;font-size:13px;color:var(--foreground);background:var(--background);border:1px solid var(--border);border-radius:6px;padding:8px 12px;max-width:100%}.po button{cursor:pointer}.po button:disabled{opacity:.45;cursor:wait}.po label{display:grid;gap:6px;font-size:12px;color:var(--muted-foreground)}
.po-scroll{overflow:auto}.po table{width:100%;border-collapse:collapse;font-size:12px}.po th{text-align:left;color:var(--muted-foreground);font-weight:500;padding:12px 8px;white-space:nowrap;border-bottom:1px solid var(--border)}.po td{padding:13px 8px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums}.po code{font-size:11px}.po-status{display:inline-block;padding:3px 7px;border:1px solid var(--border);border-radius:4px;white-space:nowrap}.po-status[data-status=failed]{color:var(--destructive)}.po-empty{padding:44px 0;text-align:center}.po details{font-size:12px}.po pre{overflow:auto;max-height:320px;white-space:pre-wrap}.po a{color:inherit;text-decoration:none}.po-error{color:var(--destructive)}
@media(max-width:640px){.po{padding:12px}.po-panel{padding:12px}.po-kpis{gap:20px}.po h1{font-size:24px}}
`;
function number(value: number | undefined | null) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(value);
}

function Panel({ companyId, projectId }: { companyId: string; projectId?: string }) {
  const [environment, setEnvironment] = useState("");
  const [targetKey, setTargetKey] = useState("");
  const [metric, setMetric] = useState("score");
  const [before, setBefore] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const requestKey = useRef<string | null>(null);
  const list = usePluginData<Run[]>("runs", { companyId, projectId, targetKey, environment, before, limit: 200 });
  const catalog = usePluginData<Target[]>("targets", { companyId });
  const request = usePluginAction("request_review");
  useEffect(() => { const timer = setInterval(() => list.refresh(), 15000); return () => clearInterval(timer); }, [list.refresh]);
  const runs = list.data ?? [];
  const filteredTargets = (catalog.data ?? []).filter((t) => !projectId || t.projectId === projectId);
  const valid = runs.filter((r) => r.result);
  const latest = valid[0];
  async function review() {
    if (!targetKey) return;
    setSubmitting(true); setError("");
    requestKey.current ??= crypto.randomUUID();
    try { await request({ targetKey, requestKey: requestKey.current }); requestKey.current = null; list.refresh(); }
    catch { setError("Não foi possível solicitar a análise. Verifique a configuração e tente novamente."); }
    finally { setSubmitting(false); }
  }
  function filterEnvironment(value: string) { setEnvironment(value); setBefore(undefined); }
  function filterTarget(value: string) { setTargetKey(value); requestKey.current = null; setBefore(undefined); }
  return <div className="po"><style>{css}</style>
    <div className="po-top"><div><span className="po-small">JOURNEY STUDIOS / QUALIDADE</span><h1>Performance Observatory</h1><p>Revisões sob demanda e periódicas. O executor liga para medir e encerra ao concluir.</p></div>
      <button type="button" onClick={() => list.refresh()}>Atualizar</button></div>
    <div className="po-tools">
      <label>Ambiente<select value={environment} onChange={(e) => filterEnvironment(e.target.value)}><option value="">Todos</option><option value="prod">Produção</option><option value="staging">Staging</option><option value="test">Teste</option></select></label>
      <label>Alvo e cenário<select value={targetKey} onChange={(e) => filterTarget(e.target.value)}><option value="">Todos os alvos</option>{filteredTargets.map((t) => <option key={t.key} value={t.key}>{t.title} · {t.environment}</option>)}</select></label>
      <label>Métrica<select value={metric} onChange={(e) => setMetric(e.target.value)}>{Object.entries(metrics).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <button type="button" disabled={!targetKey || submitting} onClick={() => void review()}>Solicitar review</button>
    </div>
    {(error || list.error) && <p role="alert" className="po-error">{error || "Falha ao carregar as execuções."}</p>}
    <section className="po-panel"><div className="po-kpis">
      <div className="po-kpi"><strong>{runs.length}</strong><span>execuções nesta página</span></div>
      <div className="po-kpi"><strong>{valid.length}</strong><span>coletas válidas</span></div>
      <div className="po-kpi"><strong>{runs.filter((r) => r.status === "failed").length}</strong><span>coletas inválidas</span></div>
      <div className="po-kpi"><strong>{runs.filter((r) => ["queued", "running"].includes(r.status)).length}</strong><span>na fila ou medindo</span></div>
    </div><p>Metas por revisão: média quente &gt;94; média fria idealmente &gt;70. Cada média exige três amostras válidas. Perfis e ambientes têm séries próprias.</p></section>
    <section className="po-panel"><h2>Evolução das medições</h2>{valid.length > 0 ? <Chart runs={runs} metric={metric}/> : <div className="po-empty"><h2>{list.loading ? "Carregando execuções…" : "Aguardando a primeira coleta válida"}</h2><p>Os resultados aparecerão aqui após uma revisão completa. Falhas continuam registradas na tabela.</p></div>}</section>
    <section className="po-panel"><h2>Histórico de execuções</h2><p>Últimas 200 execuções por página. Cada linha preserva o resultado e o build daquele momento.</p>
    <div className="po-scroll"><table><thead><tr>{["Quando", "Alvo / ambiente", "Estado", "Frio", "Quente", "LCP frio / quente", "Build", "Detalhes"].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{runs.map((run) => {
      const cold = run.result?.cohorts.find((c) => c.cache === "cold");
      const warm = run.result?.cohorts.find((c) => c.cache === "warm");
      return <tr key={run.id}><td>{new Date(run.created_at).toLocaleString("pt-BR")}</td><td>{run.title}<br/><span className="po-small">{run.environment} · {run.scenario} · {run.profile} · {run.source}</span></td><td><span className="po-status" data-status={run.status}>{statuses[run.status] || run.status}</span>{run.error_code && <p><code>{run.error_code}</code></p>}</td><td>{number(cold?.score)}</td><td>{number(warm?.score)}</td><td>{number(cold?.lcp)} / {number(warm?.lcp)} ms</td><td><code>{run.result?.buildId || "—"}</code></td><td><details><summary>Ver métricas</summary><pre>{JSON.stringify({ id: run.id, ...run.result }, null, 2)}</pre></details></td></tr>;
    })}</tbody></table></div>
    <div className="po-tools" style={{ marginTop: 16 }}>{before && <button type="button" onClick={() => setBefore(undefined)}>Mais recentes</button>}{runs.length === 200 && <button type="button" onClick={() => setBefore(String(runs[runs.length - 1].created_at))}>Mais antigas</button>}</div></section>
    <section className="po-panel"><h2>Agendamento e comandos</h2>{filteredTargets.length === 0 && <p>Adicione os alvos nas configurações deste plugin para habilitar revisões.</p>}{filteredTargets.map((t) => <p key={t.key}><strong>{t.title}</strong> · {t.environment} · {t.enabled ? `a cada ${t.intervalMinutes} min` : "somente sob demanda"} · <code>{t.key}</code></p>)}<p>Agentes: <code>list_targets</code>, <code>request_review</code>, <code>list_runs</code>, <code>get_run</code>. API externa autenticada: <code>/api/plugins/journey-studios.performance-observatory/api</code>.</p>{latest && <p>Última coleta válida: Lighthouse {latest.result?.lighthouseVersion} · {latest.result?.chromeVersion}. Todos os dados permanecem privados.</p>}</section>
  </div>;
}
export function SidebarLink() { const nav = useHostNavigation(); return <a {...nav.linkProps("/performance")} style={{ display: "block", padding: "8px 12px", color: "inherit" }}>Performance</a>; }
export function PerformancePage({ context }: { context: { companyId: string | null } }) { if (!context.companyId) return <p>Selecione uma companhia.</p>; return <Panel companyId={context.companyId}/>; }
export function ProjectPerformanceTab({ context }: { context: { companyId: string | null; entityId: string } }) { if (!context.companyId) return <p>Selecione uma companhia.</p>; return <Panel companyId={context.companyId} projectId={context.entityId}/>; }
