import { useMemo } from "react";
import {
  useHostNavigation,
  usePluginData,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";

type SizeRow = { id: string; label: string; bytes: number | null; status: "ok" | "missing" | "unavailable" };
type DockerRow = { id: string; label: string; sizeBytes: number; reclaimableBytes: number; count: number; active: number; approximate: boolean };
type HistoryPoint = { at: string; usedBytes: number; availableBytes: number };
type StorageSnapshot = {
  companyId: string;
  status: "ready" | "stale" | "unconfigured" | "unavailable" | "invalid";
  reason: string | null;
  generatedAt: string | null;
  filesystem: { mount: string; totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number } | null;
  directories: SizeRow[];
  docker: DockerRow[];
  history: HistoryPoint[];
  alerts: Array<{ level: "warning" | "critical"; code: string; configuredThresholdBytes: number }>;
  coverage: { partial: boolean; issues?: Array<{ source: string; code: string }>; notes: string[] };
};

const styles = [
  ".jsm{font:inherit;color:var(--foreground);min-width:0}.jsm *{box-sizing:border-box}",
  ".jsm h1,.jsm h2,.jsm p{margin:0}.jsm h1{font-size:1.65rem;letter-spacing:-.035em;font-weight:650}.jsm h2{font-size:1rem;font-weight:650}",
  ".jsm button{font:inherit;border:1px solid var(--border);background:var(--background);color:var(--foreground);border-radius:.5rem;padding:.55rem .8rem;cursor:pointer}",
  ".jsm button:hover{background:var(--accent)}.jsm button:disabled{cursor:wait;opacity:.6}.jsm button:focus-visible,.jsm a:focus-visible{outline:2px solid var(--ring);outline-offset:2px}",
  ".jsm .header{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:1.15rem;flex-wrap:wrap}",
  ".jsm .sub{font-size:.82rem;margin-top:.3rem;color:var(--muted-foreground)}.jsm .muted{color:var(--muted-foreground)}.jsm .small{font-size:.75rem}",
  ".jsm .cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.8rem}",
  ".jsm .card,.jsm .section{background:var(--card);border:1px solid var(--border);border-radius:.7rem;min-width:0}",
  ".jsm .card{padding:1.1rem}.jsm .label{font-size:.75rem;color:var(--muted-foreground)}",
  ".jsm .value{font-size:1.55rem;font-weight:650;letter-spacing:-.035em;margin-top:.5rem;overflow-wrap:anywhere}",
  ".jsm .section{margin-top:1rem;overflow:hidden}.jsm .section-header{display:flex;justify-content:space-between;gap:.75rem;align-items:center;flex-wrap:wrap;padding:1rem;border-bottom:1px solid var(--border)}",
  ".jsm .notice{padding:.85rem 1rem;border:1px solid var(--border);border-radius:.6rem;margin:1rem 0;font-size:.82rem;line-height:1.6}",
  ".jsm .warn{border-color:var(--destructive);color:var(--foreground)}.jsm .notice a{color:var(--primary)}",
  ".jsm .progress{height:.55rem;border-radius:1rem;background:var(--muted);overflow:hidden;margin-top:1rem}.jsm .progress span{height:100%;display:block;background:var(--primary);border-radius:inherit}",
  ".jsm .table-wrap{overflow-x:auto}.jsm table{border-collapse:collapse;width:100%;min-width:600px;font-size:.8rem}.jsm th{text-align:left;font-weight:500;color:var(--muted-foreground);background:var(--muted)}",
  ".jsm th,.jsm td{padding:.72rem 1rem;border-bottom:1px solid var(--border)}.jsm td:nth-child(n+2){font-variant-numeric:tabular-nums}",
  ".jsm tbody tr:last-child td{border-bottom:0}.jsm .hotspot{display:flex;gap:.7rem;align-items:center;justify-content:space-between;padding:.7rem 1rem;border-bottom:1px solid var(--border);font-size:.8rem}",
  ".jsm .hotspot:last-child{border-bottom:0}.jsm .hotspot strong{font-variant-numeric:tabular-nums;white-space:nowrap}.jsm .bar{height:.35rem;border-radius:.4rem;background:var(--muted);overflow:hidden;margin-top:.4rem}.jsm .bar span{background:var(--primary);height:100%;display:block}",
  ".jsm .grow{flex:1;min-width:0}.jsm .graph{width:100%;height:145px;display:block}.jsm .chart{padding:1rem}.jsm .legend{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-top:.45rem}",
  ".jsm .side-link{display:flex;align-items:center;gap:.55rem;padding:.55rem .65rem;text-decoration:none;color:var(--muted-foreground);border-radius:.4rem;font-size:.82rem}",
  ".jsm .side-link:hover,.jsm .side-link[aria-current=page]{background:var(--accent);color:var(--foreground)}.jsm .side-link svg{width:1rem;height:1rem;flex:none}",
  "@media(max-width:950px){.jsm .cards{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:550px){.jsm .cards{grid-template-columns:1fr 1fr}.jsm .value{font-size:1.2rem}.jsm h1{font-size:1.4rem}}",
].join("\n");

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "Indisponível";
  const units = ["B", "KiB", "GiB", "TiB"];
  if (bytes < 1024) return Math.round(bytes).toLocaleString("pt-BR") + " B";
  const order = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  const unit = ["B", "KiB", "MiB", "GiB", "TiB"][order];
  return (bytes / (1024 ** order)).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " " + unit;
}
function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}
function LineChart({ points }: { points: HistoryPoint[] }) {
  const sampled = points.filter((_, i) => i % Math.max(1, Math.ceil(points.length / 72)) === 0);
  const last = points.at(-1);
  if (last && sampled.at(-1)?.at !== last.at) sampled.push(last);
  if (sampled.length < 2) return <p className="muted small">O histórico aparece após duas coletas.</p>;
  const values = sampled.map((p) => p.usedBytes);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = Math.max(high - low, 1);
  const coordinates = sampled.map((p, i) => {
    const x = 12 + i * 776 / (sampled.length - 1);
    const y = 132 - (p.usedBytes - low) / span * 118;
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  const change = values[values.length - 1] - values[0];
  return <div className="chart">
    <svg className="graph" viewBox="0 0 800 145" role="img" aria-label="Histórico do espaço utilizado; crescimento líquido no período">
      <line x1="12" y1="132" x2="788" y2="132" stroke="var(--border)" />
      <line x1="12" y1="14" x2="788" y2="14" stroke="var(--border)" strokeDasharray="4 6" />
      <polyline points={coordinates} fill="none" stroke="var(--primary)" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
    <div className="legend small muted">
      <span>{formatTime(sampled[0].at)} — {formatTime(sampled[sampled.length - 1].at)}</span>
      <span>Variação: {change > 0 ? "+" : change < 0 ? "−" : ""}{formatBytes(Math.abs(change))}</span>
    </div>
  </div>;
}

export function StorageSidebar(_: PluginSidebarProps) {
  const nav = useHostNavigation();
  return <div className="jsm"><style>{styles}</style><a {...nav.linkProps("/storage")} className="side-link">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 11h18M7 16h3" /></svg>
    <span>Storage</span>
  </a></div>;
}

export function StoragePage({ context }: PluginPageProps) {
  if (!context.companyId) return <main className="jsm"><style>{styles}</style><p className="notice">Selecione uma empresa para abrir Storage Manager.</p></main>;
  return <StorageDashboard companyId={context.companyId} />;
}
function StorageDashboard({ companyId }: { companyId: string }) {
  const query = usePluginData<StorageSnapshot>("overview", { companyId });
  const snapshot = query.data?.companyId === companyId ? query.data : null;
  const dirs = useMemo(() => (snapshot?.directories ?? [])
    .filter((row): row is SizeRow & { bytes: number } => row.status === "ok" && row.bytes != null)
    .sort((a, b) => b.bytes - a.bytes), [snapshot]);
  const largest = dirs[0]?.bytes || 1;
  const fs = snapshot?.filesystem;
  const available = snapshot?.status === "ready" || snapshot?.status === "stale";
  return <main className="jsm">
    <style>{styles}</style>
    <header className="header"><div><h1>Storage Manager</h1><p className="sub">Disco da VPS, camadas Docker e evolução do armazenamento · somente leitura.</p></div>
      <button type="button" onClick={() => query.refresh()} disabled={query.loading}>Atualizar métricas</button>
    </header>
    {query.error && <div className="notice warn" role="alert">Falha na consulta do plugin. Confira as configurações e tente novamente.</div>}
    {query.loading && !snapshot && <p className="notice" role="status">Consultando snapshot de armazenamento…</p>}
    {snapshot && snapshot.status !== "ready" && <div className="notice warn" role="status">
      {snapshot.status === "stale" ? "O coletor parou de atualizar. Os dados abaixo são históricos, não representam o estado atual." :
        snapshot.status === "unconfigured" ? "Coletor não configurado. Monte uma pasta exclusiva de snapshots como somente leitura no Paperclip e configure a pasta storage-snapshot nas configurações do plugin." :
        "Snapshot indisponível ou inválido. Verifique o serviço de coleta e a pasta configurada. Nenhuma métrica anterior será tratada como atual."}
    </div>}
    {available && fs && <>
      <p className="sub" style={{ marginBottom: "1rem" }}>Última coleta: {formatTime(snapshot?.generatedAt ?? null)} · Fonte: df/du/Docker CLI no host · Sem acesso do plugin ao Docker socket.</p>
      <div className="cards">
        <article className="card"><p className="label">Capacidade</p><p className="value">{formatBytes(fs.totalBytes)}</p></article>
        <article className="card"><p className="label">Ocupado</p><p className="value">{formatBytes(fs.usedBytes)}</p></article>
        <article className="card"><p className="label">Disponível</p><p className="value">{formatBytes(fs.availableBytes)}</p></article>
        <article className="card"><p className="label">Utilização</p><p className="value">{fs.usedPercent.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%</p><div className="progress" aria-hidden="true"><span style={{ width: Math.min(100, fs.usedPercent) + "%" }} /></div></article>
      </div>
      {snapshot.alerts.length > 0 && <div className="notice warn" role="alert">Capacidade abaixo do limite configurado: {snapshot.alerts[0].level === "critical" ? "crítico" : "atenção"} ({formatBytes(snapshot.alerts[0].configuredThresholdBytes)} livres). Limites são definidos pelo operador, não estimados pelo plugin.</div>}
      {snapshot.coverage.partial && <div className="notice">Coleta parcial: algumas métricas falharam e não foram estimadas. Confira a saúde do coletor antes de agir.</div>}
      <section className="section"><div className="section-header"><div><h2>Principais diretórios</h2><p className="sub">Medidas do host; diretórios filhos se sobrepõem aos pais.</p></div><span className="small muted">{dirs.length} medidos</span></div>
        {dirs.length === 0 ? <p className="notice">Sem medidas de diretório.</p> : dirs.map((row) => <div className="hotspot" key={row.id}>
          <div className="grow"><span>{row.label}</span><div className="bar"><span style={{ width: (row.bytes / largest * 100).toFixed(1) + "%" }} /></div></div>
          <strong>{formatBytes(row.bytes)}</strong>
        </div>)}
      </section>
      <section className="section"><div className="section-header"><div><h2>Docker</h2><p className="sub">Estimativas da CLI, com camadas compartilhadas. Não somar as linhas nem assumir que espaço recuperável pode ser removido com segurança.</p></div></div>
        <div className="table-wrap"><table><thead><tr><th>Categoria</th><th>Itens</th><th>Ativos</th><th>Tamanho aprox.</th><th>Recuperável informado</th></tr></thead>
        <tbody>{snapshot.docker.map((row) => <tr key={row.id}><td>{row.label}</td><td>{row.count}</td><td>{row.active}</td><td>{formatBytes(row.sizeBytes)}</td><td>{formatBytes(row.reclaimableBytes)}</td></tr>)}
          {snapshot.docker.length === 0 && <tr><td colSpan={5}>Métricas Docker indisponíveis.</td></tr>}
        </tbody></table></div>
      </section>
      <section className="section"><div className="section-header"><div><h2>Crescimento do armazenamento</h2><p className="sub">Histórico limitado a coletas recentes, sem estimativas de causa ou atribuição a agentes.</p></div></div><LineChart points={snapshot.history} /></section>
      <p className="sub" style={{ marginTop: "1rem" }}>Sem limpeza automática, execução de comandos, permissões de escrita ou remoção de backups. Limites de alerta são opt-in.</p>
    </>}
  </main>;
}
