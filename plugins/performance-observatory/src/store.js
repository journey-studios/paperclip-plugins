import { createHash, randomUUID } from "node:crypto";
import { configOf, integer, safeTarget, uuid } from "./contract.js";
export function table(ctx) {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace)) throw new Error("INVALID_NAMESPACE");
  return `${ctx.db.namespace}.runs`;
}
export async function settings(ctx, companyId) {
  return configOf(await ctx.config.get(uuid(companyId)));
}
export async function targets(ctx, companyId) {
  return (await settings(ctx, companyId)).targets.map(safeTarget);
}
export async function listRuns(ctx, companyId, params = {}) {
  const clauses = ["company_id = $1"];
  const values = [uuid(companyId)];
  for (const [key, column] of [["targetKey", "target_key"], ["environment", "environment"], ["projectId", "project_id"]]) {
    if (!params[key]) continue;
    values.push(String(params[key]));
    clauses.push(`${column} = $${values.length}`);
  }
  if (params.before) {
    const before = new Date(String(params.before));
    if (!Number.isFinite(before.getTime())) throw new Error("INVALID_CURSOR");
    values.push(before.toISOString());
    clauses.push(`created_at < $${values.length}`);
  }
  values.push(integer(Number(params.limit ?? 100), 1, 200));
  return ctx.db.query(`SELECT id, project_id, target_key, title, environment, scenario, profile, status, source,
    created_at, finished_at, error_code, result FROM ${table(ctx)} WHERE ${clauses.join(" AND ")}
    ORDER BY created_at DESC, id DESC LIMIT $${values.length}`, values);
}
export async function getRun(ctx, companyId, runId) {
  const rows = await ctx.db.query(`SELECT id, project_id, target_key, title, environment, scenario, profile, status,
    source, created_at, finished_at, error_code, result FROM ${table(ctx)} WHERE company_id = $1 AND id = $2 LIMIT 1`, [uuid(companyId), uuid(runId)]);
  return rows[0] ?? null;
}
export async function enqueue(ctx, companyId, targetKey, source, requestKey) {
  uuid(companyId);
  if (typeof requestKey !== "string" || requestKey.length < 1 || requestKey.length > 160) throw new Error("REQUEST_KEY_REQUIRED");
  const config = await settings(ctx, companyId);
  const target = config.targets.find((item) => item.key === targetKey);
  if (!target) throw new Error("TARGET_NOT_FOUND");
  if (!await ctx.projects.get(target.projectId, companyId)) throw new Error("PROJECT_NOT_IN_COMPANY");
  const digest = createHash("sha256").update(`${target.key}:${requestKey}`).digest("hex");
  const id = randomUUID();
  await ctx.db.execute(`INSERT INTO ${table(ctx)}
    (id, company_id, project_id, target_key, title, environment, scenario, profile, status, source, request_key, target_snapshot)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11::jsonb) ON CONFLICT (company_id, request_key) DO NOTHING`,
    [id, companyId, target.projectId, target.key, target.title, target.environment, target.scenario, target.profile, source, digest, JSON.stringify(target)]);
  const rows = await ctx.db.query(`SELECT id FROM ${table(ctx)} WHERE company_id = $1 AND request_key = $2 LIMIT 1`, [companyId, digest]);
  return getRun(ctx, companyId, rows[0].id);
}
