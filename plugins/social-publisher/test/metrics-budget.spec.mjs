import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { databaseContext, draftInput, SCHEMA } from "./helpers.mjs";
import { reserveMetricRead, collectPostMetrics } from "../src/metrics.js";
import { upsertAccount, updateAccount, recordReceipt } from "../src/catalog.js";
import { serviceCreateDraft } from "../src/service.js";
import { parseConfig } from "../src/config.js";

test("paid metric reads reserve a bounded daily budget atomically and deny unknown pricing", async () => {
  const f = await databaseContext();
  try {
    const account = { id: randomUUID(), apiCostApproved: true };
    assert.equal((await reserveMetricRead(f.ctx, f.companyId, account, {})).allowed, false);
    const config = {
      xMetricsReadCostCents: 5,
      xMetricsDailyBudgetCents: 5,
      metricsReadDailyLimit: 1,
    };
    const results = await Promise.all([
      reserveMetricRead(f.ctx, f.companyId, account, config),
      reserveMetricRead(f.ctx, f.companyId, account, config),
    ]);
    assert.equal(results.filter((row) => row.allowed).length, 1);
    const rows = await f.ctx.db.query(
      `SELECT reads,reserved_cost_cents FROM ${SCHEMA}.social_metric_read_budgets WHERE company_id=$1 AND account_id=$2`,
      [f.companyId, account.id],
    );
    assert.equal(rows[0].reads, 1);
    assert.equal(rows[0].reserved_cost_cents, 5);
  } finally {
    await f.close();
  }
});

test("metric snapshots avoid repeated provider reads and preserve explicit zero vs unknown cost", async () => {
  const f = await databaseContext();
  try {
    let network = 0;
    f.ctx.http = {
      fetch: async () => {
        network++;
        throw new Error("No provider request allowed");
      },
    };
    const account = await upsertAccount(f.ctx, f.companyId, {
      platform: "x",
      accountName: "Tessel",
      accountIdExternal: "123",
      credentialsRef: { type: "secret_ref", secretId: randomUUID() },
    });
    await updateAccount(f.ctx, f.companyId, account.id, {
      status: "connected",
      verificationStatus: "VERIFIED",
      apiCostApproved: true,
    });
    const { post } = await serviceCreateDraft(
      f.ctx,
      f.companyId,
      draftInput({ platforms: ["x"], targets: [{ platform: "x", accountId: account.id }] }),
      f.actor,
      f.config,
    );
    await recordReceipt(f.ctx, f.companyId, {
      postId: post.id,
      platform: "x",
      accountId: account.id,
      status: "published",
      platformPostId: "999",
      platformPostUrl: "https://x.com/i/web/status/999",
      costCents: 2,
    });
    const denied = await collectPostMetrics(f.ctx, f.companyId, post.id, f.config);
    assert.match(denied.performance[0].reason, /COST_OR_BUDGET/);
    assert.equal(denied.performance[0].costStatus, "ESTIMATED");
    assert.equal(denied.performance[0].actualCostCents, null);
    const metric = {
      likes: { status: "KNOWN", value: 0 },
      impressions: { status: "UNKNOWN", value: null },
    };
    await f.ctx.db.execute(
      `INSERT INTO ${SCHEMA}.social_metric_snapshots (id,company_id,post_id,platform,account_id,external_post_id,metrics,status) VALUES($1,$2,$3,'x',$4,'999',$5::jsonb,'PARTIAL')`,
      [randomUUID(), f.companyId, post.id, account.id, JSON.stringify(metric)],
    );
    const cached = await collectPostMetrics(f.ctx, f.companyId, post.id, f.config);
    assert.equal(cached.performance[0].cached, true);
    assert.equal(cached.performance[0].metrics.likes.value, 0);
    assert.equal(cached.performance[0].metrics.impressions.value, null);
    assert.equal(network, 0);
  } finally {
    await f.close();
  }
});

test("omitted safety config keeps dry runs and the global kill switch enabled", () => {
  const config = parseConfig({ dryRunOnly: false });
  assert.equal(config.killSwitch, true);
  assert.equal(config.dryRunOnly, false);
  assert.equal(parseConfig({}).dryRunOnly, true);
});
