const RETRYABLE_CONSTRAINTS = new Set([
  "evolution_change_items_company_set_fkey",
  "evolution_change_links_company_set_fkey",
]);

function isCaptureMergeForeignKeyFailure(error: unknown): boolean {
  const record = error !== null && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  // Driver errors retain SQLSTATE; worker RPC errors may only retain a message.
  if (record.code !== undefined && String(record.code) !== "23503" && record.code !== -32603) return false;
  const constraint = record.constraint_name ?? record.constraint ?? record.constraintName;
  if (typeof constraint === "string" && RETRYABLE_CONSTRAINTS.has(constraint)) {
    return String(record.code) === "23503";
  }
  const message = typeof error === "string" ? error : record.message;
  if (typeof message !== "string" || !/foreign\s+key|\b23503\b/i.test(message)) return false;
  return [...RETRYABLE_CONSTRAINTS].some((name) =>
    new RegExp("\\b" + name + "\\b").test(message),
  );
}

/**
 * A merge can remove a source after capture resolved its ID but before INSERT.
 * Retry the entire idempotent capture so ensureChangeSet resolves a valid parent
 * again. Do not retry arbitrary database failures or loop indefinitely.
 */
export async function withCaptureRetry<T>(capture: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await capture();
    } catch (error) {
      if (attempt >= 2 || !isCaptureMergeForeignKeyFailure(error)) throw error;
    }
  }
}
