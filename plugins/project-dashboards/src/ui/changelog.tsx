import { useEffect, useId, useMemo, useState } from "react";
import { useHostNavigation, usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import {
  CHANGELOG_KINDS,
  type ChangelogEntry,
  type ChangelogImportResult,
  type ChangelogKind,
  type ChangelogPage,
  type ProjectOption,
  type Tone,
} from "../contracts.js";
import { isRecord } from "../keys.js";
import { safeHttpUrl } from "../safe-url.js";
import type { MessageKey } from "./i18n.js";
import { State, usePolling, type Localized } from "./shared.js";
import { Md, actorLabel } from "./view.js";

const PAGE_STEP = 50;
const PAGE_MAX = 500;
const ISSUE_REF = /^[A-Z][A-Z0-9]*-\d+$/;

const KIND_TONE: Record<ChangelogKind, Tone> = {
  release: "ok",
  feature: "ok",
  milestone: "info",
  improvement: "info",
  decision: "info",
  fix: "warn",
  incident: "bad",
  note: "muted",
  issue: "muted",
};

const KIND_LABEL: Record<ChangelogKind, MessageKey> = {
  milestone: "kindMilestone",
  release: "kindRelease",
  feature: "kindFeature",
  fix: "kindFix",
  improvement: "kindImprovement",
  decision: "kindDecision",
  incident: "kindIncident",
  note: "kindNote",
  issue: "kindIssue",
};

function isImportResult(value: unknown): value is ChangelogImportResult {
  return (
    isRecord(value) &&
    typeof value.scanned === "number" &&
    typeof value.imported === "number" &&
    typeof value.skipped === "number" &&
    typeof value.truncated === "boolean"
  );
}

function failureText(failure: unknown): string {
  return failure instanceof Error ? failure.message : isRecord(failure) && typeof failure.message === "string" ? failure.message : String(failure);
}

interface MonthGroup {
  key: string;
  label: string;
  entries: ChangelogEntry[];
}

/** Entries arrive newest first, so equal months are always adjacent. */
function groupByMonth(entries: ChangelogEntry[], month: Intl.DateTimeFormat): MonthGroup[] {
  const groups: MonthGroup[] = [];
  for (const entry of entries) {
    const date = new Date(entry.occurredAt);
    const key = `${date.getFullYear()}-${date.getMonth()}`;
    const last = groups.at(-1);
    if (last && last.key === key) {
      last.entries.push(entry);
    } else {
      groups.push({ key, label: month.format(date), entries: [entry] });
    }
  }
  return groups;
}

function EntryRow({
  entry,
  localized,
  showProject,
  onDelete,
}: {
  entry: ChangelogEntry;
  localized: Localized;
  showProject: boolean;
  onDelete: (entry: ChangelogEntry) => void;
}) {
  const { t, fmt } = localized;
  const navigation = useHostNavigation();
  const compact = entry.kind === "issue";
  return (
    <li className={compact ? "jpd-cl-entry jpd-cl-compact" : "jpd-cl-entry"}>
      <div className="jpd-cl-head">
        <time className="jpd-cl-date" dateTime={entry.occurredAt} title={fmt.dateTime(entry.occurredAt)}>
          {fmt.date(entry.occurredAt)}
        </time>
        <span className={`jpd-cl-kind jpd-tone-${KIND_TONE[entry.kind]}`}>{t(KIND_LABEL[entry.kind])}</span>
        <span className="jpd-cl-title">{entry.title}</span>
        {entry.version ? <code className="jpd-code">{entry.version}</code> : null}
        {showProject && entry.projectName ? <span className="jpd-cl-project">{entry.projectName}</span> : null}
      </div>
      {!compact && entry.body ? (
        <div className="jpd-cl-body">
          <Md content={entry.body} />
        </div>
      ) : null}
      {entry.refs.length > 0 || entry.links.length > 0 ? (
        <div className="jpd-cl-refs">
          {entry.refs.map((ref, index) =>
            ISSUE_REF.test(ref) ? (
              <a key={`${ref}-${index}`} className="jpd-cl-ref" {...navigation.linkProps(`/issues/${ref}`)}>
                {ref}
              </a>
            ) : (
              <code key={`${ref}-${index}`} className="jpd-code">
                {ref}
              </code>
            ),
          )}
          {entry.links.map((link, index) => {
            const href = safeHttpUrl(link.url);
            return href ? (
              <a key={`${link.url}-${index}`} className="jpd-link" href={href} target="_blank" rel="noopener noreferrer">
                {link.label}
              </a>
            ) : (
              <span key={`${link.url}-${index}`}>{link.label}</span>
            );
          })}
        </div>
      ) : null}
      <div className="jpd-cl-foot">
        {compact ? null : <span className="jpd-muted">{t("changelogBy", { who: actorLabel(entry.createdBy, t) })}</span>}
        <button type="button" className="jpd-btn jpd-btn-danger" aria-label={t("changelogDeleteEntry", { title: entry.title })} onClick={() => onDelete(entry)}>
          {t("changelogDelete")}
        </button>
      </div>
    </li>
  );
}

/**
 * The project changelog as a month-grouped timeline. "Show more" raises the page size
 * instead of walking cursors, which keeps polling a plain refetch of the same query.
 */
export function ChangelogTimeline({
  companyId,
  projectId,
  localized,
  showProject,
  allowImport,
}: {
  companyId: string;
  projectId: string | null;
  localized: Localized;
  showProject: boolean;
  allowImport: boolean;
}) {
  const { settings, t, fmt } = localized;
  const [limit, setLimit] = useState(PAGE_STEP);
  const [includeIssues, setIncludeIssues] = useState(true);
  const [selected, setSelected] = useState<ChangelogKind[]>([]);
  const [seen, setSeen] = useState<ChangelogKind[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<ChangelogImportResult | null>(null);
  const toggleId = useId();
  const remove = usePluginAction("changelog.delete");
  const importIssues = usePluginAction("changelog.importIssues");
  const kinds = includeIssues ? selected : selected.filter((kind) => kind !== "issue");
  const query = usePluginData<ChangelogPage>("changelog.list", {
    companyId,
    ...(projectId ? { projectId } : {}),
    includeIssues,
    ...(kinds.length > 0 ? { kinds } : {}),
    limit,
  });
  usePolling(settings.refreshIntervalSeconds, query.refresh);
  const page = query.data;
  const entries = page?.entries ?? [];

  // Type chips show every kind seen so far, so choosing one does not hide the others.
  useEffect(() => {
    if (!page) {
      return;
    }
    setSeen((previous) => {
      const next = CHANGELOG_KINDS.filter((kind) => previous.includes(kind) || page.entries.some((entry) => entry.kind === kind));
      return next.length === previous.length ? previous : next;
    });
  }, [page]);
  const chipKinds = seen.filter((kind) => includeIssues || kind !== "issue");
  const month = useMemo(() => new Intl.DateTimeFormat(fmt.locale, { month: "long", year: "numeric" }), [fmt.locale]);
  const groups = useMemo(() => groupByMonth(entries, month), [entries, month]);

  const toggle = (kind: ChangelogKind) =>
    setSelected(kinds.includes(kind) ? kinds.filter((item) => item !== kind) : [...kinds, kind]);

  const destroy = async (entry: ChangelogEntry) => {
    if (!window.confirm(t("changelogDeleteConfirm"))) {
      return;
    }
    try {
      await remove({ companyId, id: entry.id });
      setError(null);
      query.refresh();
    } catch (failure) {
      setError(failureText(failure));
    }
  };

  const runImport = async () => {
    setImporting(true);
    setError(null);
    try {
      const result = await importIssues({ companyId, projectId });
      setImported(isImportResult(result) ? result : null);
      query.refresh();
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setImporting(false);
    }
  };

  const filtered = kinds.length > 0 || !includeIssues;
  let body;
  if (query.error) {
    body = <State title={t("changelogLoadError", { message: query.error.message })} />;
  } else if (query.loading && !page) {
    body = <State title={t("loading")} />;
  } else if (entries.length === 0) {
    body = filtered ? <State title={t("changelogNoMatch")} /> : <State title={t("changelogEmptyTitle")} body={t("changelogEmptyBody")} />;
  } else {
    body = (
      <div className="jpd-cl">
        {groups.map((group) => (
          <section className="jpd-cl-month" key={group.key} aria-label={group.label}>
            <h3 className="jpd-cl-month-title">{group.label}</h3>
            <ol className="jpd-cl-list">
              {group.entries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} localized={localized} showProject={showProject} onDelete={(item) => void destroy(item)} />
              ))}
            </ol>
          </section>
        ))}
        {page?.nextCursor && limit < PAGE_MAX ? (
          <div>
            <button type="button" className="jpd-btn" onClick={() => setLimit(Math.min(PAGE_MAX, limit + PAGE_STEP))}>
              {t("changelogShowMore")}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="jpd-cl-wrap">
      <div className="jpd-tools">
        <span className="jpd-tools" role="group" aria-label={t("changelogKinds")}>
          <button type="button" className="jpd-chip" aria-pressed={kinds.length === 0} onClick={() => setSelected([])}>
            {t("allFilter")}
          </button>
          {chipKinds.map((kind) => (
            <button key={kind} type="button" className="jpd-chip" aria-pressed={kinds.includes(kind)} onClick={() => toggle(kind)}>
              {t(KIND_LABEL[kind])}
            </button>
          ))}
        </span>
        <label htmlFor={toggleId} className="jpd-cl-toggle">
          <input id={toggleId} type="checkbox" checked={includeIssues} onChange={(event) => setIncludeIssues(event.target.checked)} />
          {t("changelogIncludeIssues")}
        </label>
        {allowImport && projectId ? (
          <button type="button" className="jpd-btn jpd-cl-import" disabled={importing} onClick={() => void runImport()}>
            {importing ? t("changelogImporting") : t("changelogImport")}
          </button>
        ) : null}
      </div>
      {imported ? (
        <div role="status" className={imported.truncated ? "jpd-tone-warn" : "jpd-muted"}>
          {t("changelogImported", { imported: imported.imported, scanned: imported.scanned })}
          {imported.truncated ? ` ${t("changelogImportTruncated", { scanned: imported.scanned })}` : ""}
        </div>
      ) : null}
      {error ? <div className="jpd-error">{t("actionFailed", { message: error })}</div> : null}
      {body}
    </div>
  );
}

/** The company-wide changelog with an optional project filter (the dashboards page view). */
export function CompanyChangelog({ companyId, localized }: { companyId: string; localized: Localized }) {
  const { t } = localized;
  const [projectId, setProjectId] = useState("");
  const projects = usePluginData<ProjectOption[]>("projects.list", { companyId });
  const selectId = useId();
  return (
    <>
      <div className="jpd-tools">
        <label htmlFor={selectId} className="jpd-muted">
          {t("changelogProject")}
        </label>
        <select id={selectId} className="jpd-field" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">{t("changelogAllProjects")}</option>
          {(projects.data ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>
      <ChangelogTimeline key={projectId} companyId={companyId} projectId={projectId || null} localized={localized} showProject={projectId === ""} allowImport={false} />
    </>
  );
}

/** Dashboards | Changelog switch of the page; the dashboards view keeps the plain /dashboards URL. */
export function ViewTabs({ active, localized }: { active: "dashboards" | "changelog"; localized: Localized }) {
  const navigation = useHostNavigation();
  const { settings, t } = localized;
  return (
    <nav className="jpd-tabs" aria-label={t("viewsLabel")}>
      <a {...navigation.linkProps("/dashboards")} className="jpd-tab" aria-current={active === "dashboards" ? "page" : undefined}>
        {settings.navLabel}
      </a>
      <a {...navigation.linkProps("/dashboards?view=changelog")} className="jpd-tab" aria-current={active === "changelog" ? "page" : undefined}>
        {settings.changelogTabLabel}
      </a>
    </nav>
  );
}
