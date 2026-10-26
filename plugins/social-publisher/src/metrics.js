import { randomUUID } from "node:crypto";
import { getPost, getAccount, listReceiptsForPost, tablePrefix } from "./catalog.js";
import { resolveAccountCredentials } from "./oauth.js";
import { getAdapter } from "./adapters/index.js";
import { makeFetch } from "./transport.js";

export async function collectPostMetrics(ctx, companyId, postId, config, injectedFetch) {
  const post = await getPost(ctx, companyId, postId);
  if (!post) throw new Error("POST_NOT_FOUND");
  const receipts = await listReceiptsForPost(ctx, companyId, post.id);
  const performance = [];
  for (const target of post.targets) {
    const receipt = receipts.find(
      (item) => item.platform === target.platform && item.accountId === target.accountId,
    );
    const summary = {
      platform: target.platform,
      accountId: target.accountId,
      externalPostId: receipt?.platformPostId ?? null,
      costCents: receipt?.costCents ?? null,
      costStatus: receipt?.costStatus ?? "UNKNOWN",
      actualCostCents: receipt?.actualCostCents ?? null,
      estimatedCostCents: receipt?.estimatedCostCents ?? null,
      status: "UNKNOWN",
      metrics: {},
    };
    if (receipt?.status !== "published" || !receipt.platformPostId || !target.accountId) {
      summary.reason = "NO_REAL_PUBLICATION_RECEIPT";
      performance.push(summary);
      continue;
    }
    const account = await getAccount(ctx, companyId, target.accountId);
    if (!account || account.verificationStatus !== "VERIFIED" || account.status !== "connected") {
      summary.reason = "ACCOUNT_NOT_VERIFIED";
      performance.push(summary);
      continue;
    }
    const cached = await ctx.db.query(
      `SELECT metrics,status,collected_at AS "collectedAt" FROM ${tablePrefix(ctx)}.social_metric_snapshots WHERE company_id=$1 AND post_id=$2 AND account_id=$3 AND collected_at >= now() - ($4 * interval '1 second') ORDER BY collected_at DESC LIMIT 1`,
      [companyId, post.id, account.id, Math.max(300, config.metricsCacheTtlSeconds ?? 3600)],
    );
    if (cached.length) {
      performance.push({ ...summary, ...cached[0], cached: true });
      continue;
    }
    if (account.platform === "x") {
      const reservation = await reserveMetricRead(ctx, companyId, account, config);
      if (!reservation.allowed) {
        summary.reason = reservation.reason;
        performance.push(summary);
        continue;
      }
      summary.reservedReadCostCents = reservation.reservedCostCents;
    }
    try {
      const adapter = getAdapter(target.platform);
      const credentials = await resolveAccountCredentials(ctx, companyId, account, config);
      const result = await adapter.readMetrics({
        account: { ...account, credentials },
        platformPostId: receipt.platformPostId,
        fetchImpl: injectedFetch ?? makeFetch(ctx),
      });
      await ctx.db.execute(
        `INSERT INTO ${tablePrefix(ctx)}.social_metric_snapshots (id,company_id,post_id,platform,account_id,external_post_id,metrics,status) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [
          randomUUID(),
          companyId,
          post.id,
          target.platform,
          target.accountId,
          receipt.platformPostId,
          JSON.stringify(result.metrics),
          result.status,
        ],
      );
      performance.push({ ...summary, ...result });
    } catch {
      performance.push({ ...summary, reason: "PROVIDER_METRICS_UNAVAILABLE" });
    }
  }
  return {
    internalPostId: post.rootPostId ?? post.id,
    version: post.version,
    campaignId: post.campaign,
    productionCostCents: post.metadata?.productionCostCents ?? null,
    performance,
    attribution: {
      status: "UNKNOWN",
      owner: "JOU-1109 / JOU-1115",
      joinKeys: ["internal_post_id", "utm_content", "utm_campaign", "utm_source"],
      revenue: null,
      roi: null,
      note: "Ausência de eventos de pagamento não equivale a receita zero; correlação por campanha não prova causalidade.",
    },
  };
}

export async function reserveMetricRead(ctx, companyId, account, config) {
  const cost = config.xMetricsReadCostCents;
  const budget = config.xMetricsDailyBudgetCents;
  if (
    account.apiCostApproved !== true ||
    !Number.isInteger(cost) ||
    cost < 0 ||
    !Number.isInteger(budget) ||
    budget < cost
  )
    return { allowed: false, reason: "API_READ_COST_OR_BUDGET_NOT_APPROVED" };
  await ctx.db.execute(
    `INSERT INTO ${tablePrefix(ctx)}.social_metric_read_budgets (company_id,account_id,day) VALUES ($1,$2,(now() AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING`,
    [companyId, account.id],
  );
  const reserved = await ctx.db.execute(
    `UPDATE ${tablePrefix(ctx)}.social_metric_read_budgets SET reads=reads+1,reserved_cost_cents=reserved_cost_cents+$3 WHERE company_id=$1 AND account_id=$2 AND day=(now() AT TIME ZONE 'UTC')::date AND reads < $4 AND reserved_cost_cents+$3 <= $5`,
    [
      companyId,
      account.id,
      cost,
      Math.max(1, Math.min(100, config.metricsReadDailyLimit ?? 10)),
      budget,
    ],
  );
  if (reserved.rowCount !== 1) return { allowed: false, reason: "API_READ_DAILY_LIMIT_OR_BUDGET" };
  return { allowed: true, reservedCostCents: cost };
}
