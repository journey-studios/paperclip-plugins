const NOT_RUN_MAX_SECONDS = 60;
const NOT_STARTED = /not started|budget|spending limit|billing|payment|recent account payments/i;

export function mayNotHaveRun(run) {
  if (run.status !== "completed" || !["failure", "startup_failure", "cancelled"].includes(run.conclusion)) return false;
  if (!(run.output?.annotations_count > 0)) return false;
  const seconds = (Date.parse(run.completed_at) - Date.parse(run.started_at)) / 1000;
  return Number.isFinite(seconds) && seconds <= NOT_RUN_MAX_SECONDS;
}

/** Read failures preserve the reported failure; only an explicit GitHub annotation proves "not run". */
export async function notStartedReason(get, owner, repo, id) {
  try {
    const response = await get(`/repos/${owner}/${repo}/check-runs/${id}/annotations?per_page=10`);
    if (!response.ok) return null;
    const message = (await response.json()).map((a) => String(a?.message ?? "")).find((m) => NOT_STARTED.test(m));
    if (message) return message.replace(/\s+/g, " ").trim().slice(0, 160);
    return null;
  } catch {
    return null;
  }
}
