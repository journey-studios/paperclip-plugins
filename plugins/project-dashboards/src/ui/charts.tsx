import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { getOwn } from "../keys.js";
import type { ChartBlockSpec, Dataset, Format } from "../contracts.js";
import type { Translate } from "./i18n.js";
import { buildSeries, niceScale, stackedTotals, type Formatter, type Series, type SeriesData } from "./model.js";

interface ChartProps {
  block: ChartBlockSpec;
  dataset: Dataset;
  fmt: Formatter;
  palette: string[];
  t: Translate;
}

const DEFAULT_WIDTH = 560;
const CHAR_WIDTH = 6.4;

function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (next > 0) {
        setWidth(next);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

interface Hover {
  index: number;
  x: number;
  y: number;
}

function Tooltip({
  hover,
  width,
  data,
  extra,
  palette,
  fmt,
  format,
  total,
  t,
}: {
  hover: Hover;
  width: number;
  data: SeriesData;
  extra: string[];
  palette: string[];
  fmt: Formatter;
  format: Format | undefined;
  total: boolean;
  t: Translate;
}) {
  const row = data.rows[hover.index];
  const left = Math.max(0, Math.min(hover.x + 12, width - 200));
  const top = Math.max(0, hover.y - 8);
  return (
    <div className="jpd-tooltip" style={{ left, top, transform: top < 70 ? "none" : "translateY(-100%)" }} role="status">
      <div className="jpd-tooltip-title">{data.categories[hover.index]}</div>
      {data.series.map((series, index) => (
        <div className="jpd-tooltip-row" key={series.key}>
          <span>
            <span className="jpd-swatch" style={{ background: palette[index % palette.length], display: "inline-block", marginRight: 6 }} />
            {series.label}
          </span>
          <span>{fmt.format(series.values[hover.index], format)}</span>
        </div>
      ))}
      {total && data.series.length > 1 ? (
        <div className="jpd-tooltip-row">
          <span>{t("total")}</span>
          <span>{fmt.format(stackedTotals(data.series, data.categories.length)[hover.index], format)}</span>
        </div>
      ) : null}
      {extra.map((field) => (
        <div className="jpd-tooltip-row" key={field}>
          <span>{field}</span>
          <span>{fmt.format(row ? getOwn(row, field) : undefined)}</span>
        </div>
      ))}
    </div>
  );
}

function Legend({ series, palette }: { series: Series[]; palette: string[] }) {
  if (series.length < 2) {
    return null;
  }
  return (
    <ul className="jpd-legend">
      {series.map((item, index) => (
        <li key={item.key}>
          <span className="jpd-swatch" style={{ background: palette[index % palette.length] }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function DataTable({ data, fmt, format, t, title }: { data: SeriesData; fmt: Formatter; format: Format | undefined; t: Translate; title: string }) {
  return (
    <table className="jpd-sr">
      <caption>{title || t("chartData")}</caption>
      <thead>
        <tr>
          <th scope="col" />
          {data.series.map((series) => (
            <th scope="col" key={series.key}>
              {series.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.categories.map((category, index) => (
          <tr key={`${category}-${index}`}>
            <th scope="row">{category}</th>
            {data.series.map((series) => (
              <td key={series.key}>{fmt.format(series.values[index], format)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ariaSummary(data: SeriesData, fmt: Formatter, format: Format | undefined, title: string): string {
  const parts = data.categories.slice(0, 12).map((category, index) => {
    const values = data.series.map((series) => `${series.label} ${fmt.format(series.values[index], format)}`).join(", ");
    return `${category}: ${values}`;
  });
  return `${title ? `${title}. ` : ""}${parts.join("; ")}${data.categories.length > 12 ? "…" : ""}`;
}

function Frame({
  block,
  children,
  legend,
  data,
  fmt,
  t,
}: {
  block: ChartBlockSpec;
  children: ReactNode;
  legend: ReactNode;
  data: SeriesData;
  fmt: Formatter;
  t: Translate;
}) {
  return (
    <>
      {children}
      {legend}
      <DataTable data={data} fmt={fmt} format={block.format} t={t} title={block.title ?? ""} />
    </>
  );
}

/* ---------------------------------------------------------------- cartesian */

function Cartesian({ block, dataset, fmt, palette, t }: ChartProps) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  const data = useMemo(() => buildSeries(dataset.rows, block.x, block.y, block.seriesLabels), [dataset, block]);
  const kind = block.chart;
  const stacked = kind === "stackedBar";
  const n = data.categories.length;
  const height = 240;
  const totals = stackedTotals(data.series, n);
  const highest = Math.max(
    0,
    block.goal ?? 0,
    ...(stacked ? totals : data.series.flatMap((series) => series.values)),
  );
  const lowest = Math.min(0, ...data.series.flatMap((series) => series.values));
  const scale = niceScale(lowest, highest);
  const labels = scale.ticks.map((tick) => fmt.tick(tick, block.format));
  const left = Math.max(...labels.map((label) => label.length), 2) * CHAR_WIDTH + 12;
  const margin = { l: left, r: 8, t: 10, b: 30 };
  const plotW = Math.max(40, width - margin.l - margin.r);
  const plotH = height - margin.t - margin.b;
  const band = plotW / Math.max(1, n);
  const yOf = (value: number) => margin.t + plotH - ((value - scale.min) / (scale.max - scale.min || 1)) * plotH;
  const zero = yOf(0);
  const maxLabel = Math.max(1, Math.floor(band / CHAR_WIDTH));
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / (Math.min(14, Math.max(...data.categories.map((c) => c.length), 1)) * CHAR_WIDTH + 10)))));

  const setFromPointer = (index: number, event: MouseEvent<SVGElement>) => {
    const box = ref.current?.getBoundingClientRect();
    setHover({ index, x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) });
  };
  const setFromFocus = (index: number) => setHover({ index, x: margin.l + band * index + band / 2, y: margin.t + 20 });

  const grouped = !stacked && (kind === "bar") ? data.series.length : 1;
  const barW = Math.max(2, (band * 0.72) / grouped);

  const linePath = (series: Series) =>
    series.values.map((value, index) => `${index === 0 ? "M" : "L"}${margin.l + band * index + band / 2},${yOf(value)}`).join(" ");

  return (
    <div className="jpd-chart" ref={ref}>
      <Frame
        block={block}
        data={data}
        fmt={fmt}
        t={t}
        legend={<Legend series={data.series} palette={palette} />}
      >
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={ariaSummary(data, fmt, block.format, block.title ?? "")} onMouseLeave={() => setHover(null)}>
          {scale.ticks.map((tick, index) => (
            <g key={tick}>
              <line className="jpd-grid-line" x1={margin.l} x2={width - margin.r} y1={yOf(tick)} y2={yOf(tick)} />
              <text className="jpd-tick" x={margin.l - 6} y={yOf(tick)} textAnchor="end" dominantBaseline="middle">
                {labels[index]}
              </text>
            </g>
          ))}
          <line className="jpd-axis" x1={margin.l} x2={width - margin.r} y1={zero} y2={zero} />
          {block.goal !== undefined ? (
            <line x1={margin.l} x2={width - margin.r} y1={yOf(block.goal)} y2={yOf(block.goal)} stroke="currentColor" strokeDasharray="5 4" opacity={0.6} />
          ) : null}
          {kind === "bar" || kind === "stackedBar"
            ? data.categories.map((category, index) => {
                const x0 = margin.l + band * index + (band - barW * grouped) / 2;
                let stackBase = 0;
                return (
                  <g key={`${category}-${index}`} className={hover && hover.index !== index ? "jpd-bar-dim" : undefined}>
                    {data.series.map((series, seriesIndex) => {
                      const value = series.values[index] ?? 0;
                      const from = stacked ? stackBase : 0;
                      const to = stacked ? stackBase + value : value;
                      stackBase = to;
                      const y1 = yOf(Math.max(from, to));
                      const y2 = yOf(Math.min(from, to));
                      return (
                        <rect
                          key={series.key}
                          x={stacked ? margin.l + band * index + (band - barW) / 2 : x0 + seriesIndex * barW}
                          y={y1}
                          width={Math.max(1, barW - (grouped > 1 ? 2 : 0))}
                          height={Math.max(0, y2 - y1)}
                          rx={2}
                          fill={palette[seriesIndex % palette.length]}
                        />
                      );
                    })}
                  </g>
                );
              })
            : data.series.map((series, seriesIndex) => (
                <g key={series.key}>
                  {kind === "area" ? (
                    <path
                      d={`${linePath(series)} L${margin.l + band * (n - 1) + band / 2},${zero} L${margin.l + band / 2},${zero} Z`}
                      fill={palette[seriesIndex % palette.length]}
                      opacity={0.18}
                    />
                  ) : null}
                  <path d={linePath(series)} fill="none" stroke={palette[seriesIndex % palette.length]} strokeWidth={2} strokeLinejoin="round" />
                  {series.values.map((value, index) => (
                    <circle key={index} cx={margin.l + band * index + band / 2} cy={yOf(value)} r={hover?.index === index ? 4.5 : 3} fill={palette[seriesIndex % palette.length]} />
                  ))}
                </g>
              ))}
          {data.categories.map((category, index) =>
            index % every === 0 ? (
              <text key={`${category}-${index}`} className="jpd-tick" x={margin.l + band * index + band / 2} y={height - 10} textAnchor="middle">
                {truncate(category, Math.max(4, Math.min(maxLabel * every, 16)))}
              </text>
            ) : null,
          )}
          {data.categories.map((category, index) => (
            <rect
              key={`hit-${category}-${index}`}
              className="jpd-bar"
              x={margin.l + band * index}
              y={margin.t}
              width={band}
              height={plotH}
              fill="transparent"
              tabIndex={0}
              aria-label={`${category}: ${data.series.map((series) => `${series.label} ${fmt.format(series.values[index], block.format)}`).join(", ")}`}
              onMouseMove={(event) => setFromPointer(index, event)}
              onFocus={() => setFromFocus(index)}
              onBlur={() => setHover(null)}
            />
          ))}
        </svg>
      </Frame>
      {hover ? <Tooltip hover={hover} width={width} data={data} extra={block.tooltip ?? []} palette={palette} fmt={fmt} format={block.format} total={stacked} t={t} /> : null}
    </div>
  );
}

/* --------------------------------------------------------------- horizontal */

function HorizontalBars({ block, dataset, fmt, palette, t }: ChartProps) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  const data = useMemo(() => buildSeries(dataset.rows, block.x, block.y, block.seriesLabels), [dataset, block]);
  const n = data.categories.length;
  const seriesCount = data.series.length;
  const rowH = seriesCount * 16 + 10;
  const height = Math.max(60, n * rowH + 28);
  const labelW = Math.min(width * 0.38, Math.max(...data.categories.map((c) => Math.min(c.length, 28)), 4) * CHAR_WIDTH + 12);
  const margin = { l: labelW, r: 56, t: 4, b: 22 };
  const plotW = Math.max(40, width - margin.l - margin.r);
  const highest = Math.max(0, block.goal ?? 0, ...data.series.flatMap((series) => series.values));
  const scale = niceScale(0, highest);
  const xOf = (value: number) => margin.l + (value / (scale.max || 1)) * plotW;
  const labelChars = Math.floor((labelW - 8) / CHAR_WIDTH);

  const setFromPointer = (index: number, event: MouseEvent<SVGElement>) => {
    const box = ref.current?.getBoundingClientRect();
    setHover({ index, x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) });
  };

  return (
    <div className="jpd-chart" ref={ref}>
      <Frame block={block} data={data} fmt={fmt} t={t} legend={<Legend series={data.series} palette={palette} />}>
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={ariaSummary(data, fmt, block.format, block.title ?? "")} onMouseLeave={() => setHover(null)}>
          {scale.ticks.map((tick) => (
            <g key={tick}>
              <line className="jpd-grid-line" x1={xOf(tick)} x2={xOf(tick)} y1={margin.t} y2={height - margin.b} />
              <text className="jpd-tick" x={xOf(tick)} y={height - 6} textAnchor="middle">
                {fmt.tick(tick, block.format)}
              </text>
            </g>
          ))}
          {data.categories.map((category, index) => {
            const y0 = margin.t + index * rowH;
            return (
              <g key={`${category}-${index}`} className={hover && hover.index !== index ? "jpd-bar-dim" : undefined}>
                <text className="jpd-tick" x={margin.l - 8} y={y0 + rowH / 2 - 2} textAnchor="end" dominantBaseline="middle" style={{ fill: "var(--foreground)" }}>
                  {truncate(category, labelChars)}
                </text>
                {data.series.map((series, seriesIndex) => {
                  const value = series.values[index] ?? 0;
                  return (
                    <g key={series.key}>
                      <rect x={margin.l} y={y0 + seriesIndex * 16 + 2} width={Math.max(1, xOf(value) - margin.l)} height={13} rx={2} fill={palette[seriesIndex % palette.length]} />
                      <text className="jpd-tick" x={xOf(value) + 5} y={y0 + seriesIndex * 16 + 9} dominantBaseline="middle">
                        {fmt.format(value, block.format)}
                      </text>
                    </g>
                  );
                })}
                <rect
                  className="jpd-bar"
                  x={0}
                  y={y0}
                  width={width}
                  height={rowH}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${category}: ${data.series.map((series) => `${series.label} ${fmt.format(series.values[index], block.format)}`).join(", ")}`}
                  onMouseMove={(event) => setFromPointer(index, event)}
                  onFocus={() => setHover({ index, x: margin.l + 40, y: y0 + rowH / 2 })}
                  onBlur={() => setHover(null)}
                />
              </g>
            );
          })}
          {block.goal !== undefined ? <line x1={xOf(block.goal)} x2={xOf(block.goal)} y1={margin.t} y2={height - margin.b} stroke="currentColor" strokeDasharray="5 4" opacity={0.6} /> : null}
        </svg>
      </Frame>
      {hover ? <Tooltip hover={hover} width={width} data={data} extra={block.tooltip ?? []} palette={palette} fmt={fmt} format={block.format} total={false} t={t} /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------- donut */

function Donut({ block, dataset, fmt, palette, t }: ChartProps) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  const base = useMemo(() => buildSeries(dataset.rows, block.x, block.y, block.seriesLabels), [dataset, block]);
  const data = useMemo<SeriesData>(() => {
    const series = base.series[0];
    if (!series || base.categories.length <= 8) {
      return base;
    }
    const keep = 7;
    const rest = series.values.slice(keep).reduce((a, b) => a + b, 0);
    return {
      categories: [...base.categories.slice(0, keep), t("other")],
      rows: base.rows.slice(0, keep),
      series: [{ ...series, values: [...series.values.slice(0, keep), rest] }],
    };
  }, [base, t]);
  const values = data.series[0]?.values.map((value) => Math.max(0, value)) ?? [];
  const total = values.reduce((a, b) => a + b, 0);
  const size = Math.min(220, Math.max(120, width));
  const radius = size / 2 - 4;
  const inner = radius * 0.6;
  let angle = -Math.PI / 2;
  const arcs = values.map((value, index) => {
    const sweep = total > 0 ? (value / total) * Math.PI * 2 : 0;
    const start = angle;
    angle += sweep;
    const end = angle - (sweep >= Math.PI * 2 ? 0.0001 : 0);
    const large = sweep > Math.PI ? 1 : 0;
    const point = (r: number, a: number) => `${size / 2 + r * Math.cos(a)},${size / 2 + r * Math.sin(a)}`;
    const path = sweep <= 0 ? "" : `M${point(radius, start)} A${radius},${radius} 0 ${large} 1 ${point(radius, end)} L${point(inner, end)} A${inner},${inner} 0 ${large} 0 ${point(inner, start)} Z`;
    const mid = start + sweep / 2;
    return { path, index, mid };
  });
  const setHoverAt = (index: number, event: MouseEvent<SVGElement>) => {
    const box = ref.current?.getBoundingClientRect();
    setHover({ index, x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) });
  };

  return (
    <div className="jpd-chart" ref={ref}>
      <Frame
        block={block}
        data={data}
        fmt={fmt}
        t={t}
        legend={
          <ul className="jpd-legend">
            {data.categories.map((category, index) => (
              <li key={`${category}-${index}`}>
                <span className="jpd-swatch" style={{ background: palette[index % palette.length] }} />
                {category} · {fmt.format(values[index], block.format)}
                {total > 0 ? ` (${fmt.format((values[index] ?? 0) / total, "pct")})` : ""}
              </li>
            ))}
          </ul>
        }
      >
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} style={{ maxWidth: "100%", margin: "0 auto", display: "block" }} role="img" aria-label={ariaSummary(data, fmt, block.format, block.title ?? "")} onMouseLeave={() => setHover(null)}>
          {arcs.map((arc) => (
            <path
              key={arc.index}
              className="jpd-bar"
              d={arc.path}
              fill={palette[arc.index % palette.length]}
              tabIndex={0}
              aria-label={`${data.categories[arc.index]}: ${fmt.format(values[arc.index], block.format)}`}
              opacity={hover && hover.index !== arc.index ? 0.45 : 1}
              onMouseMove={(event) => setHoverAt(arc.index, event)}
              onFocus={() => setHover({ index: arc.index, x: size / 2 + (inner + 8) * Math.cos(arc.mid), y: size / 2 + (inner + 8) * Math.sin(arc.mid) })}
              onBlur={() => setHover(null)}
            />
          ))}
          <text x={size / 2} y={size / 2} textAnchor="middle" dominantBaseline="middle" style={{ fill: "var(--foreground)", fontSize: 18, fontWeight: 600 }}>
            {fmt.format(total, block.format)}
          </text>
        </svg>
      </Frame>
      {hover ? <Tooltip hover={hover} width={width} data={data} extra={block.tooltip ?? []} palette={palette} fmt={fmt} format={block.format} total={false} t={t} /> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- progress */

function Progress({ block, dataset, fmt, palette, t }: ChartProps) {
  const data = useMemo(() => buildSeries(dataset.rows, block.x, block.y, block.seriesLabels), [dataset, block]);
  const series = data.series[0];
  const goal = block.goal ?? (block.format === "pct" ? 1 : 100);
  // The track spans the larger of goal and highest value so overshoot stays visible.
  const scaleMax = Math.max(goal, ...(series?.values ?? [0]));
  const markGoal = block.goal !== undefined && goal < scaleMax;
  return (
    <div className="jpd-chart">
      <div className="jpd-progress">
        {data.categories.map((category, index) => {
          const value = series?.values[index] ?? 0;
          const ratio = scaleMax > 0 ? Math.max(0, Math.min(1, value / scaleMax)) : 0;
          return (
            <div className="jpd-progress-row" key={`${category}-${index}`}>
              <div className="jpd-progress-top">
                <span>{category}</span>
                <span>
                  {fmt.format(value, block.format)} / {fmt.format(goal, block.format)}
                </span>
              </div>
              <div className="jpd-progress-track" role="progressbar" aria-label={category} aria-valuemin={0} aria-valuemax={scaleMax} aria-valuenow={value}>
                <div className="jpd-progress-fill" style={{ width: `${ratio * 100}%`, background: palette[index % palette.length] }} />
                {markGoal ? <div className="jpd-goal" style={{ left: `${(goal / scaleMax) * 100}%` }} title={fmt.format(goal, block.format)} /> : null}
              </div>
            </div>
          );
        })}
      </div>
      <DataTable data={data} fmt={fmt} format={block.format} t={t} title={block.title ?? ""} />
    </div>
  );
}

export function ChartView(props: ChartProps) {
  if (props.dataset.rows.length === 0) {
    return <div className="jpd-empty">{props.t("noData")}</div>;
  }
  switch (props.block.chart) {
    case "horizontalBar":
      return <HorizontalBars {...props} />;
    case "donut":
      return <Donut {...props} />;
    case "progress":
      return <Progress {...props} />;
    default:
      return <Cartesian {...props} />;
  }
}
