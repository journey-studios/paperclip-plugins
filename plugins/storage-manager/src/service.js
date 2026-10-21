const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FOLDER = "storage-snapshot";
const FILE = "snapshot.json";
const MAX_TEXT_LENGTH = 1024 * 1024;
const MAX_HISTORY = 1008;
const MAX_STALENESS_MS = 30 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
// Directory ids come from the operator's collector config, so validate their shape.
const DIRECTORY_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
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
function percent(value, field) {
  const number = Number(value);
  if (typeof value !== "number" || !Number.isFinite(number) || number < 0 || number > 100) throw new Error("Invalid " + field);
  return Math.round(number * 10) / 10;
}
function load(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100000) throw new Error("Invalid " + field);
  return Math.round(value * 100) / 100;
}
// cpu and memory are optional: schema 1 collectors and failed probes simply omit them.
function sanitizeCpu(input) {
  const cpu = object(input);
  if (!cpu) return null;
  try {
    const cores = bytes(cpu.cores, "cpu cores");
    if (cores < 1 || cores > 4096) throw new Error("Invalid cpu cores");
    return { cores, usagePercent: percent(cpu.usagePercent, "cpu usage"), load1: load(cpu.load1, "load1"), load5: load(cpu.load5, "load5"), load15: load(cpu.load15, "load15") };
  } catch { return null; }
}
function sanitizeMemory(input) {
  const memory = object(input);
  if (!memory) return null;
  try {
    const totalBytes = bytes(memory.totalBytes, "memory total");
    const availableBytes = bytes(memory.availableBytes, "memory available");
    const usedBytes = bytes(memory.usedBytes, "memory used");
    const swapTotalBytes = bytes(memory.swapTotalBytes, "swap total");
    const swapUsedBytes = bytes(memory.swapUsedBytes, "swap used");
    if (!totalBytes || availableBytes > totalBytes || usedBytes > totalBytes || swapUsedBytes > swapTotalBytes) throw new Error("Inconsistent memory");
    return { totalBytes, availableBytes, usedBytes, usedPercent: percent(memory.usedPercent, "memory percent"), swapTotalBytes, swapUsedBytes };
  } catch { return null; }
}
const WORKER_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const WORKER_STATES = new Set(["created", "running", "paused", "restarting", "removing", "exited", "dead", "missing", "unknown"]);
const WORKER_HEALTH = new Set(["healthy", "unhealthy", "starting"]);
function optionalPercent(value, max = 100000) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value * 10) / 10 : null;
}
function optionalCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
// Workers are operator-listed containers; usage fields are optional and degrade to null one by one.
function sanitizeWorkers(input) {
  return (Array.isArray(input) ? input : []).slice(0, 12).flatMap((row) => {
    if (!object(row) || typeof row.id !== "string" || !WORKER_ID.test(row.id) || !WORKER_STATES.has(row.state)) return [];
    const startedAt = typeof row.startedAt === "string" && Number.isFinite(Date.parse(row.startedAt)) ? new Date(row.startedAt).toISOString() : null;
    return [{
      id: row.id,
      label: typeof row.label === "string" && row.label.length <= 70 && !row.label.includes("/") ? row.label : row.id,
      state: row.state,
      health: WORKER_HEALTH.has(row.health) ? row.health : null,
      startedAt: row.state === "running" ? startedAt : null,
      restartCount: optionalCount(row.restartCount) ?? 0,
      oomKilled: row.oomKilled === true,
      cpuPercent: optionalPercent(row.cpuPercent),
      memoryUsedBytes: optionalCount(row.memoryUsedBytes),
      memoryLimitBytes: optionalCount(row.memoryLimitBytes),
      memoryPercent: optionalPercent(row.memoryPercent, 100),
      pids: optionalCount(row.pids),
    }];
  });
}
function empty(companyId, status, reason) {
  return { companyId, status, reason, generatedAt: null, filesystem: null, cpu: null, memory: null, uptimeSeconds: null, workers: [], docker: [], directories: [], history: [], alerts: [], coverage: { partial: true, notes: ["No current validated snapshot is available."] } };
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
  if (!raw || (raw.schemaVersion !== 1 && raw.schemaVersion !== 2)) throw new Error("Unsupported snapshot schema");
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
    .filter((row) => object(row) && typeof row.id === "string" && DIRECTORY_ID.test(row.id))
    .slice(0, 30)
    .map((row) => ({
      id: row.id,
      // A label that looks like a path is replaced by the id so host paths are never shown.
      label: typeof row.label === "string" && row.label.length <= 70 && !row.label.includes("/") ? row.label : row.id,
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
        const point = { at: new Date(at).toISOString(), usedBytes: bytes(item.usedBytes, "history used"), availableBytes: bytes(item.availableBytes, "history available") };
        // Optional metrics are omitted when invalid; they never discard the required disk sample.
        try { if (item.cpuPercent !== undefined) point.cpuPercent = percent(item.cpuPercent, "history cpu"); } catch { /* omit */ }
        try { if (item.memoryUsedBytes !== undefined) point.memoryUsedBytes = bytes(item.memoryUsedBytes, "history memory"); } catch { /* omit */ }
        return [point];
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
    cpu: sanitizeCpu(raw.cpu),
    memory: sanitizeMemory(raw.memory),
    uptimeSeconds: Number.isSafeInteger(raw.uptimeSeconds) && raw.uptimeSeconds >= 0 ? raw.uptimeSeconds : null,
    workers: sanitizeWorkers(raw.workers),
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
