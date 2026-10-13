import { useEffect, useMemo, useRef, useState } from "react";
import {
  copyTextToClipboard,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  usePluginData,
  type PluginDetailTabProps,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import type { DashboardRecord, DashboardSettings, DashboardSummary, LiveStatus, RevisionSummary } from "../contracts.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import { ChangelogTimeline, CompanyChangelog, ViewTabs } from "./changelog.js";
import { GroupedList, ProjectEmpty, ProjectLine } from "./grouping.js";
import { createTranslator, type Translate } from "./i18n.js";
import { formatterFor, type Formatter } from "./model.js";
import { State, usePolling, type Localized } from "./shared.js";
import { styles } from "./styles.js";
import { DashboardView, actorLabel, createEnv } from "./view.js";

function useIsDark(): boolean {
  const read = () => typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const [dark, setDark] = useState(read);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") {
      return undefined;
    }
    const observer = new MutationObserver(() => setDark(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

function LiveIndicator({ seconds, checkedAt, t }: { seconds: number; checkedAt: number; t: Translate }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (seconds <= 0) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [seconds]);
  if (seconds <= 0) {
    return (
      <span className="jpd-live-off">
        <span className="jpd-live-dot" aria-hidden="true" />
        {t("liveOff")}
      </span>
    );
  }
  return (
    <span>
      <span className="jpd-live-dot" aria-hidden="true" />
      {t("liveOn", { seconds: Math.max(0, Math.floor((now - checkedAt) / 1000)) })}
    </span>
  );
}

function useLocalized(companyId: string | null): Localized {
  const query = usePluginData<DashboardSettings>("settings.get", { companyId });
  const settings = query.data ?? DEFAULT_SETTINGS;
  return useMemo(
    () => ({ settings, t: createTranslator(settings.locale), fmt: formatterFor(settings) }),
    [settings],
  );
}

function Icon() {
  return (
    <svg className="jpd-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="1.75" y="1.75" width="5" height="5" rx="1" />
      <rect x="9.25" y="1.75" width="5" height="3" rx="1" />
      <rect x="9.25" y="7.25" width="5" height="7" rx="1" />
      <rect x="1.75" y="9.75" width="5" height="4.5" rx="1" />
    </svg>
  );
}

export function SidebarLink({ context }: PluginSidebarProps) {
  const navigation = useHostNavigation();
  const { settings } = useLocalized(context.companyId);
  return (
    <div className="jpd">
      <style>{styles}</style>
      <a {...navigation.linkProps("/dashboards")} className="jpd-nav">
        <Icon />
        {settings.navLabel}
      </a>
    </div>
  );
}

function History({ record, companyId, t, fmt, onDone }: { record: DashboardRecord; companyId: string; t: Translate; fmt: Formatter; onDone: () => void }) {
  const revisions = usePluginData<RevisionSummary[]>("dashboard.revisions", { companyId, id: record.id });
  const restore = usePluginAction("dashboard.restoreRevision");
  const [error, setError] = useState<string | null>(null);
  const run = async (revision: number) => {
    if (!window.confirm(t("restoreConfirm", { revision }))) {
      return;
    }
    try {
      await restore({ companyId, id: record.id, revision });
      setError(null);
      revisions.refresh();
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <div className="jpd-history">
      {error ? <div className="jpd-error">{t("actionFailed", { message: error })}</div> : null}
      {(revisions.data ?? []).map((item) => (
        <div className="jpd-history-row" key={item.revision}>
          <span>
            #{item.revision} {"·"} {fmt.dateTime(item.createdAt)} {"·"} {actorLabel(item.updatedBy, t)}
          </span>
          {item.revision !== record.revision ? (
            <button type="button" className="jpd-btn" onClick={() => void run(item.revision)}>
              {t("restore")}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function Manage({ record, companyId, t, fmt, onChanged, onDeleted }: { record: DashboardRecord; companyId: string; t: Translate; fmt: Formatter; onChanged: () => void; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const remove = usePluginAction("dashboard.delete");
  const [error, setError] = useState<string | null>(null);
  const destroy = async () => {
    if (!window.confirm(t("removeConfirm"))) {
      return;
    }
    try {
      await remove({ companyId, id: record.id });
      onDeleted();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <details className="jpd-sources" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t("history")}</summary>
      <div className="jpd-sources-body">
        {open ? <History record={record} companyId={companyId} t={t} fmt={fmt} onDone={onChanged} /> : null}
        {error ? <div className="jpd-error">{t("actionFailed", { message: error })}</div> : null}
        <div>
          <button type="button" className="jpd-btn jpd-btn-danger" onClick={() => void destroy()}>
            {t("remove")}
          </button>
        </div>
      </div>
    </details>
  );
}

function DashboardLoader({
  companyId,
  lookup,
  localized,
  onDeleted,
  onMoved,
}: {
  companyId: string;
  lookup: { id: string } | { slug: string };
  localized: Localized;
  onDeleted: () => void;
  onMoved?: () => void;
}) {
  const { settings, t, fmt } = localized;
  const navigation = useHostNavigation();
  const dark = useIsDark();
  const query = usePluginData<DashboardRecord | null>("dashboard.get", { companyId, ...lookup });
  const status = usePluginData<LiveStatus | null>("dashboard.status", { companyId, ...lookup });
  const record = query.data;
  const env = useMemo(
    () => (record?.spec ? createEnv(record.spec, settings, fmt, t, dark) : null),
    [record, settings, fmt, t, dark],
  );
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const [notice, setNotice] = useState<number | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");

  // Cheap status poll; the full record is refetched only when it changed.
  usePolling(settings.refreshIntervalSeconds, () => {
    status.refresh();
    setCheckedAt(Date.now());
  });
  const refreshedFor = useRef("");
  const liveStatus = status.data;
  const refreshRecord = query.refresh;
  useEffect(() => {
    if (!liveStatus || !record) {
      return;
    }
    if (liveStatus.revision !== record.revision || liveStatus.updatedAt !== record.updatedAt) {
      const key = `${liveStatus.revision}|${liveStatus.updatedAt}`;
      if (refreshedFor.current !== key) {
        refreshedFor.current = key;
        refreshRecord();
      }
    }
  }, [liveStatus, record, refreshRecord]);

  const shownRevision = record?.revision ?? null;
  const previousRevision = useRef<number | null>(null);
  useEffect(() => {
    const previous = previousRevision.current;
    previousRevision.current = shownRevision;
    if (previous === null || shownRevision === null || shownRevision <= previous) {
      return undefined;
    }
    setNotice(shownRevision);
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [shownRevision]);
  useEffect(() => {
    if (copyState === "idle") {
      return undefined;
    }
    const timer = setTimeout(() => setCopyState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [copyState]);

  const copyLink = async () => {
    if (!record) {
      return;
    }
    const href = navigation.resolveHref(`/dashboards?d=${encodeURIComponent(record.slug)}`);
    try {
      await copyTextToClipboard(`${window.location.origin}${href}`);
      setCopyState("ok");
    } catch {
      setCopyState("fail");
    }
  };
  if (query.error) {
    return <State title={t("loadError", { message: query.error.message })} />;
  }
  if (query.loading && !record) {
    return <State title={t("loading")} />;
  }
  if (!record) {
    return <State title={t("notFound")} />;
  }
  if (!env) {
    return <State title={t("invalidStored")} body={record.specErrors.join("\n")} />;
  }
  return (
    <DashboardView
      env={env}
      revision={record.revision}
      updatedAt={record.updatedAt}
      updatedBy={record.updatedBy}
      headerExtra={
        <>
          <ProjectLine
            record={record}
            companyId={companyId}
            localized={localized}
            projectLink={(path) => navigation.linkProps(path)}
            onMoved={() => {
              query.refresh();
              status.refresh();
              onMoved?.();
            }}
          />
          <div className="jpd-live">
          <LiveIndicator seconds={settings.refreshIntervalSeconds} checkedAt={checkedAt} t={t} />
          {notice !== null ? (
            <span className="jpd-notice" role="status">
              {t("updatedNotice", { revision: notice })}
            </span>
          ) : null}
          </div>
        </>
      }
      footer={
        <>
          <div className="jpd-bar-row">
            <span className="jpd-tools">
              <button type="button" className="jpd-btn" onClick={query.refresh}>
                {t("refresh")}
              </button>
              <button type="button" className="jpd-btn" onClick={() => void copyLink()}>
                {t("copyLink")}
              </button>
              {copyState !== "idle" ? (
                <span role="status" className={copyState === "fail" ? "jpd-error" : "jpd-muted"}>
                  {copyState === "ok" ? t("linkCopied") : t("linkCopyFailed")}
                </span>
              ) : null}
            </span>
          </div>
          <Manage record={record} companyId={companyId} t={t} fmt={fmt} onChanged={query.refresh} onDeleted={onDeleted} />
        </>
      }
    />
  );
}

export function DashboardsPage({ context }: PluginPageProps) {
  const navigation = useHostNavigation();
  const location = useHostLocation();
  const localized = useLocalized(context.companyId);
  const { settings, t } = localized;
  const params = new URLSearchParams(location.search);
  const slug = params.get("d");
  // A dashboard link (?d=) always wins over the view switch.
  const changelogView = !slug && params.get("view") === "changelog";
  const list = usePluginData<DashboardSummary[]>("dashboards.list", { companyId: context.companyId });
  usePolling(settings.refreshIntervalSeconds, () => {
    if (!slug && !changelogView) {
      list.refresh();
    }
  });

  let body;
  if (!context.companyId) {
    body = <State title={t("notFound")} />;
  } else if (slug) {
    body = (
      <>
        <a {...navigation.linkProps("/dashboards")} className="jpd-btn" style={{ justifySelf: "start", textDecoration: "none" }}>
          {"←"} {t("backToList")}
        </a>
        <DashboardLoader
          key={slug}
          companyId={context.companyId}
          lookup={{ slug }}
          localized={localized}
          onDeleted={() => navigation.navigate("/dashboards")}
        />
      </>
    );
  } else if (changelogView) {
    body = <CompanyChangelog companyId={context.companyId} localized={localized} />;
  } else if (list.error) {
    body = <State title={t("loadError", { message: list.error.message })} />;
  } else if (list.loading && !list.data) {
    body = <State title={t("loading")} />;
  } else if ((list.data ?? []).length === 0) {
    body = <State title={t("emptyTitle")} body={t("emptyBody")} />;
  } else {
    body = (
      <GroupedList
        items={list.data ?? []}
        companyId={context.companyId}
        localized={localized}
        dashboardLink={(item) => navigation.linkProps(`/dashboards?d=${encodeURIComponent(item.slug)}`)}
        projectLink={(path) => navigation.linkProps(path)}
        onMoved={list.refresh}
      />
    );
  }
  return (
    <div className="jpd" style={{ display: "grid", gap: 16, padding: 16 }}>
      <style>{styles}</style>
      {!slug ? <h1 className="jpd-title">{settings.navLabel}</h1> : null}
      {!slug && context.companyId ? <ViewTabs active={changelogView ? "changelog" : "dashboards"} localized={localized} /> : null}
      {body}
    </div>
  );
}

export function ProjectDashboardTab({ context }: PluginDetailTabProps) {
  const localized = useLocalized(context.companyId);
  const { t, settings } = localized;
  const list = usePluginData<DashboardSummary[]>("dashboards.list", {
    companyId: context.companyId,
    projectId: context.entityId,
  });
  usePolling(settings.refreshIntervalSeconds, list.refresh);
  const [selected, setSelected] = useState<string | null>(null);
  const items = list.data ?? [];
  const current = items.find((item) => item.id === selected) ?? items[0];

  let body;
  if (!context.companyId) {
    body = <State title={t("notFound")} />;
  } else if (list.error) {
    body = <State title={t("loadError", { message: list.error.message })} />;
  } else if (list.loading && !list.data) {
    body = <State title={t("loading")} />;
  } else if (!current) {
    body = <ProjectEmpty projectId={context.entityId} localized={localized} />;
  } else {
    body = (
      <>
        {items.length > 1 ? (
          <label className="jpd-tools">
            <span className="jpd-muted">{t("selectDashboard")}</span>
            <select className="jpd-field" value={current.id} onChange={(event) => setSelected(event.target.value)}>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <DashboardLoader
          key={current.id}
          companyId={context.companyId}
          lookup={{ id: current.id }}
          localized={localized}
          onDeleted={() => {
            setSelected(null);
            list.refresh();
          }}
          onMoved={list.refresh}
        />
      </>
    );
  }
  return (
    <div className="jpd" style={{ display: "grid", gap: 16, padding: 16 }}>
      <style>{styles}</style>
      <h2 className="jpd-h2">{settings.projectTabLabel}</h2>
      {body}
    </div>
  );
}

export function ProjectChangelogTab({ context }: PluginDetailTabProps) {
  const localized = useLocalized(context.companyId);
  const { t, settings } = localized;
  return (
    <div className="jpd" style={{ display: "grid", gap: 16, padding: 16 }}>
      <style>{styles}</style>
      <h2 className="jpd-h2">{settings.changelogTabLabel}</h2>
      {context.companyId ? (
        <ChangelogTimeline companyId={context.companyId} projectId={context.entityId} localized={localized} showProject={false} allowImport />
      ) : (
        <State title={t("changelogNoCompany")} />
      )}
    </div>
  );
}
