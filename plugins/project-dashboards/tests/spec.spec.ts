import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateSpec } from "../src/spec.js";
import type { DashboardSpec } from "../src/contracts.js";

const example = JSON.parse(
  await readFile(new URL("../examples/project-dashboard.example.json", import.meta.url), "utf8"),
);

function exampleSpec(): DashboardSpec {
  const result = validateSpec(example);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  return result.spec;
}

function errorsOf(mutate: (spec: any) => void): string[] {
  const copy = structuredClone(example);
  mutate(copy);
  const result = validateSpec(copy);
  return result.ok ? [] : result.errors;
}

describe("DashboardSpec validator", () => {
  it("accepts the example fixture", () => {
    const spec = exampleSpec();
    expect(spec.sections.length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(spec.datasets)).toContain("pending");
  });

  it("covers every block type and chart kind in the fixture", () => {
    const spec = exampleSpec();
    const blocks = spec.sections.flatMap((section) => section.blocks);
    for (const type of ["markdown", "mermaid", "callout", "kpis", "chart", "table", "statusList"]) {
      expect(blocks.some((block) => block.type === type), type).toBe(true);
    }
    const kinds = new Set(blocks.flatMap((block) => (block.type === "chart" ? [block.chart] : [])));
    for (const kind of ["bar", "horizontalBar", "stackedBar", "progress"]) {
      expect(kinds.has(kind as never), kind).toBe(true);
    }
  });

  it("reports unknown datasets with the exact path", () => {
    const errors = errorsOf((spec) => {
      spec.sections[1].blocks[0].dataset = "foo";
    });
    expect(errors.some((e) => e.startsWith('sections[1].blocks[0].dataset: unknown dataset "foo"'))).toBe(true);
  });

  it("reports unknown fields in charts, tables, filters and values", () => {
    const errors = errorsOf((spec) => {
      spec.sections[1].blocks[1].x = "nope";
      spec.sections[3].blocks[0].filters.chips = "missing";
      spec.sections[3].blocks[0].columns[0].field = "ghost";
      spec.sections[0].blocks[0].items[0].value.where = { absent: "x" };
    });
    expect(errors).toContain('sections[1].blocks[1].x: unknown field "nope" in dataset "roadmap" (fields: phase, done, open, total)');
    expect(errors.some((e) => e.startsWith("sections[3].blocks[0].filters.chips: unknown field"))).toBe(true);
    expect(errors.some((e) => e.startsWith("sections[3].blocks[0].columns[0].field: unknown field"))).toBe(true);
    expect(errors.some((e) => e.startsWith("sections[0].blocks[0].items[0].value.where.absent: unknown field"))).toBe(true);
  });

  it("rejects bad enums, unknown properties and duplicate ids", () => {
    const errors = errorsOf((spec) => {
      spec.sections[1].blocks[1].chart = "pie";
      spec.sections[0].blocks[0].items[0].format = "money";
      spec.sections[0].blocks[0].extra = true;
      spec.sections[2].id = "overview";
      spec.statusTones = { done: "green" };
      spec.sections[4].blocks[0].span = 7;
    });
    expect(errors.some((e) => e.startsWith("sections[1].blocks[1].chart: must be one of"))).toBe(true);
    expect(errors.some((e) => e.startsWith("sections[0].blocks[0].items[0].format: must be one of"))).toBe(true);
    expect(errors.some((e) => e.startsWith("sections[0].blocks[0].extra: unknown property"))).toBe(true);
    expect(errors.some((e) => e.includes('duplicate section id "overview"'))).toBe(true);
    expect(errors.some((e) => e.startsWith("statusTones.done: must be one of"))).toBe(true);
    expect(errors.some((e) => e.startsWith("sections[4].blocks[0].span: must be 1, 2, 3 or 4"))).toBe(true);
  });

  it("validates dataset shape: row values, columns, dates, ids", () => {
    const errors = errorsOf((spec) => {
      spec.datasets.phases.rows[0].status = { nested: true };
      spec.datasets.roadmap.rows[1].extra = 1;
      spec.datasets.deliveries.updatedAt = "yesterday";
      spec.datasets["bad id!"] = { title: "x", rows: [] };
    });
    expect(errors.some((e) => e.startsWith("datasets.phases.rows[0].status: must be a string"))).toBe(true);
    expect(errors.some((e) => e.startsWith("datasets.roadmap.rows[1].extra: field is not declared in columns"))).toBe(true);
    expect(errors.some((e) => e.startsWith("datasets.deliveries.updatedAt: must be an ISO"))).toBe(true);
    expect(errors.some((e) => e.startsWith('datasets.bad id!: dataset id must match'))).toBe(true);
  });

  it("validates statusList and seriesColors fields with precise paths", () => {
    const errors = errorsOf((spec) => {
      const list = spec.sections[2].blocks[0];
      list.labelField = "nope";
      delete list.valueField;
      list.note = "oops";
      const chart = spec.sections[3].blocks[1];
      chart.seriesColors = { P0: "red", P9: "ok", P1: "#12345" };
    });
    expect(errors.some((e) => e.startsWith("sections[2].blocks[0].labelField: unknown field"))).toBe(true);
    expect(errors.some((e) => e.startsWith("sections[2].blocks[0].valueField: must be a field name"))).toBe(true);
    expect(errors.some((e) => e.startsWith("sections[2].blocks[0].note: unknown property"))).toBe(false);
    expect(errors.some((e) => e.startsWith("sections[3].blocks[1].seriesColors.P0: must be one of"))).toBe(true);
    expect(errors).toContain("sections[3].blocks[1].seriesColors.P9: is not one of the y fields");
    expect(errors.some((e) => e.startsWith("sections[3].blocks[1].seriesColors.P1: must be one of"))).toBe(true);
  });

  it("requires version 1 and an object", () => {
    expect(validateSpec(null)).toEqual({ ok: false, errors: ["spec: must be an object"] });
    expect(errorsOf((spec) => {
      spec.version = 2;
    })).toContain("version: must be 1");
  });

  it("derives fields from row keys when columns are omitted and rejects donut with several y", () => {
    const result = validateSpec({
      version: 1,
      title: "T",
      datasets: { d: { title: "D", rows: [{ a: "x", b: 1, c: 2 }] } },
      sections: [{ id: "s", blocks: [{ type: "chart", chart: "donut", dataset: "d", x: "a", y: ["b", "c"] }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(["sections[0].blocks[0].y: donut charts take exactly one y field"]);
    }
  });
});
