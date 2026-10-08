import type { CSSProperties } from "react";

export type Assessment = {
  outcome: "improved" | "regressed" | "inconclusive";
  confidence: "low" | "moderate";
  reasonCode: string;
  summary: string;
  evidenceCount: number;
  baselineRunCount: number;
  currentRunCount: number;
  evaluatedAt: string;
};

const panel: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 12,
  background: "var(--card)",
  padding: 14,
};

const muted: CSSProperties = { color: "var(--muted-foreground)" };
const button: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--primary)",
  borderColor: "var(--primary)",
  color: "var(--primary-foreground)",
  padding: "7px 10px",
  fontSize: 12,
  cursor: "pointer",
};

function statusLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function AssessmentPill({ value }: { value: string }) {
  return (
    <span style={{ border: "1px solid var(--border)", borderRadius: 999, padding: "3px 7px", fontSize: 11, background: "var(--background)", whiteSpace: "nowrap" }}>
      {statusLabel(value)}
    </span>
  );
}

export function AssessmentPanel({
  assessment,
  busy,
  onRefresh,
}: {
  assessment: Assessment | null;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <section style={{ ...panel, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Observational assessment</h3>
        <button type="button" style={button} disabled={busy} onClick={onRefresh}>
          Refresh evidence &amp; assessment
        </button>
      </div>
      {assessment ? (
        <div style={{ display: "grid", gap: 8, fontSize: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <AssessmentPill value={assessment.outcome} />
            <span style={muted}>Confidence: {assessment.confidence} · {new Date(assessment.evaluatedAt).toLocaleString()}</span>
          </div>
          <div>{assessment.summary}</div>
          <div style={muted}>
            Baseline: {assessment.baselineRunCount} runs · After: {assessment.currentRunCount} runs · {assessment.evidenceCount} evidence records.
          </div>
        </div>
      ) : (
        <div style={muted}>No assessment yet. New run events and the hourly reconciliation will populate this section.</div>
      )}
      <div style={{ ...muted, fontSize: 11 }}>
        These automatic assessments never change a human conclusion or establish causation.
      </div>
    </section>
  );
}
