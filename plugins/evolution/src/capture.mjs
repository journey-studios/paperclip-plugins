export function isRevisionProducingActivity(action) {
  return action === "agent.config_rolled_back";
}

export function revisionReferenceFromActivity(payload) {
  // Generic revisionId fields can mean the rollback target, rather than the new
  // revision that records the rollback transition.
  for (const key of ["agentConfigRevisionId", "agent_config_revision_id", "configRevisionId"]) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function agentActivitySnapshot(agentSnapshot, action, details, currentStateReadAt, currentStateUpdatedAt) {
  return {
    ...agentSnapshot,
    activity: {
      action,
      details,
      partialSnapshot: true,
      partialReason: action.startsWith("agent.instructions_")
        ? "historical_instruction_content_unavailable"
        : "activity_snapshot_is_current_state",
      currentStateReadAt,
      currentStateUpdatedAt,
    },
  };
}

export function skillActivitySnapshot(skillSnapshot, action, details, currentStateReadAt, currentStateUpdatedAt) {
  return {
    ...skillSnapshot,
    activity: {
      action,
      details,
      partialSnapshot: true,
      partialReason: "skill_activity_snapshot_is_current_state",
      currentStateReadAt,
      currentStateUpdatedAt,
    },
  };
}

export function captureTimestamp(value) {
  const millis = value instanceof Date
    ? value.getTime()
    : typeof value === "string"
      ? Date.parse(value)
      : Number.NaN;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

export async function sourceItemExists(db, companyId, sourceType, sourceRef) {
  if (!sourceRef) return false;
  const rows = await db.query(
    "SELECT id FROM change_items WHERE company_id = $1 AND source_type = $2 AND source_ref = $3 LIMIT 1",
    [companyId, sourceType, sourceRef],
  );
  return rows.length > 0;
}

export async function sourceSnapshotId(db, companyId, entityType, entityId, sourceType, sourceRef) {
  const rows = await db.query(
    "SELECT id FROM change_snapshots WHERE company_id = $1 AND entity_type = $2 AND entity_id = $3 AND source_type = $4 AND source_ref = $5 ORDER BY captured_at DESC, created_at DESC LIMIT 1",
    [companyId, entityType, entityId, sourceType, sourceRef],
  );
  return rows[0]?.id ?? null;
}

export const RUN_METRIC_AGGREGATION_SQL =
  "count(*) FILTER (WHERE finished_at IS NOT NULL)::int AS runs, " +
  "count(*) FILTER (WHERE status = 'succeeded' AND finished_at IS NOT NULL)::int AS successes";
