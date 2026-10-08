import test from "node:test";
import assert from "node:assert/strict";
import { getMonthlyCosts, formatMonthlyCosts, parseCostPeriod, renderTelegramMonthlyCosts } from "../src/monthly-costs.js";
import manifest from "../src/manifest.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const agents = [
  { id: "ceo", name: "CEO", reportsTo: null },
  { id: "cto", name: "CTO", reportsTo: "ceo" },
  { id: "cmo", name: "CMO", reportsTo: "ceo" },
  { id: "dev", name: "Dev Agent", reportsTo: "cto" },
  { id: "res", name: "Researcher", reportsTo: "cmo" },
  { id: "clone", name: "Research A/B", reportsTo: null },
];
const costs = [
  { agentId: "cto", provider: "google", biller: "google", billingType: "metered_api", costStatus: "reported", events: 82, costCents: "1097" },
  { agentId: "dev", provider: "cursor", biller: "cursor", billingType: "subscription_included", costStatus: "unpriced", events: 13, costCents: "0" },
  { agentId: "res", provider: "deepseek", biller: "deepseek", billingType: "unknown", costStatus: "reported", events: 11, costCents: "32" },
  { agentId: "clone", provider: "omniroute", biller: "omniroute", billingType: "unknown", costStatus: "reported", events: 1, costCents: "0" },
  { agentId: "cto", provider: "google", biller: "google", billingType: "metered_api", costStatus: "unpriced", events: 1, costCents: "0" },
];
function fixture(agentRows = agents, costRows = costs) {
  const calls = [];
  const ctx = { db: { query: async (sql, params) => {
    calls.push({ sql, params });
    return sql.includes("FROM public.agents") ? agentRows : costRows;
  } } };
  return { ctx, calls };
}

test("uses São Paulo calendar month, including UTC date boundary", () => {
  assert.equal(parseCostPeriod("", new Date("2026-11-01T02:30:00.000Z")), "2026-10");
  assert.equal(parseCostPeriod("2026-09"), "2026-09");
  assert.throws(() => parseCostPeriod("2026-13"), /Use \/custos/);
  assert.throws(() => parseCostPeriod("2026-10' OR TRUE"), /Use \/custos/);
});

test("monthly cost includes all reported provider events, marks unpriced, reconciles teams", async () => {
  const { ctx, calls } = fixture();
  const data = await getMonthlyCosts(ctx, companyId, "2026-10");
  assert.equal(data.reportedCostCents, 1129);
  assert.equal(data.reportedEvents, 94);
  assert.equal(data.unpricedEvents, 14);
  assert.deepEqual(data.byApi.map((x) => [x.name, x.cents, x.unpricedEvents]), [
    ["Gemini (Google)", 1097, 1], ["DeepSeek", 32, 0],
    ["Cursor", 0, 13], ["OmniRoute", 0, 0],
  ]);
  assert.equal(data.byGroup.find((x) => x.name === "Tecnologia (CTO)").cents, 1097);
  assert.equal(data.byGroup.find((x) => x.name === "Marketing (CMO)").cents, 32);
  assert.equal(data.byGroup.reduce((sum, item) => sum + item.cents, 0), data.reportedCostCents);
  assert.equal(data.byApi.reduce((sum, item) => sum + item.cents, 0), data.reportedCostCents);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params, [companyId, "2026-10-01", "2026-11-01"]);
  assert.match(calls[0].sql, /a.company_id = \$1/);
  assert.match(calls[1].sql, /c.company_id = \$1/);
  assert.match(calls[1].sql, /America\/Sao_Paulo/);
  const text = formatMonthlyCosts(data);
  assert.match(text, /Total reportado/);
  assert.match(text, /Gemini/);
  assert.match(text, /DeepSeek/);
  assert.match(text, /Cursor.*sem preço/);
  assert.match(text, /14 sem preço/);
  assert.match(text, /não saldos de créditos/);
  assert.ok(text.length < 3500);
});

test("unpriced-only provider is never rendered as known zero spend", async () => {
  const { ctx } = fixture(agents, [costs[1]]);
  const text = formatMonthlyCosts(await getMonthlyCosts(ctx, companyId, "2026-10"));
  assert.match(text, /\*\*Cursor:\*\* sem preço \(13 eventos\)/);
  assert.doesNotMatch(text, /\*\*Cursor:\*\* US/);
});

test("untrusted provider names are Markdown-escaped and billers cannot affect API names", async () => {
  const { ctx } = fixture(agents, [{ ...costs[2], provider: "[danger](https://bad.invalid) *bold*", biller: "omniroute" }]);
  const text = formatMonthlyCosts(await getMonthlyCosts(ctx, companyId, "2026-10"));
  assert.doesNotMatch(text, /\[danger\]\(https:\/\/bad.invalid\)/);
  assert.match(text, /\\\[danger\\\]/);
  assert.ok(text.includes("\u200b"));
});

test("Gemini and DeepSeek remain separate when they share the same billing gateway", async () => {
  const rows = [
    { ...costs[0], biller: "omniroute", provider: "google", events: 2, costCents: "170" },
    { ...costs[2], biller: "omniroute", provider: "deepseek", events: 3, costCents: "80" },
    { ...costs[2], biller: "omniroute", provider: "deepseek", costStatus: "unpriced", events: 1, costCents: "0" },
  ];
  const { ctx } = fixture(agents, rows);
  const data = await getMonthlyCosts(ctx, companyId, "2026-10");
  assert.deepEqual(data.byApi.map((row) => [row.name, row.cents, row.unpricedEvents]), [
    ["Gemini (Google)", 170, 0],
    ["DeepSeek", 80, 1],
  ]);
  assert.equal(data.reportedCostCents, 250);
  assert.equal(data.byGroup.reduce((sum, row) => sum + row.cents, 0), 250);
  const output = formatMonthlyCosts(data);
  assert.match(output, /Gemini/);
  assert.match(output, /DeepSeek/);
  assert.doesNotMatch(output, /OmniRoute/);
});

test("Telegram report always allocates space to both long breakdowns", () => {
  const rows = (prefix, count) => Array.from({ length: count }, (_, index) => ({
    name: `${prefix} ${String(index).padStart(3, "0")} ${"L".repeat(72)}`,
    cents: 120 - index,
    reportedEvents: 1,
    unpricedEvents: index % 7 === 0 ? 1 : 0,
  }));
  const output = formatMonthlyCosts({
    period: "2026-10", reportedCostCents: 9999, reportedEvents: 95, unpricedEvents: 14,
    byApi: rows("API", 60), byGroup: rows("Equipe", 35),
  });
  assert.ok(output.length <= 3450, `message length ${output.length}`);
  const [apiSection, groupSection] = output.split("**Por equipe**");
  assert.match(apiSection, /\*\*Por API \/ provedor\*\*/);
  assert.match(apiSection, /API 000/);
  assert.match(apiSection, /_\d+ de 60 categorias exibidas/);
  assert.ok(groupSection, "team heading is present");
  assert.match(groupSection, /Equipe 000/);
  assert.match(groupSection, /_\d+ de 35 categorias exibidas/);
  assert.match(groupSection, /_Cobertura:/);
  assert.doesNotMatch(groupSection, /_0 de 35 categorias exibidas/);
});

test("unused team budget can be reassigned to a larger API breakdown", () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({
    name: `Provider ${String(index).padStart(3, "0")} ${"Long".repeat(16)}`,
    cents: 1, reportedEvents: 1, unpricedEvents: 0,
  }));
  const output = formatMonthlyCosts({
    period: "2026-10", reportedCostCents: 50, reportedEvents: 50, unpricedEvents: 0,
    byApi: rows, byGroup: [{ name: "Marketing", cents: 50, reportedEvents: 50, unpricedEvents: 0 }],
  });
  const apiSection = output.split("**Por equipe**")[0];
  assert.ok((apiSection.match(/•/g) ?? []).length >= 20, "API section borrows unused team space");
  assert.match(output, /Marketing/);
  assert.ok(output.length <= 3450);
});

test("fails closed rather than present partial costs for oversized datasets", async () => {
  const huge = Array.from({ length: 2001 }, (_, i) => ({ ...costs[0], provider: "test" + i }));
  const { ctx } = fixture(agents, huge);
  await assert.rejects(getMonthlyCosts(ctx, companyId, "2026-10"), /safe report limit/);
});

test("no provider events still explains coverage and does not invent spend", async () => {
  const { ctx } = fixture(agents, []);
  const data = await getMonthlyCosts(ctx, companyId, "2026-10");
  assert.equal(data.reportedCostCents, 0);
  assert.deepEqual(data.byApi, []);
  assert.match(formatMonthlyCosts(data), /Nenhum evento registrado/);
});

test("manifest MCP GET/POST routes have unique keys compatible with the installed host", () => {
  const keys = manifest.apiRoutes.map((route) => route.routeKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(manifest.apiRoutes.find((route) => route.routeKey === "mcp-get").method, "GET");
  assert.equal(manifest.apiRoutes.find((route) => route.routeKey === "mcp").method, "POST");
  assert.equal(manifest.apiRoutes.find((route) => route.routeKey === "monthly-costs").auth, "board");
  assert.ok(manifest.capabilities.includes("events.emit"));
});

test("invalid /custos period returns usage text without calling storage; DB errors still propagate", async () => {
  let calls = 0;
  const invalidCtx = { db: { query: async () => { calls++; return []; } } };
  const usage = await renderTelegramMonthlyCosts(invalidCtx, companyId, "2026-13");
  assert.match(usage, /Uso:.*custos.*AAAA-MM/);
  assert.equal(calls, 0);

  const downCtx = { db: { query: async () => { throw new Error("database unavailable"); } } };
  await assert.rejects(renderTelegramMonthlyCosts(downCtx, companyId, "2026-09"), /database unavailable/);
});
