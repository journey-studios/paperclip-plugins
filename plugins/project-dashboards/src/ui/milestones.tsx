import { useState, type FormEvent } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type {
  MilestoneCriterion, MilestoneEvidence, MilestoneIssue, MilestoneRecord, MilestoneStatus,
} from "../contracts.js";
import { usePolling } from "./shared.js";
import { safeHttpUrl } from "../safe-url.js";

const STATUS: Record<MilestoneStatus, { pt: string; en: string }> = {
  planned: { pt: "Planejado", en: "Planned" },
  in_progress: { pt: "Em andamento", en: "In progress" },
  completed: { pt: "Concluído", en: "Completed" },
  cancelled: { pt: "Cancelado", en: "Cancelled" },
};

const copy = {
  pt: {
    title: "Marcos do projeto", add: "Novo marco", empty: "Ainda não há marcos neste projeto.",
    name: "Nome do marco", description: "Descrição (opcional)", target: "Data prevista",
    criteria: "Critérios de conclusão (um por linha)", issues: "Issues vinculadas", evidence: "Evidências (rótulo | URL, uma por linha)",
    issueSearch: "Adicionar Issue", noIssues: "Nenhuma Issue selecionada",
    save: "Salvar", cancel: "Cancelar", edit: "Editar", working: "Salvando...",
    start: "Iniciar", complete: "Concluir marco", reopen: "Reabrir", abort: "Cancelar marco",
    progress: "Progresso", ready: "Critérios atendidos — pronto para conclusão explícita",
    pending: "Pendências para concluir", verified: "Critérios verificados", done: "Issues concluídas",
    changelog: "Conclusão registrada no Changelog", loadError: "Erro ao carregar marcos",
    evidenceEmpty: "Nenhuma evidência anexada.", noCompany: "Empresa não selecionada.",
    details: "Detalhes e edição", removeIssue: "Desvincular Issue", refresh: "Atualizar",
  },
  en: {
    title: "Project milestones", add: "New milestone", empty: "No milestones in this project yet.",
    name: "Milestone title", description: "Description (optional)", target: "Target date",
    criteria: "Acceptance criteria (one per line)", issues: "Linked Issues", evidence: "Evidence (label | URL, one per line)",
    issueSearch: "Add Issue", noIssues: "No linked Issues",
    save: "Save", cancel: "Cancel", edit: "Edit", working: "Saving...",
    start: "Start", complete: "Complete milestone", reopen: "Reopen", abort: "Cancel milestone",
    progress: "Progress", ready: "All checks satisfied — ready for explicit completion",
    pending: "Completion blockers", verified: "Criteria verified", done: "Issues done",
    changelog: "Completion recorded in Changelog", loadError: "Cannot load milestones",
    evidenceEmpty: "No evidence attached.", noCompany: "Company not selected.",
    details: "Details and edit", removeIssue: "Unlink Issue", refresh: "Refresh",
  },
};

type T = typeof copy.pt;
type FormFields = {
  title: string; description: string | null; targetDate: string | null;
  criteria: MilestoneCriterion[]; issueIds: string[]; evidence: MilestoneEvidence[];
};

const formatEvidence = (links: MilestoneEvidence[]) => links.map((link) => `${link.label} | ${link.url}`).join("\n");
function parseEvidence(lines: string): MilestoneEvidence[] {
  return lines.split("\n").filter((line) => line.trim()).map((line) => {
    const sep = line.indexOf("|");
    if (sep < 0) return { label: line.trim(), url: "" };
    return { label: line.slice(0, sep).trim(), url: line.slice(sep + 1).trim() };
  });
}
function issuePath(identifier: string): string | null {
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(identifier)) return null;
  return `/${identifier.split("-")[0]}/issues/${identifier}`;
}
function failure(fail: unknown): string {
  return fail instanceof Error ? fail.message : String(fail);
}

function Editor({
  record, allIssues, companyId, projectId, t, onSaved, onCancel,
}: {
  record?: MilestoneRecord; allIssues: MilestoneIssue[];
  companyId: string; projectId: string; t: T; onSaved: () => void; onCancel: () => void;
}) {
  const create = usePluginAction("milestone.create");
  const update = usePluginAction("milestone.update");
  const [title, setTitle] = useState(record?.title ?? "");
  const [description, setDescription] = useState(record?.description ?? "");
  const [targetDate, setTargetDate] = useState(record?.targetDate ?? "");
  const [criteriaLines, setCriteriaLines] = useState(record?.criteria.map((criterion) => criterion.text).join("\n") ?? "");
  const [linked, setLinked] = useState<string[]>(record?.issueIds ?? []);
  const [evidenceLines, setEvidenceLines] = useState(formatEvidence(record?.evidence ?? []));
  const [nextIssue, setNextIssue] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = allIssues.filter((issue) => !linked.includes(issue.id));
  const linkedIssues = linked.map((id) => allIssues.find((issue) => issue.id === id) ?? record?.issues.find((issue) => issue.id === id));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setWorking(true);
    setError(null);
    try {
      const verified = new Map(record?.criteria.map((criterion) => [criterion.text, criterion.checked]) ?? []);
      const criteria: MilestoneCriterion[] = criteriaLines.split("\n").map((line) => line.trim()).filter(Boolean)
        .map((line) => ({ text: line, checked: verified.get(line) ?? false }));
      const payload: FormFields = {
        title, description: description.trim() || null, targetDate: targetDate || null,
        criteria, issueIds: linked, evidence: parseEvidence(evidenceLines),
      };
      if (record) await update({ companyId, milestoneId: record.id, revision: record.revision, ...payload });
      else await create({ companyId, projectId, ...payload });
      onSaved();
    } catch (err) {
      setError(failure(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      <label style={{ display: "grid", gap: 5 }}>
        <span>{t.name}</span>
        <input className="jpd-field" value={title} maxLength={200} required onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label style={{ display: "grid", gap: 5 }}>
        <span>{t.description}</span>
        <textarea className="jpd-field" value={description} maxLength={10000} onChange={(event) => setDescription(event.target.value)} rows={2} />
      </label>
      <label style={{ display: "grid", gap: 5 }}>
        <span>{t.target}</span>
        <input type="date" className="jpd-field" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} />
      </label>
      <label style={{ display: "grid", gap: 5 }}>
        <span>{t.criteria}</span>
        <textarea className="jpd-field" value={criteriaLines} required rows={4} onChange={(event) => setCriteriaLines(event.target.value)} />
      </label>
      <fieldset style={{ display: "grid", gap: 8, border: "1px solid var(--border, #999)", borderRadius: 8, padding: 12 }}>
        <legend>{t.issues}</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {linkedIssues.length ? linkedIssues.map((issue, i) => (
            <span key={linked[i]} className="jpd-chip">
              {issue?.identifier ?? linked[i]}
              <button type="button" aria-label={`${t.removeIssue} ${issue?.identifier ?? linked[i]}`}
                onClick={() => setLinked((old) => old.filter((id) => id !== linked[i]))}> × </button>
            </span>
          )) : <span className="jpd-muted">{t.noIssues}</span>}
        </div>
        <label style={{ display: "flex", gap: 8 }}>
          <select className="jpd-field" value={nextIssue} aria-label={t.issueSearch}
            onChange={(event) => setNextIssue(event.target.value)}>
            <option value="">{t.issueSearch}</option>
            {available.map((issue) => <option key={issue.id} value={issue.id}>{issue.identifier} · {issue.title}</option>)}
          </select>
          <button className="jpd-btn" type="button" disabled={!nextIssue}
            onClick={() => { if (nextIssue) setLinked((old) => [...old, nextIssue]); setNextIssue(""); }}>+</button>
        </label>
      </fieldset>
      <label style={{ display: "grid", gap: 5 }}>
        <span>{t.evidence}</span>
        <textarea className="jpd-field" value={evidenceLines} rows={3}
          placeholder="Teste E2E | https://example.com/evidence" onChange={(event) => setEvidenceLines(event.target.value)} />
      </label>
      {error && <div className="jpd-error" role="alert">{error}</div>}
      <div className="jpd-tools" style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="jpd-btn" disabled={working}>{working ? t.working : t.save}</button>
        <button type="button" className="jpd-btn" disabled={working} onClick={onCancel}>{t.cancel}</button>
      </div>
    </form>
  );
}

function Card({
  record, allIssues, companyId, projectId, t, onChanged,
}: {
  record: MilestoneRecord; allIssues: MilestoneIssue[]; companyId: string; projectId: string;
  t: T; onChanged: () => void;
}) {
  const update = usePluginAction("milestone.update");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const patch = async (values: Record<string, unknown>) => {
    setWorking(true);
    setError(null);
    try {
      await update({ companyId, milestoneId: record.id, revision: record.revision, ...values });
      onChanged();
    } catch (err) { setError(failure(err)); }
    finally { setWorking(false); }
  };
  const outstanding = record.status !== "completed" && record.status !== "cancelled";
  return (
    <article className="jpd-card" style={{ padding: 16, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
        <div>
          <h3 className="jpd-card-title">{record.title}</h3>
          <span className="jpd-muted">{STATUS[record.status][t === copy.pt ? "pt" : "en"]}
            {record.targetDate ? ` · ${record.targetDate}` : ""}</span>
        </div>
        <span>{record.progress}%</span>
      </div>
      {record.description && <p className="jpd-muted">{record.description}</p>}
      <progress value={record.progress} max={100} style={{ width: "100%" }} aria-label={t.progress} />
      <div className="jpd-muted">{t.done}: {record.doneIssues}/{record.issueIds.length} · {t.verified}: {record.verifiedCriteria}/{record.criteria.length}</div>
      <div style={{ display: "grid", gap: 5 }}>
        {record.criteria.map((criterion, index) => (
          <label key={index} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={criterion.checked} disabled={working || !outstanding}
              onChange={() => void patch({ criteria: record.criteria.map((item, i) => i === index ? { ...item, checked: !item.checked } : item) })} />
            <span>{criterion.text}</span>
          </label>
        ))}
      </div>
      {record.issues.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {record.issues.map((issue) => {
            const url = issuePath(issue.identifier);
            return <span key={issue.id} className="jpd-chip">
              {url ? <a href={url}>{issue.identifier}</a> : issue.identifier} · {issue.status}
            </span>;
          })}
        </div>
      )}
      {record.evidence.length
        ? <div className="jpd-cl-refs">{record.evidence.map((e, i) =>
            <a key={i} className="jpd-link" href={safeHttpUrl(e.url) ?? undefined} target="_blank" rel="noopener noreferrer">{e.label}</a>)}</div>
        : <span className="jpd-muted">{t.evidenceEmpty}</span>}
      {record.status === "completed" && <span className="jpd-muted">{t.changelog} · {record.completedAt?.slice(0, 10)}</span>}
      {record.status !== "cancelled" && record.blockers.length > 0 && (
        <details>
          <summary>{t.pending} ({record.blockers.length})</summary>
          <ul>{record.blockers.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </details>
      )}
      {outstanding && record.readyToComplete && <span className="jpd-muted">{t.ready}</span>}
      {error && <div className="jpd-error" role="alert">{error}</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {outstanding && <button type="button" className="jpd-btn" disabled={working} onClick={() => setEditing(!editing)}>{t.edit}</button>}
        {record.status === "planned" && <button type="button" className="jpd-btn" disabled={working}
          onClick={() => void patch({ status: "in_progress" })}>{t.start}</button>}
        {outstanding && <button type="button" className="jpd-btn" disabled={working || !record.readyToComplete}
          onClick={() => void patch({ status: "completed" })}>{t.complete}</button>}
        {record.status === "completed" || record.status === "cancelled" ?
          <button type="button" className="jpd-btn" disabled={working} onClick={() => void patch({ status: "in_progress" })}>{t.reopen}</button> : null}
        {outstanding && <button type="button" className="jpd-btn" disabled={working}
          onClick={() => void patch({ status: "cancelled" })}>{t.abort}</button>}
      </div>
      {editing && outstanding && <Editor key={record.revision} record={record} allIssues={allIssues}
        companyId={companyId} projectId={projectId} t={t}
        onSaved={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />}
    </article>
  );
}

export function MilestonesPanel({
  companyId, projectId, locale, refreshSeconds,
}: { companyId: string; projectId: string; locale: string; refreshSeconds: number }) {
  const t = copy[locale.toLowerCase().startsWith("pt") ? "pt" : "en"];
  const data = usePluginData<MilestoneRecord[]>("milestones.list", { companyId, projectId });
  const issues = usePluginData<MilestoneIssue[]>("milestones.projectIssues", { companyId, projectId });
  usePolling(refreshSeconds, data.refresh);
  const [creating, setCreating] = useState(false);
  const allIssues = issues.data ?? [];
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h2 className="jpd-h2">{t.title}</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="jpd-btn" onClick={() => data.refresh()}>{t.refresh}</button>
          <button type="button" className="jpd-btn" onClick={() => setCreating(!creating)}>{t.add}</button>
        </div>
      </div>
      {creating && <div className="jpd-card" style={{ padding: 16 }}>
        <Editor companyId={companyId} projectId={projectId} t={t} allIssues={allIssues}
          onSaved={() => { setCreating(false); data.refresh(); }} onCancel={() => setCreating(false)} />
      </div>}
      {data.error && <div role="alert" className="jpd-error">{t.loadError}: {data.error.message}</div>}
      {data.loading && !data.data ? <p className="jpd-muted">...</p> : null}
      {data.data?.length === 0 && !creating && <p className="jpd-muted">{t.empty}</p>}
      {(data.data ?? []).map((record) => <Card key={record.id} record={record} allIssues={allIssues}
        companyId={companyId} projectId={projectId} t={t} onChanged={() => data.refresh()} />)}
    </div>
  );
}
