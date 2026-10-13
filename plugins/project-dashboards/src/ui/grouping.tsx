import { useState, type ReactNode } from "react";
import { ProjectPicker, copyTextToClipboard, useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import type { DashboardSummary } from "../contracts.js";
import type { Translate } from "./i18n.js";
import { groupDashboards } from "./model.js";
import type { Localized } from "./shared.js";
import { actorLabel } from "./view.js";

type LinkProps = ReturnType<ReturnType<typeof useHostNavigation>["linkProps"]>;

/** Route segment of a project page; the host resolves the company prefix. */
export function projectPath(project: { projectId: string; urlKey: string | null }): string {
  return `/projects/${encodeURIComponent(project.urlKey ?? project.projectId)}`;
}

export function MoveControl({
  companyId,
  dashboardId,
  t,
  onMoved,
}: {
  companyId: string;
  dashboardId: string;
  t: Translate;
  onMoved: () => void;
}) {
  const move = usePluginAction("dashboard.setProject");
  const [error, setError] = useState<string | null>(null);
  const run = async (projectId: string) => {
    if (!projectId) {
      return;
    }
    try {
      await move({ companyId, id: dashboardId, projectId });
      setError(null);
      onMoved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <span className="jpd-move">
      <ProjectPicker
        companyId={companyId}
        value=""
        onChange={(projectId) => void run(projectId)}
        placeholder={t("moveToProject")}
        noneLabel={t("moveToProject")}
      />
      {error ? (
        <span className="jpd-error" role="alert">
          {t("moveFailed", { message: error })}
        </span>
      ) : null}
    </span>
  );
}

function countLabel(count: number, t: Translate): string {
  return count === 1 ? t("dashboardsOne") : t("dashboardsMany", { count });
}

function ItemMeta({ item, localized }: { item: DashboardSummary; localized: Localized }) {
  const { t, fmt } = localized;
  return (
    <span className="jpd-item-sub">
      {t("metaLine", { revision: item.revision, when: fmt.relative(item.updatedAt), who: actorLabel(item.updatedBy, t) })}
    </span>
  );
}

/** Dashboards grouped by project, with projectless ones in their own collapsible area below a divider. */
export function GroupedList({
  items,
  companyId,
  localized,
  dashboardLink,
  projectLink,
  onMoved,
}: {
  items: DashboardSummary[];
  companyId: string;
  localized: Localized;
  dashboardLink: (item: DashboardSummary) => LinkProps;
  projectLink: (path: string) => LinkProps;
  onMoved: () => void;
}): ReactNode {
  const { t, fmt } = localized;
  const groups = groupDashboards(items, fmt.locale);
  return (
    <div className="jpd-list">
      {groups.projects.map((group) => (
        <section className="jpd-group" key={group.projectId} aria-label={group.name}>
          <h2 className="jpd-group-title">
            <a className="jpd-project-link" {...projectLink(projectPath(group))}>
              {group.name}
            </a>
            <span className="jpd-group-count">{countLabel(group.items.length, t)}</span>
          </h2>
          <div className="jpd-items">
            {group.items.map((item) => (
              <a key={item.id} className="jpd-item" {...dashboardLink(item)}>
                <span className="jpd-item-title">{item.title}</span>
                <ItemMeta item={item} localized={localized} />
              </a>
            ))}
          </div>
        </section>
      ))}
      {groups.orphans.length > 0 ? (
        <>
          <hr className="jpd-divider" />
          <details className="jpd-orphans" open>
            <summary>
              <span className="jpd-group-title">{t("noProject")}</span>
              <span className="jpd-group-count">{countLabel(groups.orphans.length, t)}</span>
            </summary>
            <p className="jpd-note">{t("noProjectHint")}</p>
            <div className="jpd-items">
              {groups.orphans.map((item) => (
                <div key={item.id} className="jpd-item jpd-item-orphan">
                  <a className="jpd-item-link" {...dashboardLink(item)}>
                    <span className="jpd-item-title">{item.title}</span>
                  </a>
                  <ItemMeta item={item} localized={localized} />
                  <MoveControl companyId={companyId} dashboardId={item.id} t={t} onMoved={onMoved} />
                </div>
              ))}
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}

/** Project line of the viewer header: a link to the project, or a warning with the move control. */
export function ProjectLine({
  record,
  companyId,
  localized,
  projectLink,
  onMoved,
}: {
  record: Pick<DashboardSummary, "id" | "projectId" | "projectName" | "projectUrlKey">;
  companyId: string;
  localized: Localized;
  projectLink: (path: string) => LinkProps;
  onMoved: () => void;
}): ReactNode {
  const { t } = localized;
  if (record.projectId === null) {
    return (
      <div className="jpd-orphan-warning jpd-tone-warn" role="status">
        <span>{t("orphanWarning")}</span>
        <MoveControl companyId={companyId} dashboardId={record.id} t={t} onMoved={onMoved} />
      </div>
    );
  }
  return (
    <div className="jpd-project-line">
      <span className="jpd-muted">{t("projectLine")}</span>{" "}
      <a className="jpd-project-link" {...projectLink(projectPath({ projectId: record.projectId, urlKey: record.projectUrlKey }))}>
        {record.projectName ?? record.projectId}
      </a>
    </div>
  );
}

/** Empty state of a project tab: how dashboards get created, with the copyable project ID. */
export function ProjectEmpty({ projectId, localized }: { projectId: string | null; localized: Localized }): ReactNode {
  const { t } = localized;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!projectId) {
      return;
    }
    try {
      await copyTextToClipboard(projectId);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="jpd-state">
      <strong>{t("emptyTitle")}</strong>
      <span>{t("emptyProject")}</span>
      {projectId ? (
        <span className="jpd-tools">
          <span className="jpd-muted">{t("projectIdLabel")}</span>
          <code className="jpd-code">{projectId}</code>
          <button type="button" className="jpd-btn" onClick={() => void copy()}>
            {copied ? t("projectIdCopied") : t("copyProjectId")}
          </button>
        </span>
      ) : null}
    </div>
  );
}
