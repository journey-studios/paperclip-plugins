import { describe, expect, it } from "vitest";
import type { Dataset } from "../src/contracts.js";
import { safeHttpUrl } from "../src/safe-url.js";
import { createTranslator, dictionaryLocale } from "../src/ui/i18n.js";
import {
  aggregate,
  buildSeries,
  buildToneMap,
  countBy,
  createFormatter,
  filterRows,
  formatDuration,
  mermaidFence,
  niceScale,
  resolvePalette,
  seriesColorsFor,
  resolveValue,
  sortRows,
  stackedTotals,
  toneFor,
  DEFAULT_PALETTE,
} from "../src/ui/model.js";

const nbsp = (text: string) => text.replace(/[  ]/g, " ");

const datasets: Record<string, Dataset> = {
  t: {
    title: "T",
    rows: [
      { name: "a", status: "done", n: 1 },
      { name: "b", status: "done", n: 4 },
      { name: "c", status: "todo", n: 10 },
      { name: "d", status: "blocked", n: null },
    ],
  },
};

describe("formatting follows the configured locale and currency", () => {
  it("formats numbers in en-US and pt-BR", () => {
    const en = createFormatter("en-US", "USD");
    const pt = createFormatter("pt-BR", "BRL");
    expect(en.format(1234567, "int")).toBe("1,234,567");
    expect(pt.format(1234567, "int")).toBe("1.234.567");
    expect(en.format(1234.5, "decimal")).toBe("1,234.5");
    expect(pt.format(1234.5, "decimal")).toBe("1.234,5");
    expect(nbsp(en.format(1234.5, "currency"))).toBe("$1,234.50");
    expect(nbsp(pt.format(1234.5, "currency"))).toBe("R$ 1.234,50");
    expect(nbsp(createFormatter("de-DE", "EUR").format(1234.5, "currency"))).toBe("1.234,50 €");
  });

  it("treats pct as a fraction (0.425 is 42.5%)", () => {
    expect(createFormatter("en-US", "USD").format(0.425, "pct")).toBe("42.5%");
    expect(nbsp(createFormatter("pt-BR", "BRL").format(0.425, "pct"))).toBe("42,5%");
    expect(createFormatter("en-US", "USD").format(1, "pct")).toBe("100%");
  });

  it("formats durations, raw values and empties", () => {
    const en = createFormatter("en-US", "USD");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(725)).toBe("12m 5s");
    expect(formatDuration(3725)).toBe("1h 2m");
    expect(formatDuration(90_000)).toBe("1d 1h");
    expect(en.format(90, "duration")).toBe("1m 30s");
    expect(en.format("text", "int")).toBe("text");
    expect(en.format(null, "int")).toBe("—");
    expect(en.format(7)).toBe("7");
  });

  it("formats dates and relative times by locale", () => {
    const en = createFormatter("en-US", "USD");
    const pt = createFormatter("pt-BR", "USD");
    expect(en.date("2026-10-11")).toContain("Oct");
    expect(pt.date("2026-10-11")).toContain("out");
    expect(pt.date("2026-10-11")).toContain("11");
    const now = Date.parse("2026-10-11T12:00:00Z");
    expect(en.relative("2026-10-11T10:00:00Z", now)).toBe("2 hours ago");
    expect(pt.relative("2026-10-11T10:00:00Z", now)).toBe("há 2 horas");
    expect(en.date("not a date")).toBe("not a date");
  });
});

describe("UI strings", () => {
  it("ships en (default) and pt-BR and falls back to English", () => {
    expect(dictionaryLocale("pt-BR")).toBe("pt-BR");
    expect(dictionaryLocale("pt-PT")).toBe("pt-BR");
    expect(dictionaryLocale("pt")).toBe("pt-BR");
    expect(dictionaryLocale("en-GB")).toBe("en");
    expect(dictionaryLocale("ja-JP")).toBe("en");
    expect(createTranslator("en-US")("sources")).toBe("Sources");
    expect(createTranslator("pt-BR")("sources")).toBe("Fontes");
    expect(createTranslator("ja-JP")("sources")).toBe("Sources");
    expect(createTranslator("en-US")("metaLine", { revision: 3, when: "now", who: "me" })).toBe("Revision 3 · updated now by me");
    expect(createTranslator("pt-BR")("metaLine", { revision: 3, when: "agora", who: "eu" })).toBe("Revisão 3 · atualizado agora por eu");
  });
});

describe("value resolution and aggregation", () => {
  it("resolves literals, rows, where filters and aggregates", () => {
    expect(resolveValue(5, datasets)).toBe(5);
    expect(resolveValue("x", datasets)).toBe("x");
    expect(resolveValue({ dataset: "t", field: "name" }, datasets)).toBe("a");
    expect(resolveValue({ dataset: "t", field: "name", row: 2 }, datasets)).toBe("c");
    expect(resolveValue({ dataset: "t", field: "name", where: { status: "todo" } }, datasets)).toBe("c");
    expect(resolveValue({ dataset: "t", field: "n", agg: "sum" }, datasets)).toBe(15);
    expect(resolveValue({ dataset: "t", field: "n", agg: "avg", where: { status: "done" } }, datasets)).toBe(2.5);
    expect(resolveValue({ dataset: "t", field: "n", agg: "min" }, datasets)).toBe(1);
    expect(resolveValue({ dataset: "t", field: "n", agg: "max" }, datasets)).toBe(10);
    expect(resolveValue({ dataset: "t", field: "name", agg: "count", where: { status: "done" } }, datasets)).toBe(2);
    expect(resolveValue({ dataset: "t", field: "n", agg: "sum", where: { status: "none" } }, datasets)).toBe(0);
    expect(resolveValue({ dataset: "t", field: "n", agg: "avg", where: { status: "none" } }, datasets)).toBeNull();
    expect(resolveValue({ dataset: "missing", field: "n" }, datasets)).toBeNull();
    expect(aggregate([], "count")).toBe(0);
  });
});

describe("tones", () => {
  it("merges built-ins, settings and spec tones with spec winning", () => {
    const tones = buildToneMap({ defaultStatusTones: { review: "info", done: "info" } }, { statusTones: { Done: "ok", "On Hold": "bad" } });
    expect(toneFor("done", tones)).toBe("ok");
    expect(toneFor("In Progress", tones)).toBe("warn");
    expect(toneFor("review", tones)).toBe("info");
    expect(toneFor("on hold", tones)).toBe("bad");
    expect(toneFor("P0", tones)).toBe("bad");
    expect(toneFor("P1", tones)).toBe("warn");
    expect(toneFor("P2", tones)).toBe("muted");
    expect(toneFor("Pendente", tones)).toBe("muted");
    expect(toneFor("Concluído", tones)).toBe("ok");
    expect(toneFor("unknown thing", tones)).toBe("muted");
    expect(toneFor(null, tones)).toBe("muted");
  });
});

describe("filtering, sorting and links", () => {
  const rows = datasets.t!.rows;
  it("filters by chip, select and search; counts for chips", () => {
    expect(filterRows(rows, { chip: { field: "status", value: "done" } })).toHaveLength(2);
    expect(filterRows(rows, { selects: { status: "todo" } })).toHaveLength(1);
    expect(filterRows(rows, { search: "  10 " })).toHaveLength(1);
    expect(filterRows(rows, { search: "block", searchFields: ["status"] })).toHaveLength(1);
    expect(filterRows(rows, { search: "block", searchFields: ["name"] })).toHaveLength(0);
    expect(filterRows(rows, { chip: { field: "status", value: "done" }, search: "a" })).toHaveLength(1);
    expect(countBy(rows, "status")).toEqual([
      { value: "done", count: 2 },
      { value: "todo", count: 1 },
      { value: "blocked", count: 1 },
    ]);
  });

  it("sorts numerically with nulls last", () => {
    expect(sortRows(rows, { field: "n", dir: "desc" }, "en-US").map((r) => r.name)).toEqual(["c", "b", "a", "d"]);
    expect(sortRows(rows, { field: "n", dir: "asc" }, "en-US").map((r) => r.name)).toEqual(["a", "b", "c", "d"]);
    expect(sortRows(rows, undefined, "en-US")).toBe(rows);
  });

  it("only allows absolute http(s) links", () => {
    expect(safeHttpUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com/");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.test", "/relative", "ftp://x", "", 5, null]) {
      expect(safeHttpUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe("chart helpers", () => {
  it("builds series with labels and zero-fills non-numbers", () => {
    const data = buildSeries(rows(), "name", ["n"], { n: "Count" });
    expect(data.categories).toEqual(["a", "b", "c", "d"]);
    expect(data.series[0]).toEqual({ key: "n", label: "Count", values: [1, 4, 10, 0] });
    expect(stackedTotals([{ key: "a", label: "a", values: [1, 2] }, { key: "b", label: "b", values: [3, 4] }], 2)).toEqual([4, 6]);
  });

  it("creates nice scales that include zero", () => {
    expect(niceScale(0, 97)).toMatchObject({ min: 0, max: 100 });
    expect(niceScale(0, 0).ticks.length).toBeGreaterThan(1);
    const negative = niceScale(-30, 70);
    expect(negative.min).toBeLessThanOrEqual(-30);
    expect(negative.max).toBeGreaterThanOrEqual(70);
    expect(negative.ticks).toContain(0);
  });

  it("applies palette overrides per slot and keeps eight colors", () => {
    expect(resolvePalette([], false)).toEqual(DEFAULT_PALETTE.light);
    expect(resolvePalette([], true)).toEqual(DEFAULT_PALETTE.dark);
    const mixed = resolvePalette(["#111111", "", "#333333"], true);
    expect(mixed).toHaveLength(8);
    expect(mixed[0]).toBe("#111111");
    expect(mixed[1]).toBe(DEFAULT_PALETTE.dark[1]);
    expect(mixed[2]).toBe("#333333");
  });

  it("fences mermaid so content can never close the fence", () => {
    expect(mermaidFence("graph LR\n A-->B")).toBe("```mermaid\ngraph LR\n A-->B\n```");
    expect(mermaidFence("a\n```\n# injected")).toBe("````mermaid\na\n```\n# injected\n````");
  });
});

function rows() {
  return datasets.t!.rows;
}

describe("own-property lookups", () => {
  it("never reads Object.prototype members as data", () => {
    const tones = buildToneMap({ defaultStatusTones: {} }, { statusTones: { Shipped: "ok" } });
    for (const status of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(toneFor(status, tones), status).toBe("muted");
    }
    expect(toneFor("shipped", tones)).toBe("ok");
    expect(resolveValue({ dataset: "constructor", field: "a" }, datasets)).toBeNull();
    expect(resolveValue({ dataset: "t", field: "toString" }, datasets)).toBeNull();
    expect(resolveValue({ dataset: "t", field: "name", where: { constructor: "x" } }, datasets)).toBeNull();
    const data = buildSeries([{ toString: 3 }, { other: 1 }], "toString", ["toString"], { valueOf: "x" });
    expect(data.series[0]).toEqual({ key: "toString", label: "toString", values: [3, 0] });
    expect(data.categories).toEqual(["3", ""]);
    expect(filterRows([{ a: "x" }], { selects: { constructor: "y" } })).toHaveLength(0);
  });

  it("ignores reserved keys in tone maps and keeps maps prototype-less", () => {
    const hostile = JSON.parse('{"__proto__":"ok","constructor":"bad","fine":"warn"}');
    const tones = buildToneMap({ defaultStatusTones: hostile }, { statusTones: hostile });
    expect(Object.getPrototypeOf(tones)).toBeNull();
    expect(toneFor("fine", tones)).toBe("warn");
    expect(Object.keys(tones)).not.toContain("__proto__");
    expect(toneFor("constructor", tones)).toBe("muted");
    const palette = seriesColorsFor(["constructor"], undefined, tones, ["#111111"], false);
    expect(palette).toEqual(["#111111"]);
    expect(seriesColorsFor(["a"], JSON.parse('{"a":"constructor"}'), tones, ["#111111"], false)).toEqual(["constructor"]);
  });
});
