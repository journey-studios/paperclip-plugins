const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FOLDER = "storage-snapshot";
const FILE = "snapshot.json";
const MAX_TEXT_LENGTH = 1024 * 1024;
const MAX_HISTORY = 1008;
const MAX_STALENESS_MS = 30 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const DIRECTORY_IDS = new Set([
  "containerd", "containerd-snapshots", "containerd-content", "docker-volumes",
  "paperclip-data", "paperclip-pnpm", "paperclip-projects", "repos", "paperclip-backups",
  "builds", "rust-toolchain", "emsdk", "root-home",
]);
const DOCKER_IDS = new Set(["images", "containers", "local-volumes", "build-cache"]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function bytes(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid " + field);
  return value;
}
function iso(value, field) {
  if (typeof value !== "string") throw new Error("Invalid " + field);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error("Invalid " + field);
  return date;
}
function uuid(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw Object.assign(new Error("Invalid company scope"), { status: 400 });
  return value;
}
export function parseLimit(value) {
  if (value === undefined || value === null || value === "") return 10;
  const num = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isInteger(num) || num < 1 || num > 20) throw Object.assign(new Error("limit must be 1 to 20"), { status: 400 });
  return num;
}
function empty(companyId, status, reason) {
  return { companyId, status, reason, generatedAt: null, filesystem: null, docker: [], directories: [], history: [], alerts: [], coverage: { partial: true, notes: ["No current validated snapshot is available."] } };
}
function safeCoverage(raw) {
  const coverage = object(raw);
  const issues = Array.isArray(coverage?.issues) ? coverage.issues.slice(0, 30) : [];
  const cleaned = issues.map((issue) => ({
    source: typeof issue?.source === "string" && /^[a-z0-9-]{1,48}$/.test(issue.source) ? issue.source : "unknown",
    code: typeof issue?.code === "string" && /^[a-z_]{1,48}$/.test(issue.code) ? issue.code : "collection_error",
  }));
  return { partial: Boolean(coverage?.partial) || cleaned.length > 0, issues: cleaned, notes: ["Directory sizes can overlap; Docker layer sizes are shared and are not additive."] };
}
export function sanitizeSnapshot(input, now = Date.now()) {
  const raw = object(input);
  if (!raw || raw.schemaVersion !== 1) throw new Error("Unsupported snapshot schema");
  const timestamp = iso(raw.generatedAt, "generatedAt").getTime();
  if (timestamp > now + MAX_FUTURE_SKEW_MS) throw new Error("Snapshot generated in the future");
  const fs = object(raw.filesystem);
  if (!fs || fs.mount !== "/") throw new Error("Unexpected filesystem");
  const totalBytes = bytes(fs.totalBytes, "totalBytes");
  const usedBytes = bytes(fs.usedBytes, "usedBytes");
  const availableBytes = bytes(fs.availableBytes, "availableBytes");
  if (!totalBytes || usedBytes > totalBytes || availableBytes > totalBytes) throw new Error("Inconsistent filesystem sizes");
  const usedPercent = Number(fs.usedPercent);
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) throw new Error("Invalid usedPercent");
  const directories = (Array.isArray(raw.directories) ? raw.directories : [])
    .filter((row) => object(row) && DIRECTORY_IDS.has(row.id))
    .slice(0, 30)
    .map((row) => ({
      id: row.id,
      label: typeof row.label === "string" && row.label.length <= 70 ? row.label : row.id,
      bytes: row.status === "ok" ? bytes(row.bytes, "directory bytes") : null,
      status: row.status === "ok" ? "ok" : row.status === "missing" ? "missing" : "unavailable",
    }));
  const docker = (Array.isArray(raw.docker) ? raw.docker : [])
    .filter((row) => object(row) && DOCKER_IDS.has(row.id))
    .slice(0, 4)
    .map((row) => ({
      id: row.id, label: typeof row.label === "string" && row.label.length <= 45 ? row.label : row.id,
      sizeBytes: bytes(row.sizeBytes, "docker size"),
      reclaimableBytes: bytes(row.reclaimableBytes, "docker reclaimable"),
      count: bytes(row.count, "docker count"), active: bytes(row.active, "docker active"),
      approximate: true,
    }));
  const history = (Array.isArray(raw.history) ? raw.history : [])
    .slice(-MAX_HISTORY).flatMap((item) => {
      try {
        if (!object(item)) return [];
        const at = iso(item.at, "history at").getTime();
        if (at > now + MAX_FUTURE_SKEW_MS || at > timestamp) return [];
        return [{ at: new Date(at).toISOString(), usedBytes: bytes(item.usedBytes, "history used"), availableBytes: bytes(item.availableBytes, "history available") }];
      } catch { return []; }
    }).sort((a, b) => a.at.localeCompare(b.at));
  const alertPolicy = object(raw.alertPolicy);
  const warn = Number.isSafeInteger(alertPolicy?.warnFreeBytes) && alertPolicy.warnFreeBytes >= 0 ? alertPolicy.warnFreeBytes : null;
  const critical = Number.isSafeInteger(alertPolicy?.criticalFreeBytes) && alertPolicy.criticalFreeBytes >= 0 ? alertPolicy.criticalFreeBytes : null;
  const alerts = [];
  if (critical !== null && availableBytes < critical) alerts.push({ level: "critical", code: "below_critical_free_space", configuredThresholdBytes: critical });
  else if (warn !== null && availableBytes < warn) alerts.push({ level: "warning", code: "below_warning_free_space", configuredThresholdBytes: warn });
  const stale = timestamp < now - MAX_STALENESS_MS;
  return {
    status: stale ? "stale" : "ready",
    reason: stale ? "snapshot_outdated" : null,
    generatedAt: new Date(timestamp).toISOString(),
    filesystem: { mount: "/", totalBytes, usedBytes, availableBytes, usedPercent },
    directories, docker, history, alerts, coverage: safeCoverage(raw.coverage),
  };
}
export async function getOverview(ctx, companyValue, now = Date.now()) {
  const companyId = uuid(companyValue);
  let status;
  try { status = await ctx.localFolders.status(companyId, FOLDER); }
  catch { return empty(companyId, "unavailable", "folder_unavailable"); }
  if (!status?.configured) return empty(companyId, "unconfigured", "configure_read_only_folder");
  if (!status.healthy || status.access !== "read") return empty(companyId, "unavailable", "folder_not_healthy");
  let raw;
  try {
    raw = await ctx.localFolders.readText(companyId, FOLDER, FILE);
  } catch { return empty(companyId, "unavailable", "snapshot_unreadable"); }
  if (typeof raw !== "string" || raw.length > MAX_TEXT_LENGTH) return empty(companyId, "invalid", "invalid_snapshot_size");
  try { return { companyId, ...sanitizeSnapshot(JSON.parse(raw), now) }; }
  catch { return empty(companyId, "invalid", "invalid_snapshot"); }
}
export async function getHotspots(ctx, companyId, limit = 10, now = Date.now()) {
  const data = await getOverview(ctx, companyId, now);
  return {
    companyId: data.companyId,
    status: data.status,
    reason: data.reason,
    generatedAt: data.generatedAt,
    coverage: data.coverage,
    note: "Nested paths and Docker shared layers must not be summed.",
    directories: data.directories.filter((dir) => dir.status === "ok" && dir.bytes !== null)
      .sort((a, b) => b.bytes - a.bytes).slice(0, parseLimit(limit)),
  };
}
