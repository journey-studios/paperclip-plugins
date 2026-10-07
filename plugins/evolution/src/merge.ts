import type { PluginContext } from "@paperclipai/plugin-sdk";

const INCOMPLETE = "Merge incomplete; retry after concurrent capture settles.";

/**
 * The plugin database SDK has no transaction API. Transfers are resumable, and
 * the composite NO ACTION foreign keys in migration 002 are the final barrier
 * against losing a capture that commits after the guarded DELETE's snapshot.
 */
export async function mergeChangeSets(
  ctx: PluginContext,
  companyId: string,
  sourceChangeSetId: string,
  targetChangeSetId: string,
): Promise<{ ok: true; targetChangeSetId: string }> {
  if (sourceChangeSetId === targetChangeSetId) {
    throw new Error("Source and target Change Sets must differ");
  }
  const namespace = ctx.db.namespace;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(namespace)) {
    throw new Error("Invalid plugin database namespace");
  }
  const table = (name: string) => `"${namespace}"."${name}"`;
  const sets = table("change_sets");
  const items = table("change_items");
  const evidence = table("change_evidence");
  const conclusions = table("change_conclusions");
  const links = table("change_links");
  const metrics = table("change_metrics");
  const aliases = table("change_context_aliases");
  const params = [companyId, sourceChangeSetId, targetChangeSetId];

  const rows = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ${sets} WHERE company_id = $1 AND id IN ($2, $3)`,
    params,
  );
  if (rows.length !== 2) throw new Error("Source or target Change Set not found");

  // Persist the destination before moving any rows. A retry must not scatter a
  // partially transferred set across another target after an intermediate error.
  const intent = await ctx.db.execute(
    `UPDATE ${sets} SET merge_target_id = $3 WHERE company_id = $1 AND id = $2 ` +
      "AND (merge_target_id IS NULL OR merge_target_id = $3) " +
      `AND EXISTS (SELECT 1 FROM ${sets} AS destination WHERE destination.company_id = $1 AND destination.id = $3 ` +
      "AND (destination.merge_target_id IS NULL OR destination.merge_target_id <> $2) FOR UPDATE)",
    params,
  );
  if (intent.rowCount !== 1) {
    throw new Error("Merge cannot start; source is unavailable, target would create a cycle, or source is already merging into another target.");
  }

  for (const child of [items, evidence, conclusions]) {
    await ctx.db.execute(
      `UPDATE ${child} SET change_set_id = $3 WHERE company_id = $1 AND change_set_id = $2`,
      params,
    );
  }

  await ctx.db.execute(
    `INSERT INTO ${links} (id, company_id, change_set_id, link_type, reference_id, label, metadata) ` +
      `SELECT gen_random_uuid(), company_id, $3::uuid, link_type, reference_id, label, metadata ` +
      `FROM ${links} WHERE company_id = $1 AND change_set_id = $2 ` +
      "ON CONFLICT (company_id, change_set_id, link_type, reference_id) DO NOTHING",
    params,
  );
  // A link captured after the copy must survive unless its target equivalent
  // already exists. Deleting all source links here would lose that new link.
  await ctx.db.execute(
    `DELETE FROM ${links} AS source_link WHERE source_link.company_id = $1 AND source_link.change_set_id = $2 ` +
      `AND EXISTS (SELECT 1 FROM ${links} AS target_link WHERE target_link.company_id = source_link.company_id ` +
      "AND target_link.change_set_id = $3 AND target_link.link_type = source_link.link_type " +
      "AND target_link.reference_id = source_link.reference_id)",
    params,
  );
  // Metrics are derived and will be recomputed by the caller after success.
  await ctx.db.execute(
    `DELETE FROM ${metrics} WHERE company_id = $1 AND change_set_id = $2`,
    params.slice(0, 2),
  );
  // Capture commonly adds items while the other child tables are transferred.
  await ctx.db.execute(
    `UPDATE ${items} SET change_set_id = $3 WHERE company_id = $1 AND change_set_id = $2`,
    params,
  );

  // Keep source contexts resolving to the destination after deletion. Existing
  // aliases must follow later merges as well, so A -> B -> C still resolves A.
  await ctx.db.execute(
    `UPDATE ${aliases} SET change_set_id = $3 WHERE company_id = $1 AND change_set_id = $2`,
    params,
  );
  await ctx.db.execute(
    `INSERT INTO ${aliases} (company_id, source_context_key, change_set_id) ` +
      `SELECT company_id, source_context_key, $3::uuid FROM ${sets} ` +
      "WHERE company_id = $1 AND id = $2 AND source_context_key IS NOT NULL " +
      "ON CONFLICT (company_id, source_context_key) DO UPDATE SET change_set_id = EXCLUDED.change_set_id",
    params,
  );

  const childGuards = [items, evidence, conclusions, links, metrics, aliases].map(
    (child, index) => `AND NOT EXISTS (SELECT 1 FROM ${child} AS child_${index} ` +
      `WHERE child_${index}.company_id = $1 AND child_${index}.change_set_id = $2)`,
  ).join(" ");
  const pendingMergeGuard = `AND NOT EXISTS (SELECT 1 FROM ${sets} AS incoming_merge ` +
    "WHERE incoming_merge.company_id = $1 AND incoming_merge.merge_target_id = $2 AND incoming_merge.id <> $2)";
  try {
    const deleted = await ctx.db.execute(
      `DELETE FROM ${sets} WHERE company_id = $1 AND id = $2 ` +
        `AND EXISTS (SELECT 1 FROM ${sets} AS target_set WHERE target_set.company_id = $1 AND target_set.id = $3) ` +
        childGuards + " " + pendingMergeGuard,
      params,
    );
    if (deleted.rowCount !== 1) throw new Error(INCOMPLETE);
  } catch {
    // Never acknowledge an incomplete merge as successful or expose SQL details.
    // Already transferred rows are preserved, so retry can finish the merge.
    throw new Error(INCOMPLETE);
  }
  return { ok: true, targetChangeSetId };
}
