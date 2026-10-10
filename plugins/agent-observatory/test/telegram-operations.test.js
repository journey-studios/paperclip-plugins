import test from "node:test";
import assert from "node:assert/strict";
import {
  getLiveRuns, formatLiveRuns, formatAgentHealth,
  renderTelegramRuns, renderTelegramHealth,
} from "../src/telegram-operations.js";

const COMPANY = "44444444-4444-4444-8444-444444444444";

test("/runs queries the scoped ledger and does not infer activity from agent status", async () => {
  const queries = [];
  const ctx = { db: { async query(sql, args) {
    queries.push({ sql, args });
    if (sql.includes("ORDER BY")) return [
      {
        id: "run-1", agentName: "CTO", startedAt: "2026-10-10T12:00:00Z",
        status: "running", issueId: "issue-1",
      },
    ];
    return [{ count: 1 }];
  } } };
  const data = await getLiveRuns(ctx, COMPANY);
  assert.equal(data.total, 1);
  assert.equal(data.rows[0].id, "run-1");
  assert.equal(queries.length, 2);
  for (const q of queries) {
    assert.match(q.sql, /r\.company_id = \$1/);
    assert.match(q.sql, /r\.finished_at IS NULL/);
    assert.deepEqual(q.args, [COMPANY]);
  }
  assert.match(formatLiveRuns({ ...data, generatedAt: "2026-10-10T12:17:00Z" }), /17 min/);
  assert.match((await renderTelegramRuns(ctx, COMPANY)).toString(), /CTO/);
});

test("/runs sanitizes provider-controlled agent text and obeys output limits", () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({
    id: "run-" + i,
    agentName: "*Malicious* [link](https://invalid.test)",
    startedAt: "2026-10-10T12:00:00Z",
  }));
  const text = formatLiveRuns({ rows, total: 90, generatedAt: "2026-10-10T12:15:00Z" });
  assert.ok(text.length < 3400);
  assert.match(text, /Exibindo 8 de 80/);
  assert.ok(text.includes("\\*Malicious\\*"));
  assert.ok(text.includes("\u200b"));
  assert.doesNotMatch(text, /\[link\]\(https:\/\/invalid\.test\)/);
});

test("/health reports only sourced Observatory metrics and coverage", () => {
  const text = formatAgentHealth({
    windowHours: 24,
    summary: {
      agentsTotal: 115, runsTotal: 28, failures: 3,
      interrupted: 2, retries: 4, unknownCostRuns: 6,
    },
    coverage: { hasMoreAgents: true },
    agents: [{ name: "CTO", health: "degraded", failures: 3 }],
  });
  assert.match(text, /Saúde operacional/);
  assert.match(text, /Execuções: \*\*28\*\*/);
  assert.match(text, /Falhas: \*\*3\*\*/);
  assert.match(text, /CTO/);
  assert.match(text, /Amostra parcial/);
  assert.match(text, /não incluem saúde de VPS/);
});

test("operational Observatory commands refuse unexpected arguments", async () => {
  const ctx = {};
  assert.match(await renderTelegramRuns(ctx, COMPANY, "unexpected"), /Uso:/);
  assert.match(await renderTelegramHealth(ctx, COMPANY, "unexpected"), /Uso:/);
});

test("/runs exposes no data when scoped ledger is unavailable", async () => {
  await assert.rejects(getLiveRuns({}, COMPANY), /unavailable/);
});
