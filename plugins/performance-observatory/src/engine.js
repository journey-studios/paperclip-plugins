import { record, validateResult } from "./contract.js";
import { enqueue, settings, table } from "./store.js";

async function controller(ctx, config, path, body) {
  if (!config.controllerUrl || !config.controllerTokenRef) throw new Error("CONTROLLER_NOT_CONFIGURED");
  const url = new URL(config.controllerUrl);
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) throw new Error("INVALID_CONTROLLER_URL");
  const token = await ctx.secrets.resolve(config.controllerTokenRef, { companyId: config.companyId });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  let method = "GET";
  let payload;
  if (body) { method = "POST"; payload = JSON.stringify(body); }
  let response;
  try { response = await fetch(new URL(path, url), { method, headers, body: payload, redirect: "error", signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error("CONTROLLER_UNREACHABLE"); }
  if (!response.ok) throw new Error(`CONTROLLER_HTTP_${response.status}`);
  const text = await response.text();
  if (text.length > 500000) throw new Error("CONTROLLER_RESPONSE_TOO_LARGE");
  return record(JSON.parse(text));
}
async function acknowledge(ctx, config, runId) {
  try { await controller(ctx, config, `/runs/${runId}/ack`, { companyId: config.companyId }); }
  catch { ctx.logger.warn("performance: result retained by controller until acknowledgement", { companyId: config.companyId, runId }); }
}
export async function reconcile(ctx) {
  for (const company of await ctx.companies.list({ limit: 200 })) {
    const companyId = company.id;
    let config;
    try { config = { ...await settings(ctx, companyId), companyId }; }
    catch { ctx.logger.warn("performance: invalid company configuration", { companyId }); continue; }
    for (const target of config.targets.filter((t) => t.enabled)) {
      const pendingTarget = await ctx.db.query(`SELECT id FROM ${table(ctx)} WHERE company_id = $1 AND target_key = $2 AND status IN ('queued','running') LIMIT 1`, [companyId, target.key]);
      if (pendingTarget.length) continue;
      const recent = await ctx.db.query(`SELECT created_at FROM ${table(ctx)} WHERE company_id = $1 AND target_key = $2 ORDER BY created_at DESC LIMIT 1`, [companyId, target.key]);
      if (recent.length && Date.now() - new Date(recent[0].created_at).getTime() < target.intervalMinutes * 60000) continue;
      const slot = Math.floor(Date.now() / (target.intervalMinutes * 60000));
      try { await enqueue(ctx, companyId, target.key, "schedule", `schedule:${slot}`); }
      catch { ctx.logger.warn("performance: could not schedule target", { companyId, targetKey: target.key }); }
    }
    const pending = await ctx.db.query(`SELECT id, status, target_snapshot FROM ${table(ctx)}
      WHERE company_id = $1 AND status IN ('queued','running') ORDER BY created_at ASC LIMIT 40`, [companyId]);
    for (const run of pending) {
      let receivedCompletion = false;
      try {
        let state;
        if (run.status === "queued") {
          state = await controller(ctx, config, "/runs", { id: run.id, companyId, target: run.target_snapshot });
          await ctx.db.execute(`UPDATE ${table(ctx)} SET status = 'running' WHERE company_id = $1 AND id = $2 AND status = 'queued'`, [companyId, run.id]);
        } else {
          state = await controller(ctx, config, `/runs/${run.id}?companyId=${companyId}`);
        }
        if (state.status === "completed") {
          receivedCompletion = true;
          const result = validateResult(state.result, run.target_snapshot);
          let status = "passed";
          if (!result.gatePassed) status = "regression";
          await ctx.db.execute(`UPDATE ${table(ctx)} SET status = $3, result = $4::jsonb, finished_at = now(), error_code = NULL
            WHERE company_id = $1 AND id = $2 AND status IN ('queued','running')`, [companyId, run.id, status, JSON.stringify(result)]);
          await acknowledge(ctx, config, run.id);
        } else if (state.status === "failed") {
          let code = "COLLECTION_FAILED";
          if (typeof state.errorCode === "string" && /^[A-Z0-9_]{1,80}$/.test(state.errorCode)) code = state.errorCode;
          await ctx.db.execute(`UPDATE ${table(ctx)} SET status = 'failed', error_code = $3, finished_at = now()
            WHERE company_id = $1 AND id = $2 AND status IN ('queued','running')`, [companyId, run.id, code]);
          await acknowledge(ctx, config, run.id);
        }
      } catch (error) {
        // Transport failures remain resumable; an already submitted container must never be duplicated.
        let code = "RECONCILIATION_FAILED";
        if (error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message)) code = error.message;
        if (receivedCompletion || /^CONTROLLER_HTTP_(400|404|409|413|422)$/.test(code)) {
          await ctx.db.execute(`UPDATE ${table(ctx)} SET status = 'failed', error_code = $3, finished_at = now() WHERE company_id = $1 AND id = $2 AND status IN ('queued','running')`, [companyId, run.id, code]);
          if (receivedCompletion) await acknowledge(ctx, config, run.id);
          continue;
        }
        await ctx.db.execute(`UPDATE ${table(ctx)} SET error_code = $3 WHERE company_id = $1 AND id = $2 AND status IN ('queued','running')`, [companyId, run.id, code]);
        if (code === "CONTROLLER_UNREACHABLE") break;
      }
    }
  }
}
