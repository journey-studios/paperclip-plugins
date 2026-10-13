import {
  AGGREGATIONS,
  CELL_FORMATS,
  CHART_KINDS,
  FORMATS,
  TONES,
  type Aggregation,
  type Block,
  type CellFormat,
  type ChartKind,
  type Dataset,
  type DashboardSpec,
  type Format,
  type KpiItem,
  type Primitive,
  type Row,
  type Section,
  type TableColumn,
  type TableFilters,
  type Tone,
  type Value,
  type Where,
} from "./contracts.js";

export type SpecResult = { ok: true; spec: DashboardSpec } | { ok: false; errors: string[] };

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ERRORS = 50;
const MAX_TITLE = 200;
const MAX_TEXT = 100_000;
const SPANS = [1, 2, 3, 4] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isPrimitive(value: unknown): value is Primitive {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}
function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}
function oneOfNumber<T extends number>(list: readonly T[], value: unknown): value is T {
  return typeof value === "number" && (list as readonly number[]).includes(value);
}

class Collector {
  readonly errors: string[] = [];
  add(path: string, message: string): void {
    if (this.errors.length < MAX_ERRORS) {
      this.errors.push(`${path}: ${message}`);
    } else if (this.errors.length === MAX_ERRORS) {
      this.errors.push("(further errors omitted)");
    }
  }
}

interface DatasetInfo {
  fields: Set<string>;
}

class Parser {
  private readonly c = new Collector();
  private datasets = new Map<string, DatasetInfo>();

  get errors(): string[] {
    return this.c.errors;
  }

  private text(value: unknown, path: string, max = MAX_TEXT, required = true): string | undefined {
    if (value === undefined && !required) {
      return undefined;
    }
    if (typeof value !== "string") {
      this.c.add(path, "must be a string");
      return undefined;
    }
    if (required && value.trim().length === 0) {
      this.c.add(path, "must not be empty");
      return undefined;
    }
    if (value.length > max) {
      this.c.add(path, `must be at most ${max} characters`);
      return undefined;
    }
    return value;
  }

  private unknownKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) {
        this.c.add(`${path}.${key}`, `unknown property (allowed: ${allowed.join(", ")})`);
      }
    }
  }

  private fieldRef(datasetId: string, field: unknown, path: string): string | undefined {
    if (typeof field !== "string" || field.length === 0) {
      this.c.add(path, "must be a field name string");
      return undefined;
    }
    const info = this.datasets.get(datasetId);
    if (info && !info.fields.has(field)) {
      this.c.add(path, `unknown field "${field}" in dataset "${datasetId}" (fields: ${[...info.fields].join(", ") || "none"})`);
      return undefined;
    }
    return field;
  }

  private datasetRef(value: unknown, path: string): string | undefined {
    if (typeof value !== "string") {
      this.c.add(path, "must be a dataset id string");
      return undefined;
    }
    if (!this.datasets.has(value)) {
      this.c.add(path, `unknown dataset "${value}" (declared: ${[...this.datasets.keys()].join(", ") || "none"})`);
      return undefined;
    }
    return value;
  }

  private tone(value: unknown, path: string): Tone | undefined {
    if (oneOf(TONES, value)) {
      return value;
    }
    this.c.add(path, `must be one of ${TONES.join(", ")}`);
    return undefined;
  }

  private format(value: unknown, path: string): Format | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (oneOf(FORMATS, value)) {
      return value;
    }
    this.c.add(path, `must be one of ${FORMATS.join(", ")}`);
    return undefined;
  }

  private dataset(value: unknown, path: string): Dataset | undefined {
    if (!isRecord(value)) {
      this.c.add(path, "must be an object");
      return undefined;
    }
    this.unknownKeys(value, ["title", "description", "source", "updatedAt", "staleAfterHours", "columns", "rows"], path);
    const title = this.text(value.title, `${path}.title`, MAX_TITLE);
    const description = this.text(value.description, `${path}.description`, MAX_TEXT, false);
    const source = this.text(value.source, `${path}.source`, 500, false);
    let updatedAt: string | undefined;
    if (value.updatedAt !== undefined) {
      if (
        typeof value.updatedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}/.test(value.updatedAt) ||
        Number.isNaN(Date.parse(value.updatedAt))
      ) {
        this.c.add(`${path}.updatedAt`, "must be an ISO 8601 date or timestamp string");
      } else {
        updatedAt = value.updatedAt;
      }
    }
    let staleAfterHours: number | undefined;
    if (value.staleAfterHours !== undefined) {
      if (typeof value.staleAfterHours !== "number" || !Number.isFinite(value.staleAfterHours) || value.staleAfterHours <= 0 || value.staleAfterHours > 8760) {
        this.c.add(`${path}.staleAfterHours`, "must be a number greater than 0 and at most 8760");
      } else {
        staleAfterHours = value.staleAfterHours;
      }
    }
    let columns: string[] | undefined;
    if (value.columns !== undefined) {
      if (!Array.isArray(value.columns)) {
        this.c.add(`${path}.columns`, "must be an array of strings");
      } else {
        columns = [];
        value.columns.forEach((column: unknown, index: number) => {
          if (typeof column !== "string" || column.length === 0 || column.length > 100) {
            this.c.add(`${path}.columns[${index}]`, "must be a non-empty string (max 100 characters)");
          } else {
            columns?.push(column);
          }
        });
      }
    }
    const rows: Row[] = [];
    if (!Array.isArray(value.rows)) {
      this.c.add(`${path}.rows`, "must be an array of objects");
    } else {
      value.rows.forEach((raw: unknown, index: number) => {
        const rowPath = `${path}.rows[${index}]`;
        if (!isRecord(raw)) {
          this.c.add(rowPath, "must be an object");
          return;
        }
        const row: Row = {};
        for (const [key, cell] of Object.entries(raw)) {
          if (!isPrimitive(cell)) {
            this.c.add(`${rowPath}.${key}`, "must be a string, finite number, boolean or null");
          } else if (columns && !columns.includes(key)) {
            this.c.add(`${rowPath}.${key}`, `field is not declared in columns (${columns.join(", ")})`);
          } else {
            row[key] = cell;
          }
        }
        rows.push(row);
      });
    }
    if (title === undefined) {
      return undefined;
    }
    const dataset: Dataset = { title, rows };
    if (description !== undefined) dataset.description = description;
    if (source !== undefined) dataset.source = source;
    if (updatedAt !== undefined) dataset.updatedAt = updatedAt;
    if (staleAfterHours !== undefined) dataset.staleAfterHours = staleAfterHours;
    if (columns !== undefined) dataset.columns = columns;
    return dataset;
  }

  private where(value: unknown, datasetId: string, path: string): Where | undefined {
    if (!isRecord(value)) {
      this.c.add(path, "must be an object of field to string/number/boolean");
      return undefined;
    }
    const where: Where = {};
    for (const [key, expected] of Object.entries(value)) {
      this.fieldRef(datasetId, key, `${path}.${key}`);
      if (typeof expected === "string" || typeof expected === "number" || typeof expected === "boolean") {
        where[key] = expected;
      } else {
        this.c.add(`${path}.${key}`, "must be a string, number or boolean");
      }
    }
    return where;
  }

  private value(value: unknown, path: string): Value | undefined {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        this.c.add(path, "must be a finite number");
        return undefined;
      }
      return value;
    }
    if (typeof value === "string") {
      return value.length <= 500 ? value : (this.c.add(path, "must be at most 500 characters"), undefined);
    }
    if (!isRecord(value)) {
      this.c.add(path, "must be a number, string or {dataset, field, where?, row?, agg?}");
      return undefined;
    }
    this.unknownKeys(value, ["dataset", "field", "where", "row", "agg"], path);
    const dataset = this.datasetRef(value.dataset, `${path}.dataset`);
    if (dataset === undefined) {
      return undefined;
    }
    const field = this.fieldRef(dataset, value.field, `${path}.field`);
    const ref: { dataset: string; field: string; where?: Where; row?: number; agg?: Aggregation } = {
      dataset,
      field: field ?? "",
    };
    if (value.where !== undefined) {
      ref.where = this.where(value.where, dataset, `${path}.where`);
    }
    if (value.row !== undefined) {
      if (typeof value.row !== "number" || !Number.isInteger(value.row) || value.row < 0) {
        this.c.add(`${path}.row`, "must be a non-negative integer");
      } else {
        ref.row = value.row;
      }
    }
    if (value.agg !== undefined) {
      if (oneOf(AGGREGATIONS, value.agg)) {
        ref.agg = value.agg;
      } else {
        this.c.add(`${path}.agg`, `must be one of ${AGGREGATIONS.join(", ")}`);
      }
    }
    return field === undefined ? undefined : ref;
  }

  private commonKeys = ["id", "title", "note", "span"] as const;

  private block(value: unknown, path: string, seenIds: Set<string>): Block | undefined {
    if (!isRecord(value)) {
      this.c.add(path, "must be an object");
      return undefined;
    }
    const common: { id?: string; title?: string; note?: string; span?: 1 | 2 | 3 | 4 } = {};
    if (value.id !== undefined) {
      if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
        this.c.add(`${path}.id`, "must match [A-Za-z0-9_-]{1,64}");
      } else if (seenIds.has(value.id)) {
        this.c.add(`${path}.id`, `duplicate block id "${value.id}"`);
      } else {
        seenIds.add(value.id);
        common.id = value.id;
      }
    }
    const title = this.text(value.title, `${path}.title`, MAX_TITLE, false);
    if (title !== undefined) common.title = title;
    const note = this.text(value.note, `${path}.note`, MAX_TEXT, false);
    if (note !== undefined) common.note = note;
    if (value.span !== undefined) {
      if (oneOfNumber(SPANS, value.span)) {
        common.span = value.span;
      } else {
        this.c.add(`${path}.span`, "must be 1, 2, 3 or 4");
      }
    }
    const keys = this.commonKeys;
    switch (value.type) {
      case "markdown": {
        this.unknownKeys(value, [...keys, "type", "content"], path);
        const content = this.text(value.content, `${path}.content`);
        return content === undefined ? undefined : { ...common, type: "markdown", content };
      }
      case "mermaid": {
        this.unknownKeys(value, [...keys, "type", "code"], path);
        const code = this.text(value.code, `${path}.code`);
        return code === undefined ? undefined : { ...common, type: "mermaid", code };
      }
      case "callout": {
        this.unknownKeys(value, [...keys, "type", "tone", "content"], path);
        const tone = this.tone(value.tone, `${path}.tone`);
        const content = this.text(value.content, `${path}.content`);
        return tone === undefined || content === undefined ? undefined : { ...common, type: "callout", tone, content };
      }
      case "kpis":
        return this.kpis(value, common, path);
      case "chart":
        return this.chart(value, common, path);
      case "table":
        return this.table(value, common, path);
      case "statusList":
        return this.statusList(value, common, path);
      default:
        this.c.add(
          `${path}.type`,
          `must be one of markdown, mermaid, callout, kpis, chart, table, statusList (got ${JSON.stringify(value.type)})`,
        );
        return undefined;
    }
  }

  private kpis(value: Record<string, unknown>, common: object, path: string): Block | undefined {
    this.unknownKeys(value, [...this.commonKeys, "type", "items"], path);
    if (!Array.isArray(value.items) || value.items.length === 0) {
      this.c.add(`${path}.items`, "must be a non-empty array");
      return undefined;
    }
    const items: KpiItem[] = [];
    value.items.forEach((raw: unknown, index: number) => {
      const itemPath = `${path}.items[${index}]`;
      if (!isRecord(raw)) {
        this.c.add(itemPath, "must be an object");
        return;
      }
      this.unknownKeys(raw, ["label", "value", "of", "caption", "format", "tone"], itemPath);
      const label = this.text(raw.label, `${itemPath}.label`, MAX_TITLE);
      const kpiValue = this.value(raw.value, `${itemPath}.value`);
      const item: Partial<KpiItem> = {};
      if (raw.of !== undefined) item.of = this.value(raw.of, `${itemPath}.of`);
      const caption = this.text(raw.caption, `${itemPath}.caption`, 500, false);
      if (caption !== undefined) item.caption = caption;
      const format = this.format(raw.format, `${itemPath}.format`);
      if (format !== undefined) item.format = format;
      if (raw.tone !== undefined) {
        const tone = this.tone(raw.tone, `${itemPath}.tone`);
        if (tone !== undefined) item.tone = tone;
      }
      if (label !== undefined && kpiValue !== undefined) {
        items.push({ ...item, label, value: kpiValue });
      }
    });
    return { ...common, type: "kpis", items };
  }

  private chart(value: Record<string, unknown>, common: object, path: string): Block | undefined {
    this.unknownKeys(
      value,
      [...this.commonKeys, "type", "chart", "dataset", "x", "y", "seriesLabels", "seriesColors", "format", "tooltip", "goal"],
      path,
    );
    let chart: ChartKind | undefined;
    if (oneOf(CHART_KINDS, value.chart)) {
      chart = value.chart;
    } else {
      this.c.add(`${path}.chart`, `must be one of ${CHART_KINDS.join(", ")}`);
    }
    const dataset = this.datasetRef(value.dataset, `${path}.dataset`);
    if (dataset === undefined) {
      return undefined;
    }
    const x = this.fieldRef(dataset, value.x, `${path}.x`);
    let y: string | string[] | undefined;
    if (typeof value.y === "string") {
      y = this.fieldRef(dataset, value.y, `${path}.y`);
    } else if (Array.isArray(value.y) && value.y.length > 0) {
      const list: string[] = [];
      value.y.forEach((entry: unknown, index: number) => {
        const field = this.fieldRef(dataset, entry, `${path}.y[${index}]`);
        if (field !== undefined) list.push(field);
      });
      y = list.length === value.y.length ? list : undefined;
    } else {
      this.c.add(`${path}.y`, "must be a field name or a non-empty array of field names");
    }
    const out: {
      seriesLabels?: Record<string, string>;
      seriesColors?: Record<string, string>;
      format?: Format;
      tooltip?: string[];
      goal?: number;
    } = {};
    if (value.seriesLabels !== undefined) {
      if (!isRecord(value.seriesLabels)) {
        this.c.add(`${path}.seriesLabels`, "must be an object of field to label");
      } else {
        const labels: Record<string, string> = {};
        const known = typeof y === "string" ? [y] : (y ?? []);
        for (const [key, label] of Object.entries(value.seriesLabels)) {
          if (!known.includes(key)) {
            this.c.add(`${path}.seriesLabels.${key}`, "is not one of the y fields");
          } else if (typeof label !== "string" || label.length > MAX_TITLE) {
            this.c.add(`${path}.seriesLabels.${key}`, "must be a string");
          } else {
            labels[key] = label;
          }
        }
        out.seriesLabels = labels;
      }
    }
    if (value.seriesColors !== undefined) {
      if (!isRecord(value.seriesColors)) {
        this.c.add(`${path}.seriesColors`, "must be an object of y field to tone or #rrggbb");
      } else {
        const colors: Record<string, string> = {};
        const known = typeof y === "string" ? [y] : (y ?? []);
        for (const [key, color] of Object.entries(value.seriesColors)) {
          if (!known.includes(key)) {
            this.c.add(`${path}.seriesColors.${key}`, "is not one of the y fields");
          } else if (oneOf(TONES, color) || (typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color))) {
            colors[key] = color;
          } else {
            this.c.add(`${path}.seriesColors.${key}`, `must be one of ${TONES.join(", ")} or a #rrggbb color`);
          }
        }
        out.seriesColors = colors;
      }
    }
    const format = this.format(value.format, `${path}.format`);
    if (format !== undefined) out.format = format;
    if (value.tooltip !== undefined) {
      if (!Array.isArray(value.tooltip)) {
        this.c.add(`${path}.tooltip`, "must be an array of field names");
      } else {
        out.tooltip = [];
        value.tooltip.forEach((entry: unknown, index: number) => {
          const field = this.fieldRef(dataset, entry, `${path}.tooltip[${index}]`);
          if (field !== undefined) out.tooltip?.push(field);
        });
      }
    }
    if (value.goal !== undefined) {
      if (typeof value.goal !== "number" || !Number.isFinite(value.goal)) {
        this.c.add(`${path}.goal`, "must be a finite number");
      } else {
        out.goal = value.goal;
      }
    }
    if (chart === undefined || x === undefined || y === undefined) {
      return undefined;
    }
    if ((chart === "donut" || chart === "progress") && Array.isArray(y) && y.length !== 1) {
      this.c.add(`${path}.y`, `${chart} charts take exactly one y field`);
      return undefined;
    }
    return { ...common, ...out, type: "chart", chart, dataset, x, y };
  }

  private table(value: Record<string, unknown>, common: object, path: string): Block | undefined {
    this.unknownKeys(
      value,
      [...this.commonKeys, "type", "dataset", "rowKey", "columns", "filters", "sort", "emptyText"],
      path,
    );
    const dataset = this.datasetRef(value.dataset, `${path}.dataset`);
    if (dataset === undefined) {
      return undefined;
    }
    const rowKey = this.fieldRef(dataset, value.rowKey, `${path}.rowKey`);
    const columns: TableColumn[] = [];
    if (!Array.isArray(value.columns) || value.columns.length === 0) {
      this.c.add(`${path}.columns`, "must be a non-empty array");
    } else {
      value.columns.forEach((raw: unknown, index: number) => {
        const columnPath = `${path}.columns[${index}]`;
        if (!isRecord(raw)) {
          this.c.add(columnPath, "must be an object");
          return;
        }
        this.unknownKeys(raw, ["field", "label", "format", "wide"], columnPath);
        const field = this.fieldRef(dataset, raw.field, `${columnPath}.field`);
        const label = this.text(raw.label, `${columnPath}.label`, MAX_TITLE);
        let format: CellFormat | undefined;
        if (raw.format !== undefined) {
          if (oneOf(FORMATS, raw.format) || oneOf(CELL_FORMATS, raw.format)) {
            format = raw.format;
          } else {
            this.c.add(`${columnPath}.format`, `must be one of ${[...FORMATS, ...CELL_FORMATS].join(", ")}`);
          }
        }
        let wide: boolean | undefined;
        if (raw.wide !== undefined) {
          if (typeof raw.wide === "boolean") {
            wide = raw.wide;
          } else {
            this.c.add(`${columnPath}.wide`, "must be a boolean");
          }
        }
        if (field !== undefined && label !== undefined) {
          const column: TableColumn = { field, label };
          if (format !== undefined) column.format = format;
          if (wide !== undefined) column.wide = wide;
          columns.push(column);
        }
      });
    }
    const out: { filters?: TableFilters; sort?: { field: string; dir: "asc" | "desc" }; emptyText?: string } = {};
    if (value.filters !== undefined) {
      if (!isRecord(value.filters)) {
        this.c.add(`${path}.filters`, "must be an object");
      } else {
        this.unknownKeys(value.filters, ["chips", "selects", "search"], `${path}.filters`);
        const filters: TableFilters = {};
        if (value.filters.chips !== undefined) {
          const chips = this.fieldRef(dataset, value.filters.chips, `${path}.filters.chips`);
          if (chips !== undefined) filters.chips = chips;
        }
        if (value.filters.selects !== undefined) {
          if (!Array.isArray(value.filters.selects)) {
            this.c.add(`${path}.filters.selects`, "must be an array of field names");
          } else {
            filters.selects = [];
            value.filters.selects.forEach((entry: unknown, index: number) => {
              const field = this.fieldRef(dataset, entry, `${path}.filters.selects[${index}]`);
              if (field !== undefined) filters.selects?.push(field);
            });
          }
        }
        if (value.filters.search !== undefined) {
          if (typeof value.filters.search === "boolean") {
            filters.search = value.filters.search;
          } else {
            this.c.add(`${path}.filters.search`, "must be a boolean");
          }
        }
        out.filters = filters;
      }
    }
    if (value.sort !== undefined) {
      if (!isRecord(value.sort)) {
        this.c.add(`${path}.sort`, "must be {field, dir}");
      } else {
        this.unknownKeys(value.sort, ["field", "dir"], `${path}.sort`);
        const field = this.fieldRef(dataset, value.sort.field, `${path}.sort.field`);
        if (value.sort.dir !== "asc" && value.sort.dir !== "desc") {
          this.c.add(`${path}.sort.dir`, 'must be "asc" or "desc"');
        } else if (field !== undefined) {
          out.sort = { field, dir: value.sort.dir };
        }
      }
    }
    const emptyText = this.text(value.emptyText, `${path}.emptyText`, 500, false);
    if (emptyText !== undefined) out.emptyText = emptyText;
    if (rowKey === undefined || columns.length === 0) {
      return undefined;
    }
    return { ...common, ...out, type: "table", dataset, rowKey, columns };
  }

  private statusList(value: Record<string, unknown>, common: object, path: string): Block | undefined {
    this.unknownKeys(
      value,
      [...this.commonKeys, "type", "dataset", "labelField", "valueField", "statusField", "detailField", "format"],
      path,
    );
    const dataset = this.datasetRef(value.dataset, `${path}.dataset`);
    if (dataset === undefined) {
      return undefined;
    }
    const labelField = this.fieldRef(dataset, value.labelField, `${path}.labelField`);
    const valueField = this.fieldRef(dataset, value.valueField, `${path}.valueField`);
    const statusField = this.fieldRef(dataset, value.statusField, `${path}.statusField`);
    const out: { detailField?: string; format?: Format } = {};
    if (value.detailField !== undefined) {
      const detailField = this.fieldRef(dataset, value.detailField, `${path}.detailField`);
      if (detailField !== undefined) out.detailField = detailField;
    }
    const format = this.format(value.format, `${path}.format`);
    if (format !== undefined) out.format = format;
    if (labelField === undefined || valueField === undefined || statusField === undefined) {
      return undefined;
    }
    return { ...common, ...out, type: "statusList", dataset, labelField, valueField, statusField };
  }

  private section(value: unknown, path: string, seenSections: Set<string>, seenBlocks: Set<string>): Section | undefined {
    if (!isRecord(value)) {
      this.c.add(path, "must be an object");
      return undefined;
    }
    this.unknownKeys(value, ["id", "title", "note", "columns", "blocks"], path);
    let id: string | undefined;
    if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
      this.c.add(`${path}.id`, "is required and must match [A-Za-z0-9_-]{1,64}");
    } else if (seenSections.has(value.id)) {
      this.c.add(`${path}.id`, `duplicate section id "${value.id}"`);
    } else {
      seenSections.add(value.id);
      id = value.id;
    }
    const title = this.text(value.title, `${path}.title`, MAX_TITLE, false);
    const note = this.text(value.note, `${path}.note`, MAX_TEXT, false);
    let columns: 1 | 2 | 3 | 4 | undefined;
    if (value.columns !== undefined) {
      if (oneOfNumber(SPANS, value.columns)) {
        columns = value.columns;
      } else {
        this.c.add(`${path}.columns`, "must be 1, 2, 3 or 4");
      }
    }
    const blocks: Block[] = [];
    if (!Array.isArray(value.blocks)) {
      this.c.add(`${path}.blocks`, "must be an array");
    } else {
      value.blocks.forEach((raw: unknown, index: number) => {
        const block = this.block(raw, `${path}.blocks[${index}]`, seenBlocks);
        if (block) blocks.push(block);
      });
    }
    if (id === undefined) {
      return undefined;
    }
    const section: Section = { id, blocks };
    if (title !== undefined) section.title = title;
    if (note !== undefined) section.note = note;
    if (columns !== undefined) section.columns = columns;
    return section;
  }

  spec(input: unknown): DashboardSpec | undefined {
    if (!isRecord(input)) {
      this.c.add("spec", "must be an object");
      return undefined;
    }
    this.unknownKeys(input, ["version", "title", "summary", "meta", "datasets", "statusTones", "sections"], "spec");
    if (input.version !== 1) {
      this.c.add("version", "must be 1");
    }
    const title = this.text(input.title, "title", MAX_TITLE);
    const summary = this.text(input.summary, "summary", MAX_TEXT, false);
    const meta = this.text(input.meta, "meta", MAX_TEXT, false);

    const datasets: Record<string, Dataset> = {};
    if (!isRecord(input.datasets)) {
      this.c.add("datasets", "must be an object keyed by dataset id");
    } else {
      for (const [id, raw] of Object.entries(input.datasets)) {
        const path = `datasets.${id}`;
        if (!ID_PATTERN.test(id)) {
          this.c.add(path, "dataset id must match [A-Za-z0-9_-]{1,64}");
          continue;
        }
        const dataset = this.dataset(raw, path);
        if (dataset) {
          datasets[id] = dataset;
        }
        const fields = new Set<string>(dataset?.columns ?? []);
        if (!dataset?.columns && dataset) {
          for (const row of dataset.rows) {
            Object.keys(row).forEach((key) => fields.add(key));
          }
        }
        this.datasets.set(id, { fields });
      }
    }

    let statusTones: Record<string, Tone> | undefined;
    if (input.statusTones !== undefined) {
      if (!isRecord(input.statusTones)) {
        this.c.add("statusTones", "must be an object of value to tone");
      } else {
        statusTones = {};
        for (const [key, tone] of Object.entries(input.statusTones)) {
          const parsed = this.tone(tone, `statusTones.${key}`);
          if (parsed !== undefined) statusTones[key] = parsed;
        }
      }
    }

    const sections: Section[] = [];
    if (!Array.isArray(input.sections)) {
      this.c.add("sections", "must be an array");
    } else {
      const seenSections = new Set<string>();
      const seenBlocks = new Set<string>();
      input.sections.forEach((raw: unknown, index: number) => {
        const section = this.section(raw, `sections[${index}]`, seenSections, seenBlocks);
        if (section) sections.push(section);
      });
    }

    if (this.c.errors.length > 0 || title === undefined) {
      return undefined;
    }
    const spec: DashboardSpec = { version: 1, title, datasets, sections };
    if (summary !== undefined) spec.summary = summary;
    if (meta !== undefined) spec.meta = meta;
    if (statusTones !== undefined) spec.statusTones = statusTones;
    return spec;
  }
}

/** Validate untrusted input and return a typed, normalized copy or path-precise errors. */
export function validateSpec(input: unknown): SpecResult {
  const parser = new Parser();
  const spec = parser.spec(input);
  if (!spec || parser.errors.length > 0) {
    return { ok: false, errors: parser.errors.length > 0 ? parser.errors : ["spec: invalid"] };
  }
  return { ok: true, spec };
}
