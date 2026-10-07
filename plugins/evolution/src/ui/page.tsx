import { useMemo, useState, type CSSProperties } from "react";
import {
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";

type ChangeSetSummary = {
  id: string;
  title: string;
  description?: string | null;
  hypothesis?: string | null;
  status: string;
  causalityLevel: string;
  appliedAt: string;
  validationEndsAt?: string | null;
  updatedAt: string;
  itemCount: number;
  evidenceCount: number;
  metricCount: number;
};

type Overview = {
  changeSets: ChangeSetSummary[];
  counts: Record<string, number>;
};

type ChangeItem = {
  id: string;
  entityType: string;
  entityId: string;
  entityName?: string | null;
  changeKind: string;
  changedKeys: unknown[];
  sourceType: string;
  sourceRef?: string | null;
  sourceActivityId?: string | null;
  occurredAt: string;
  beforeSnapshot?: unknown;
  afterSnapshot?: unknown;
};

type Evidence = {
  id: string;
  evidenceType: string;
  referenceId?: string | null;
  label?: string | null;
  verdict: string;
  notes?: string | null;
  observedAt?: string | null;
  createdAt: string;
};

type Metric = {
  metricKey: string;
  baselineValue?: number | null;
  currentValue?: number | null;
  deltaValue?: number | null;
  unit?: string | null;
  baselineSampleSize?: number | null;
  currentSampleSize?: number | null;
  computedAt: string;
};

type Conclusion = {
  id: string;
  outcome: string;
  confidence: string;
  summary: string;
  createdAt: string;
};

type LinkRow = {
  id: string;
  linkType: string;
  referenceId: string;
  label?: string | null;
};

type SuggestedRun = {
  id: string;
  agentId: string;
  agentName: string;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
  invocationSource?: string | null;
};

type Detail = {
  changeSet: ChangeSetSummary & {
    sourceContextKey?: string | null;
    createdByType?: string | null;
    createdById?: string | null;
    createdAt: string;
  };
  items: ChangeItem[];
  evidence: Evidence[];
  metrics: Metric[];
  conclusions: Conclusion[];
  links: LinkRow[];
  suggestedRuns: SuggestedRun[];
};

const shell: CSSProperties = {
  width: "100%",
  maxWidth: 1240,
  paddingBottom: 48,
  color: "var(--foreground)",
  fontFamily: "inherit",
};

const panel: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 12,
  background: "var(--card)",
};

const muted: CSSProperties = { color: "var(--muted-foreground)" };

const button: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--background)",
  color: "var(--foreground)",
  padding: "7px 10px",
  fontSize: 12,
  cursor: "pointer",
};

const primaryButton: CSSProperties = {
  ...button,
  background: "var(--primary)",
  borderColor: "var(--primary)",
  color: "var(--primary-foreground)",
};

const input: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--background)",
  color: "var(--foreground)",
  padding: "7px 9px",
  fontSize: 12,
};

function fmtDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value);
}

function statusLabel(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function metricLabel(value: string): string {
  const labels: Record<string, string> = {
    run_success_rate: "Run success",
    avg_run_duration: "Avg. duration",
    cost: "Cost",
    input_tokens: "Input tokens",
    cached_input_tokens: "Cached input",
    output_tokens: "Output tokens",
  };
  return labels[value] ?? statusLabel(value);
}

function fmtMetric(value: number | null | undefined, unit?: string | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (unit === "%") return value.toFixed(1) + "%";
  if (unit === "USD") return "$" + value.toFixed(2);
  if (unit === "seconds") return value.toFixed(1) + "s";
  if (unit === "tokens") return Math.round(value).toLocaleString();
  return value.toFixed(2);
}

function json(value: unknown): string {
  if (value == null) return "No snapshot";
  const text = JSON.stringify(value, null, 2);
  return text.length > 12000 ? text.slice(0, 12000) + "\n…truncated" : text;
}

function StatusPill({ value }: { value: string }) {
  return (
    <span
      style={{
        border: "1px solid var(--border)",
        borderRadius: 999,
        padding: "3px 7px",
        fontSize: 11,
        background: "var(--background)",
        whiteSpace: "nowrap",
      }}
    >
      {statusLabel(value)}
    </span>
  );
}

function Counts({ overview }: { overview: Overview }) {
  const keys = ["validating", "proven", "regressed", "inconclusive"];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
      {keys.map((key) => (
        <div key={key} style={{ ...panel, padding: 12 }}>
          <div style={{ ...muted, fontSize: 11 }}>{statusLabel(key)}</div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 3 }}>{overview.counts[key] ?? 0}</div>
        </div>
      ))}
    </div>
  );
}

function ChangeList({
  changeSets,
  selectedId,
  onSelect,
}: {
  changeSets: ChangeSetSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (changeSets.length === 0) {
    return (
      <div style={{ ...panel, ...muted, padding: 28, textAlign: "center" }}>
        No Change Sets yet. Create one or backfill recent agent and skill changes.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {changeSets.map((set) => (
        <button
          key={set.id}
          type="button"
          onClick={() => onSelect(set.id)}
          style={{
            ...panel,
            borderColor: selectedId === set.id ? "var(--primary)" : "var(--border)",
            color: "var(--foreground)",
            textAlign: "left",
            padding: 12,
            cursor: "pointer",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 650, fontSize: 13 }}>{set.title}</div>
              <div style={{ ...muted, marginTop: 4, fontSize: 11 }}>
                {fmtDate(set.appliedAt)} · {set.itemCount} changes · {set.evidenceCount} evidence
              </div>
            </div>
            <StatusPill value={set.status} />
          </div>
          {set.hypothesis ? (
            <div style={{ ...muted, fontSize: 12, marginTop: 8, lineHeight: 1.4 }}>{set.hypothesis}</div>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function DetailView({
  companyId,
  data,
  refresh,
}: {
  companyId: string;
  data: Detail;
  refresh: () => Promise<void>;
}) {
  const updateSet = usePluginAction("update-change-set");
  const addEvidence = usePluginAction("add-evidence");
  const addLink = usePluginAction("add-link");
  const addConclusion = usePluginAction("add-conclusion");
  const recompute = usePluginAction("recompute-metrics");
  const mergeChangeSet = usePluginAction("merge-change-set");
  const nav = useHostNavigation();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  }

  const set = data.changeSet;

  return (
    <section style={{ display: "grid", gap: 12 }}>
      <div style={{ ...panel, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{set.title}</h2>
            <div style={{ ...muted, fontSize: 11, marginTop: 5 }}>
              Applied {fmtDate(set.appliedAt)} · causality {statusLabel(set.causalityLevel)}
            </div>
          </div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            <select
              value={set.status}
              style={input}
              onChange={(event) => act("status", () => updateSet({
                companyId,
                changeSetId: set.id,
                status: event.currentTarget.value,
              }))}
            >
              {["draft", "applied", "validating", "proven", "regressed", "inconclusive", "reverted"].map((status) => (
                <option key={status} value={status}>{statusLabel(status)}</option>
              ))}
            </select>
            <select
              value={set.causalityLevel}
              style={input}
              onChange={(event) => act("causality", () => updateSet({
                companyId,
                changeSetId: set.id,
                causalityLevel: event.currentTarget.value,
              }))}
            >
              {["observed", "associated", "validated"].map((level) => (
                <option key={level} value={level}>{statusLabel(level)}</option>
              ))}
            </select>
            <button
              type="button"
              style={button}
              disabled={Boolean(busy)}
              onClick={() => act("metrics", () => recompute({ companyId, changeSetId: set.id }))}
            >
              Recompute metrics
            </button>
          </div>
        </div>

        {set.hypothesis ? (
          <div style={{ marginTop: 14 }}>
            <div style={{ ...muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.6 }}>Hypothesis</div>
            <div style={{ fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>{set.hypothesis}</div>
          </div>
        ) : null}
        {set.description ? (
          <div style={{ ...muted, fontSize: 12, lineHeight: 1.5, marginTop: 10 }}>{set.description}</div>
        ) : null}

        <div style={{ display: "flex", gap: 7, marginTop: 14, flexWrap: "wrap" }}>
          <button
            type="button"
            style={button}
            onClick={() => {
              const type = window.prompt("Evidence type", "run")?.trim();
              if (!type) return;
              const referenceId = window.prompt("Reference ID, if any")?.trim() ?? "";
              const verdict = window.prompt("Verdict: positive, neutral or negative", "positive")?.trim() ?? "neutral";
              const notes = window.prompt("What does this evidence show?")?.trim() ?? "";
              void act("evidence", () => addEvidence({
                companyId,
                changeSetId: set.id,
                evidenceType: type,
                ...(referenceId ? { referenceId } : {}),
                verdict,
                ...(notes ? { notes } : {}),
              }));
            }}
          >
            Add evidence
          </button>
          <button
            type="button"
            style={button}
            onClick={() => {
              const linkType = window.prompt("Link type: goal, project, issue, agent, skill", "issue")?.trim();
              if (!linkType) return;
              const referenceId = window.prompt("Reference ID")?.trim();
              if (!referenceId) return;
              const label = window.prompt("Label (optional)")?.trim() ?? "";
              void act("link", () => addLink({
                companyId,
                changeSetId: set.id,
                linkType,
                referenceId,
                ...(label ? { label } : {}),
              }));
            }}
          >
            Add link
          </button>
          <button
            type="button"
            style={button}
            onClick={() => {
              const targetChangeSetId = window.prompt("Target Change Set ID")?.trim();
              if (!targetChangeSetId || targetChangeSetId === set.id) return;
              setBusy("merge");
              setError("");
              void mergeChangeSet({
                companyId,
                sourceChangeSetId: set.id,
                targetChangeSetId,
              }).then(() => {
                nav.navigate("/evolution?change=" + encodeURIComponent(targetChangeSetId));
              }).catch((err) => {
                setError(err instanceof Error ? err.message : String(err));
              }).finally(() => setBusy(""));
            }}
          >
            Merge into…
          </button>
          <button
            type="button"
            style={button}
            onClick={() => {
              const outcome = window.prompt("Outcome: proven, regressed, inconclusive or reverted", "proven")?.trim();
              if (!outcome) return;
              const confidence = window.prompt("Confidence: low, moderate or high", "moderate")?.trim() ?? "low";
              const summary = window.prompt("Conclusion")?.trim();
              if (!summary) return;
              void act("conclusion", () => addConclusion({
                companyId,
                changeSetId: set.id,
                outcome,
                confidence,
                summary,
              }));
            }}
          >
            Conclude
          </button>
        </div>
        {error ? <div style={{ marginTop: 10, color: "var(--destructive)", fontSize: 12 }}>{error}</div> : null}
      </div>

      <div style={{ ...panel, padding: 14 }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>Impact</h3>
        {data.metrics.length === 0 ? (
          <div style={{ ...muted, fontSize: 12 }}>No metrics computed yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ ...muted, textAlign: "left" }}>
                  <th style={{ padding: "6px 8px" }}>Metric</th>
                  <th style={{ padding: "6px 8px" }}>Baseline</th>
                  <th style={{ padding: "6px 8px" }}>After</th>
                  <th style={{ padding: "6px 8px" }}>Delta</th>
                  <th style={{ padding: "6px 8px" }}>Samples</th>
                </tr>
              </thead>
              <tbody>
                {data.metrics.map((metric) => (
                  <tr key={metric.metricKey} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "8px" }}>{metricLabel(metric.metricKey)}</td>
                    <td style={{ padding: "8px" }}>{fmtMetric(metric.baselineValue, metric.unit)}</td>
                    <td style={{ padding: "8px" }}>{fmtMetric(metric.currentValue, metric.unit)}</td>
                    <td style={{ padding: "8px" }}>{fmtMetric(metric.deltaValue, metric.unit)}</td>
                    <td style={{ padding: "8px", ...muted }}>
                      {metric.baselineSampleSize ?? 0} → {metric.currentSampleSize ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ ...muted, fontSize: 10, marginTop: 9 }}>
          Metrics are observational until the causality level is explicitly promoted to Associated or Validated.
        </div>
      </div>

      <div style={{ ...panel, padding: 14 }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>Changes</h3>
        {data.items.length === 0 ? (
          <div style={{ ...muted, fontSize: 12 }}>No captured changes.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {data.items.map((item) => (
              <details key={item.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                <summary style={{ cursor: "pointer", fontSize: 12 }}>
                  <strong>{item.entityName || item.entityId}</strong>
                  <span style={{ ...muted }}> · {statusLabel(item.entityType)} · {statusLabel(item.changeKind)} · {fmtDate(item.occurredAt)}</span>
                </summary>
                <div style={{ ...muted, fontSize: 11, marginTop: 7 }}>
                  Changed: {Array.isArray(item.changedKeys) && item.changedKeys.length ? item.changedKeys.join(", ") : "snapshot"}
                  {item.sourceActivityId ? <> · Audit {item.sourceActivityId}</> : null}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginTop: 8 }}>
                  <div>
                    <div style={{ ...muted, fontSize: 10, marginBottom: 4 }}>Before</div>
                    <pre style={{ ...panel, margin: 0, padding: 9, overflow: "auto", maxHeight: 320, fontSize: 10, whiteSpace: "pre-wrap" }}>
                      {json(item.beforeSnapshot)}
                    </pre>
                  </div>
                  <div>
                    <div style={{ ...muted, fontSize: 10, marginBottom: 4 }}>After</div>
                    <pre style={{ ...panel, margin: 0, padding: 9, overflow: "auto", maxHeight: 320, fontSize: 10, whiteSpace: "pre-wrap" }}>
                      {json(item.afterSnapshot)}
                    </pre>
                  </div>
                </div>
              </details>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
        <div style={{ ...panel, padding: 14 }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>Evidence</h3>
          {data.evidence.length === 0 ? (
            <div style={{ ...muted, fontSize: 12 }}>No evidence linked yet.</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {data.evidence.map((entry) => (
                <div key={entry.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, fontSize: 12 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <strong>{entry.label || statusLabel(entry.evidenceType)}</strong>
                    <StatusPill value={entry.verdict} />
                  </div>
                  {entry.referenceId ? <div style={{ ...muted, fontSize: 10, marginTop: 3 }}>{entry.referenceId}</div> : null}
                  {entry.notes ? <div style={{ marginTop: 5, lineHeight: 1.4 }}>{entry.notes}</div> : null}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ ...panel, padding: 14 }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>Links & conclusions</h3>
          {data.links.map((link) => (
            <div key={link.id} style={{ fontSize: 12, marginBottom: 6 }}>
              <span style={muted}>{statusLabel(link.linkType)}:</span> {link.label || link.referenceId}
            </div>
          ))}
          {data.conclusions.length > 0 ? (
            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              {data.conclusions.map((conclusion) => (
                <div key={conclusion.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, fontSize: 12 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <StatusPill value={conclusion.outcome} />
                    <span style={muted}>confidence {conclusion.confidence}</span>
                  </div>
                  <div style={{ marginTop: 5, lineHeight: 1.4 }}>{conclusion.summary}</div>
                </div>
              ))}
            </div>
          ) : null}
          {data.links.length === 0 && data.conclusions.length === 0 ? (
            <div style={{ ...muted, fontSize: 12 }}>Nothing linked or concluded yet.</div>
          ) : null}
        </div>
      </div>

      <div style={{ ...panel, padding: 14 }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>Candidate run evidence</h3>
        <div style={{ ...muted, fontSize: 11, marginBottom: 9 }}>
          Recent runs from agents affected by this Change Set. Attach only runs that are actually comparable evidence.
        </div>
        {data.suggestedRuns.length === 0 ? (
          <div style={{ ...muted, fontSize: 12 }}>No candidate runs found.</div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {data.suggestedRuns.slice(0, 12).map((run) => (
              <div key={run.id} style={{ display: "flex", gap: 8, alignItems: "center", borderTop: "1px solid var(--border)", paddingTop: 7 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12 }}><strong>{run.agentName}</strong> · {run.status}</div>
                  <div style={{ ...muted, fontSize: 10 }}>{fmtDate(run.startedAt)} · {run.id}</div>
                </div>
                <button
                  type="button"
                  style={button}
                  onClick={() => act("attach-run", () => addEvidence({
                    companyId,
                    changeSetId: set.id,
                    evidenceType: "run",
                    referenceId: run.id,
                    label: run.agentName + " run",
                    verdict: run.status === "succeeded" ? "positive" : "negative",
                    observedAt: run.finishedAt ?? run.startedAt,
                  }))}
                >
                  Attach
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function SelectedChangeDetail({
  companyId,
  changeSetId,
  refreshOverview,
}: {
  companyId: string;
  changeSetId: string;
  refreshOverview: () => void | Promise<void>;
}) {
  const detail = usePluginData<Detail>("change-detail", { companyId, changeSetId });

  if (detail.loading) {
    return <div style={{ ...panel, ...muted, padding: 28, textAlign: "center" }}>Loading Change Set…</div>;
  }
  if (detail.error) {
    return (
      <div style={{ ...panel, color: "var(--destructive)", padding: 16 }}>
        Could not load Change Set: {detail.error.message}
      </div>
    );
  }
  if (!detail.data) return null;

  return (
    <DetailView
      companyId={companyId}
      data={detail.data}
      refresh={async () => {
        await Promise.all([detail.refresh(), refreshOverview()]);
      }}
    />
  );
}

export function EvolutionPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const nav = useHostNavigation();
  const location = useHostLocation();
  const selectedId = useMemo(
    () => new URLSearchParams(location.search).get("change") ?? "",
    [location.search],
  );
  const overview = usePluginData<Overview>("changes-overview", companyId ? { companyId } : {});
  const create = usePluginAction("create-change-set");
  const backfill = usePluginAction("backfill-recent");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  if (!companyId) return <main style={{ ...shell, ...muted }}>Select an organization to view Evolution.</main>;

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try {
      const result = await fn();
      await Promise.resolve(overview.refresh());
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy("");
    }
  }

  return (
    <main style={shell}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 23 }}>Evolution</h1>
          <p style={{ ...muted, margin: "5px 0 0", fontSize: 12 }}>
            Change → runs → evidence → evaluation → conclusion.
          </p>
        </div>
        <div style={{ display: "flex", gap: 7 }}>
          <button
            type="button"
            style={button}
            disabled={Boolean(busy)}
            onClick={() => {
              const raw = window.prompt("How many days should Evolution backfill?", "7");
              if (!raw) return;
              const days = Number(raw);
              void run("backfill", () => backfill({ companyId, days: Number.isFinite(days) ? days : 7 }));
            }}
          >
            Backfill recent
          </button>
          <button
            type="button"
            style={primaryButton}
            disabled={Boolean(busy)}
            onClick={() => {
              const title = window.prompt("Change Set title")?.trim();
              if (!title) return;
              const hypothesis = window.prompt("What improvement do you expect?")?.trim() ?? "";
              void run("create", () => create({
                companyId,
                title,
                ...(hypothesis ? { hypothesis } : {}),
                status: "draft",
                causalityLevel: "observed",
              })).then((result) => {
                const id = result && typeof result === "object" && "id" in result ? String((result as { id: unknown }).id) : "";
                if (id) nav.navigate("/evolution?change=" + encodeURIComponent(id));
              });
            }}
          >
            New Change Set
          </button>
        </div>
      </header>

      {error ? <div style={{ ...panel, color: "var(--destructive)", padding: 10, fontSize: 12, marginBottom: 12 }}>{error}</div> : null}

      {overview.loading ? (
        <div style={{ ...panel, ...muted, padding: 28, textAlign: "center" }}>Loading Evolution…</div>
      ) : overview.error ? (
        <div style={{ ...panel, color: "var(--destructive)", padding: 16 }}>
          Could not load Evolution: {overview.error.message}
        </div>
      ) : overview.data ? (
        <>
          <Counts overview={overview.data} />
          <div style={{ display: "grid", gridTemplateColumns: selectedId ? "minmax(260px, 340px) minmax(0, 1fr)" : "1fr", gap: 14, marginTop: 14, alignItems: "start" }}>
            <ChangeList
              changeSets={overview.data.changeSets}
              selectedId={selectedId}
              onSelect={(id) => nav.navigate("/evolution?change=" + encodeURIComponent(id))}
            />
            {selectedId ? (
              <SelectedChangeDetail
                companyId={companyId}
                changeSetId={selectedId}
                refreshOverview={overview.refresh}
              />
            ) : null}
          </div>
        </>
      ) : null}
    </main>
  );
}
