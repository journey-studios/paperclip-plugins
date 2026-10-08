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

test("untrusted API names are Markdown-escaped and cannot inject links", async () => {
  const { ctx } = fixture(agents, [{ ...costs[2], biller: "[danger](https://bad.invalid) *bold*" }]);
  const text = formatMonthlyCosts(await getMonthlyCosts(ctx, companyId, "2026-10"));
  assert.doesNotMatch(text, /\[danger\]\(https:\/\/bad.invalid\)/);
  assert.match(text, /\\\[danger\\\]/);
  assert.ok(text.includes("\u200b"));
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
