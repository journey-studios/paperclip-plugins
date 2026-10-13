import { useMemo, useState, type ReactNode } from "react";
import { MarkdownBlock } from "@paperclipai/plugin-sdk/ui";
import type {
  Actor,
  Block,
  CalloutBlockSpec,
  DashboardSettings,
  DashboardSpec,
  KpisBlockSpec,
  Primitive,
  Section,
  StatusListBlockSpec,
  TableBlockSpec,
  TableColumn,
  Tone,
} from "../contracts.js";
import { getOwn } from "../keys.js";
import { safeHttpUrl } from "../safe-url.js";
import { computeFreshness } from "../status.js";
import { ChartView } from "./charts.js";
import type { Translate } from "./i18n.js";
import {
  buildToneMap,
  countBy,
  distinctValues,
  filterRows,
  mermaidFence,
  resolvePalette,
  resolveValue,
  seriesColorsFor,
  sortRows,
  toneFor,
  type Formatter,
} from "./model.js";

export interface ViewEnv {
  spec: DashboardSpec;
  settings: DashboardSettings;
  fmt: Formatter;
  t: Translate;
  dark: boolean;
  tones: Record<string, Tone>;
  palette: string[];
}

export function createEnv(spec: DashboardSpec, settings: DashboardSettings, fmt: Formatter, t: Translate, dark: boolean): ViewEnv {
  return {
    spec,
    settings,
    fmt,
    t,
    dark,
    tones: buildToneMap(settings, spec),
    palette: resolvePalette(settings.palette, dark),
  };
}

export function Md({ content }: { content: string }) {
  return (
    <div className="jpd-md">
      <MarkdownBlock content={content} />
    </div>
  );
}

export function StatusDot({ tone, label }: { tone: Tone; label: string }) {
  return (
    <svg className={`jpd-dot jpd-tone-${tone}`} viewBox="0 0 10 10" role="img" aria-label={label}>
      {tone === "muted" ? (
        <circle cx="5" cy="5" r="3.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      ) : tone === "warn" ? (
        <>
          <circle cx="5" cy="5" r="3.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M5 1.2 A3.8 3.8 0 0 0 5 8.8 Z" fill="currentColor" />
        </>
      ) : tone === "info" ? (
        <>
          <circle cx="5" cy="5" r="3.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="5" cy="5" r="1.6" fill="currentColor" />
        </>
      ) : (
        <circle cx="5" cy="5" r="4.2" fill="currentColor" />
      )}
    </svg>
  );
}

function toneLabel(tone: Tone, t: Translate): string {
  switch (tone) {
    case "ok":
      return t("toneOk");
    case "warn":
      return t("toneWarn");
    case "bad":
      return t("toneBad");
    case "info":
      return t("toneInfo");
    default:
      return t("toneMuted");
  }
}

const NUMERIC_FORMATS = ["int", "decimal", "pct", "currency", "duration"];

function Cell({ column, value, env }: { column: TableColumn; value: Primitive | undefined; env: ViewEnv }): ReactNode {
  const { fmt, tones, t } = env;
  const format = column.format ?? "raw";
  const text = value === null || value === undefined ? fmt.format(value) : String(value);
  switch (format) {
    case "status": {
      const tone = toneFor(value, tones);
      return (
        <span className="jpd-status">
          <StatusDot tone={tone} label={toneLabel(tone, t)} />
          {text}
        </span>
      );
    }
    case "priority":
      return <span className={`jpd-prio jpd-tone-${toneFor(value, tones)}`}>{text}</span>;
    case "date":
      return fmt.date(value);
    case "link": {
      const href = safeHttpUrl(value);
      return href ? (
        <a className="jpd-link" href={href} target="_blank" rel="noopener noreferrer">
          {text}
        </a>
      ) : (
        text
      );
    }
    case "code":
      return <code className="jpd-code">{text}</code>;
    case "muted":
      return <span className="jpd-muted">{text}</span>;
    case "strong":
      return <span className="jpd-strong">{text}</span>;
    default:
      return fmt.format(value, format === "raw" ? "raw" : format);
  }
}

const NOWRAP_FORMATS = ["date", "code", "status", "priority", ...NUMERIC_FORMATS];

function cellClass(column: TableColumn): string | undefined {
  const names = [
    column.wide ? "jpd-wide" : "",
    NUMERIC_FORMATS.includes(column.format ?? "") ? "jpd-num" : "",
    NOWRAP_FORMATS.includes(column.format ?? "") ? "jpd-nw" : "",
  ].filter(Boolean);
  return names.length > 0 ? names.join(" ") : undefined;
}

function TableView({ block, env }: { block: TableBlockSpec; env: ViewEnv }) {
  const { spec, t, fmt } = env;
  const dataset = getOwn(spec.datasets, block.dataset);
  const [chip, setChip] = useState<string | null>(null);
  const [selects, setSelects] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const rows = dataset?.rows ?? [];
  const sorted = useMemo(() => sortRows(rows, block.sort, fmt.locale), [rows, block.sort, fmt.locale]);
  const searchFields = block.columns.map((column) => column.field);
  const chipField = block.filters?.chips;
  const visible = useMemo(
    () =>
      filterRows(sorted, {
        chip: chipField && chip !== null ? { field: chipField, value: chip } : null,
        selects,
        search,
        searchFields,
      }),
    [sorted, chipField, chip, selects, search, searchFields],
  );
  // Chip counts reflect the other active filters so they stay honest.
  const forChips = useMemo(
    () => filterRows(sorted, { selects, search, searchFields }),
    [sorted, selects, search, searchFields],
  );
  const filtered = Boolean(block.filters && (block.filters.chips || block.filters.selects?.length || block.filters.search));
  const labelOf = (field: string) => block.columns.find((column) => column.field === field)?.label ?? field;

  return (
    <div className="jpd-table-wrap">
      {filtered ? (
        <div className="jpd-tools">
          {chipField ? (
            <>
              <button type="button" className="jpd-chip" aria-pressed={chip === null} onClick={() => setChip(null)}>
                {t("allFilter")} <span className="jpd-chip-count">{forChips.length}</span>
              </button>
              {countBy(forChips, chipField).map((item) => (
                <button
                  type="button"
                  key={item.value}
                  className="jpd-chip"
                  aria-pressed={chip === item.value}
                  onClick={() => setChip(chip === item.value ? null : item.value)}
                >
                  {item.value || fmt.format(null)} <span className="jpd-chip-count">{item.count}</span>
                </button>
              ))}
            </>
          ) : null}
          {(block.filters?.selects ?? []).map((field) => (
            <select
              key={field}
              className="jpd-field"
              aria-label={labelOf(field)}
              value={selects[field] ?? ""}
              onChange={(event) => setSelects({ ...selects, [field]: event.target.value })}
            >
              <option value="">{t("allOf", { label: labelOf(field) })}</option>
              {distinctValues(rows, field).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          ))}
          {block.filters?.search ? (
            <input
              type="search"
              className="jpd-field"
              aria-label={t("search")}
              placeholder={t("searchPlaceholder")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          ) : null}
          <span className="jpd-count">{t("shownOf", { shown: visible.length, total: rows.length })}</span>
        </div>
      ) : null}
      {visible.length === 0 ? (
        <div className="jpd-empty">{block.emptyText ?? t("noRows")}</div>
      ) : (
        <div className="jpd-scroll">
          <table className="jpd-table jpd-collapse">
            <thead>
              <tr>
                {block.columns.map((column) => (
                  <th key={column.field} className={NUMERIC_FORMATS.includes(column.format ?? "") ? "jpd-num" : undefined} scope="col">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row, index) => (
                <tr key={`${String(getOwn(row, block.rowKey))}-${index}`}>
                  {block.columns.map((column) => (
                    <td
                      key={column.field}
                      data-label={column.label}
                      className={cellClass(column)}
                    >
                      <Cell column={column} value={getOwn(row, column.field)} env={env} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function KpisView({ block, env }: { block: KpisBlockSpec; env: ViewEnv }) {
  const { spec, fmt, t } = env;
  return (
    <div className="jpd-kpis">
      {block.items.map((item, index) => {
        const value = resolveValue(item.value, spec.datasets);
        const of = item.of === undefined ? undefined : resolveValue(item.of, spec.datasets);
        return (
          <div className="jpd-card jpd-kpi" key={`${item.label}-${index}`}>
            <div className="jpd-kpi-label">{item.label}</div>
            <div className={`jpd-kpi-value${item.tone ? ` jpd-tone-${item.tone}` : ""}`}>
              {fmt.format(value, item.format)}
              {of !== undefined ? (
                <span className="jpd-kpi-of">
                  {" "}
                  {t("of")} {fmt.format(of, item.format)}
                </span>
              ) : null}
            </div>
            {item.caption ? <div className="jpd-kpi-caption">{item.caption}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

function StatusListView({ block, env }: { block: StatusListBlockSpec; env: ViewEnv }) {
  const { spec, fmt, tones, t } = env;
  const rows = getOwn(spec.datasets, block.dataset)?.rows ?? [];
  return (
    <ul className="jpd-statuslist">
      {rows.map((row, index) => {
        const tone = toneFor(getOwn(row, block.statusField), tones);
        return (
          <li className="jpd-statusitem" key={`${String(getOwn(row, block.labelField))}-${index}`}>
            <div className="jpd-statusitem-top">
              <span className="jpd-statusitem-name">{fmt.format(getOwn(row, block.labelField))}</span>
              <StatusDot tone={tone} label={`${String(getOwn(row, block.statusField) ?? "")} (${toneLabel(tone, t)})`} />
            </div>
            <div className="jpd-statusitem-value">{fmt.format(getOwn(row, block.valueField), block.format)}</div>
            {block.detailField ? <div className="jpd-card-note">{fmt.format(getOwn(row, block.detailField))}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}

function CalloutView({ block }: { block: CalloutBlockSpec }) {
  return (
    <div className={`jpd-callout jpd-tone-${block.tone}`}>
      <Md content={block.content} />
    </div>
  );
}

function BlockBody({ block, env }: { block: Block; env: ViewEnv }) {
  switch (block.type) {
    case "markdown":
      return <Md content={block.content} />;
    case "mermaid":
      return <Md content={mermaidFence(block.code)} />;
    case "callout":
      return <CalloutView block={block} />;
    case "kpis":
      return <KpisView block={block} env={env} />;
    case "table":
      return <TableView block={block} env={env} />;
    case "statusList":
      return <StatusListView block={block} env={env} />;
    case "chart": {
      const dataset = getOwn(env.spec.datasets, block.dataset);
      const categorical = block.chart === "donut" || block.chart === "progress";
      const colors = categorical
        ? env.palette
        : seriesColorsFor(typeof block.y === "string" ? [block.y] : block.y, block.seriesColors, env.tones, env.palette, env.dark);
      return dataset ? <ChartView block={block} dataset={dataset} fmt={env.fmt} palette={colors} t={env.t} /> : null;
    }
    default:
      return null;
  }
}

function BlockView({ block, env, cols }: { block: Block; env: ViewEnv; cols: number }) {
  const span = Math.min(block.span ?? 1, cols);
  const bare = block.type === "kpis" || block.type === "callout";
  const header = (
    <>
      {block.title ? <h3 className="jpd-card-title">{block.title}</h3> : null}
      {block.note ? (
        <div className="jpd-card-note">
          <Md content={block.note} />
        </div>
      ) : null}
    </>
  );
  return (
    <div data-span={span > 1 ? span : undefined} className={bare ? "jpd-bare" : "jpd-card"} style={bare ? { display: "grid", gap: 12, minWidth: 0 } : undefined}>
      {header}
      <BlockBody block={block} env={env} />
    </div>
  );
}

function SectionView({ section, env }: { section: Section; env: ViewEnv }) {
  const cols = section.columns ?? 1;
  return (
    <section className="jpd-section" aria-label={section.title ?? section.id}>
      {section.title ? <h2 className="jpd-h2">{section.title}</h2> : null}
      {section.note ? (
        <div className="jpd-note">
          <Md content={section.note} />
        </div>
      ) : null}
      <div className="jpd-grid" data-cols={cols > 1 ? cols : undefined}>
        {section.blocks.map((block, index) => (
          <BlockView key={block.id ?? `${section.id}-${index}`} block={block} env={env} cols={cols} />
        ))}
      </div>
    </section>
  );
}

function SourcesPanel({ env, stale }: { env: ViewEnv; stale: Set<string> }) {
  const { spec, t, fmt } = env;
  const entries = Object.entries(spec.datasets);
  if (entries.length === 0) {
    return null;
  }
  return (
    <details className="jpd-sources">
      <summary>{t("sources")}</summary>
      <div className="jpd-sources-body">
        <div className="jpd-card-note">{t("sourcesHint")}</div>
        {entries.map(([id, dataset]) => {
          const href = safeHttpUrl(dataset.source);
          return (
            <div className="jpd-source" key={id}>
              <div className="jpd-source-title">
                {dataset.title}
                {stale.has(id) ? (
                  <span className="jpd-badge-stale">
                    {t("staleBadge")}
                    {dataset.updatedAt ? ` \u00b7 ${fmt.relative(dataset.updatedAt)}` : ""}
                  </span>
                ) : null}
              </div>
              {dataset.description ? <div className="jpd-source-line">{dataset.description}</div> : null}
              <div className="jpd-source-line">
                {t("sourceOrigin")}:{" "}
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {dataset.source}
                  </a>
                ) : (
                  (dataset.source ?? t("sourceUnknown"))
                )}
              </div>
              <div className="jpd-source-line">
                {t("sourceUpdated")}: {dataset.updatedAt ? fmt.dateTime(dataset.updatedAt) : t("sourceUnknown")} {"·"}{" "}
                {t("sourceRows", { count: fmt.format(dataset.rows.length, "int") })}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

export function actorLabel(actor: Actor, t: Translate): string {
  if (actor.kind === "agent") {
    return actor.name ? t("byAgent", { name: actor.name }) : t("byAgentUnknown");
  }
  return actor.kind === "user" ? t("byUser") : t("bySystem");
}

export function DashboardView({
  env,
  revision,
  updatedAt,
  updatedBy,
  headerExtra,
  footer,
}: {
  env: ViewEnv;
  revision: number;
  updatedAt: string;
  updatedBy: Actor;
  headerExtra?: ReactNode;
  footer?: ReactNode;
}) {
  const { spec, t, fmt } = env;
  const freshness = useMemo(() => computeFreshness(spec, env.settings, new Date()), [spec, env.settings]);
  const stale = useMemo(() => new Set(freshness.datasets.filter((dataset) => dataset.stale).map((dataset) => dataset.id)), [freshness]);
  return (
    <article className="jpd-page">
      <header className="jpd-head">
        <h1 className="jpd-title">{spec.title}</h1>
        {spec.summary ? (
          <div className="jpd-summary">
            <Md content={spec.summary} />
          </div>
        ) : null}
        <div className="jpd-meta">
          <p>
            {t("metaLine", {
              revision,
              when: fmt.relative(updatedAt),
              who: actorLabel(updatedBy, t),
            })}
          </p>
          {spec.meta ? <Md content={spec.meta} /> : null}
        </div>
        {freshness.staleCount > 0 ? (
          <div className="jpd-stale-banner jpd-tone-warn" role="status">
            {freshness.staleCount === 1 ? t("staleSourcesOne") : t("staleSourcesMany", { count: freshness.staleCount })}
          </div>
        ) : null}
        {headerExtra}
      </header>
      {spec.sections.map((section) => (
        <SectionView key={section.id} section={section} env={env} />
      ))}
      <SourcesPanel env={env} stale={stale} />
      {footer}
    </article>
  );
}
