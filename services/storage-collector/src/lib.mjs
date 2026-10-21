// Host collector: a strictly allowlisted, read-only inventory. No arbitrary user paths.
import { cpus as osCpus, loadavg as osLoadavg, uptime as osUptime } from "node:os";

// Generic defaults for any Linux VPS; paths that do not exist are reported as "missing".
// Operators replace them with a root-owned JSON file (VPS_STATUS_DIRECTORIES_FILE).
export const DIRECTORIES = Object.freeze([
  { id: "docker-data", label: "Docker · dados", path: "/var/lib/docker" },
  { id: "containerd", label: "Containerd", path: "/var/lib/containerd" },
  { id: "logs", label: "Logs do sistema", path: "/var/log" },
  { id: "home", label: "Usuários (home)", path: "/home" },
  { id: "root-home", label: "Host · root", path: "/root" },
  { id: "opt", label: "Aplicações (opt)", path: "/opt" },
  { id: "srv", label: "Serviços (srv)", path: "/srv" },
  { id: "www", label: "Sites (www)", path: "/var/www" },
]);
export const MAX_DIRECTORIES = 30;
export const MAX_WORKERS = 12;
export const MAX_WORKTREE_ROOTS = 6;
export const MAX_WORKTREES_PER_ROOT = 40;
const WORKTREE_NAME = /^[A-Za-z0-9._-]{1,120}$/;
const WORKER_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
// Docker container names: no leading "-" or "/" so a name can never act as an option or a path.
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const DIRECTORY_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const DOCKER_KINDS = {
  Images: { id: "images", label: "Imagens" },
  Containers: { id: "containers", label: "Containers" },
  "Local Volumes": { id: "local-volumes", label: "Volumes" },
  "Build Cache": { id: "build-cache", label: "Cache de build" },
};
const safeNumber = (value) => Number.isSafeInteger(value) && value >= 0;
const strictInt = (value) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || !/^\d+$/.test(String(value))) throw new Error("Expected a non-negative integer");
  return result;
};
export function parseDf(text) {
  const lines = String(text).trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 2) throw new Error("Unexpected df output");
  const parts = lines[1].split(/\s+/);
  if (parts.length !== 4 || !/^\d+%$/.test(parts[3])) throw new Error("Unexpected df columns");
  const [totalBytes, usedBytes, availableBytes] = parts.slice(0, 3).map(strictInt);
  const usedPercent = strictInt(parts[3].slice(0, -1));
  if (totalBytes <= 0 || usedBytes > totalBytes || availableBytes > totalBytes || usedPercent > 100) throw new Error("Inconsistent df values");
  return { mount: "/", totalBytes, usedBytes, availableBytes, usedPercent };
}
export function parseDu(text) {
  const match = /^\s*(\d+)\s+[^\r\n]+\s*$/.exec(String(text));
  if (!match) throw new Error("Unexpected du output");
  return strictInt(match[1]);
}
export function parseHumanBytes(text) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)(?:\s|$)/i.exec(String(text));
  if (!match) throw new Error("Unexpected Docker size");
  const unit = match[2].toLowerCase();
  const binary = unit.includes("ib");
  const order = { b: 0, kb: 1, mb: 2, gb: 3, tb: 4, kib: 1, mib: 2, gib: 3, tib: 4 }[unit];
  const n = Number(match[1]) * ((binary ? 1024 : 1000) ** order);
  if (!Number.isSafeInteger(Math.round(n))) throw new Error("Docker size too large");
  return Math.round(n);
}
export function parseDocker(text) {
  const result = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    const row = JSON.parse(line);
    const kind = DOCKER_KINDS[row.Type];
    if (!kind || seen.has(kind.id)) continue;
    const count = strictInt(row.TotalCount);
    const active = strictInt(row.Active);
    if (active > count) throw new Error("Inconsistent Docker count");
    result.push({
      id: kind.id, label: kind.label,
      count, active,
      sizeBytes: parseHumanBytes(row.Size),
      reclaimableBytes: parseHumanBytes(row.Reclaimable),
      approximate: true,
    });
    seen.add(kind.id);
  }
  if (!result.length) throw new Error("No Docker metrics");
  return result;
}
export function makeHistory(previous, snapshot, limit = 1008) {
  const history = Array.isArray(previous?.history) ? previous.history : [];
  const recent = history.filter((item) => item && typeof item.at === "string" &&
    Number.isFinite(Date.parse(item.at)) && safeNumber(item.usedBytes) && safeNumber(item.availableBytes) &&
    Date.parse(item.at) < Date.parse(snapshot.generatedAt));
  const point = {
    at: snapshot.generatedAt,
    usedBytes: snapshot.filesystem.usedBytes,
    availableBytes: snapshot.filesystem.availableBytes,
  };
  if (snapshot.cpu) point.cpuPercent = snapshot.cpu.usagePercent;
  if (snapshot.memory) point.memoryUsedBytes = snapshot.memory.usedBytes;
  recent.push(point);
  return recent.slice(-Math.max(1, Math.min(1008, limit)));
}
export function parseAlertPolicy(env) {
  const value = (key) => {
    if (env[key] === undefined || env[key] === "") return null;
    const n = strictInt(env[key]);
    if (n < 1) throw new Error(key + " must be positive");
    return n;
  };
  const warnFreeBytes = value("STORAGE_WARN_FREE_BYTES");
  const criticalFreeBytes = value("STORAGE_CRITICAL_FREE_BYTES");
  if (warnFreeBytes != null && criticalFreeBytes != null && criticalFreeBytes > warnFreeBytes) {
    throw new Error("Critical free space cannot exceed warning free space");
  }
  return { warnFreeBytes, criticalFreeBytes };
}
// Only absence is a missing directory; permissions and IO failures are unknown coverage.
export async function inspectDirectory(path, accessFn) {
  try {
    await accessFn(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}
export function parseDirectoryConfig(text, max = MAX_DIRECTORIES) {
  let rows;
  try { rows = JSON.parse(String(text)); } catch { throw new Error("Directory config is not valid JSON"); }
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > max) throw new Error("Directory config must list 1 to " + max + " directories");
  const seen = new Set();
  return Object.freeze(rows.map((row) => {
    const { id, label, path } = row ?? {};
    if (typeof id !== "string" || !DIRECTORY_ID.test(id) || seen.has(id)) throw new Error("Invalid or duplicate directory id");
    seen.add(id);
    if (typeof label !== "string" || !label.trim() || label.length > 70 || label.includes("/")) throw new Error("Invalid directory label for " + id);
    if (typeof path !== "string" || !path.startsWith("/") || path === "/" || path.includes("\0") || path.split("/").includes("..") || path.includes("//") || path.endsWith("/")) {
      throw new Error("Invalid directory path for " + id);
    }
    return Object.freeze({ id, label: label.trim(), path });
  }));
}
// The allowlist decides which paths root measures, so it must not be editable by anyone else.
export function assertTrustedConfigFile(stat, uid = 0) {
  if (!stat.isFile()) throw new Error("Directory config must be a regular file");
  if (stat.uid !== uid) throw new Error("Directory config must be owned by root");
  if ((stat.mode & 0o022) !== 0) throw new Error("Directory config must not be group- or world-writable");
}
// Operator allowlist of the containers shown as workers; nothing is discovered automatically.
export function parseWorkerConfig(text) {
  let rows;
  try { rows = JSON.parse(String(text)); } catch { throw new Error("Worker config is not valid JSON"); }
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_WORKERS) throw new Error("Worker config must list 1 to " + MAX_WORKERS + " containers");
  const ids = new Set();
  const names = new Set();
  return Object.freeze(rows.map((row) => {
    const { id, label, container } = row ?? {};
    if (typeof id !== "string" || !WORKER_ID.test(id) || ids.has(id)) throw new Error("Invalid or duplicate worker id");
    if (typeof container !== "string" || !CONTAINER_NAME.test(container) || names.has(container)) throw new Error("Invalid or duplicate container for " + id);
    if (typeof label !== "string" || !label.trim() || label.length > 70 || label.includes("/")) throw new Error("Invalid worker label for " + id);
    ids.add(id);
    names.add(container);
    return Object.freeze({ id, label: label.trim(), container });
  }));
}
const WORKER_STATES = new Set(["created", "running", "paused", "restarting", "removing", "exited", "dead"]);
const WORKER_HEALTH = new Set(["healthy", "unhealthy", "starting"]);
// Output of: docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.OOMKilled}}'
export function parseContainerState(text) {
  const parts = String(text).trim().split("|");
  if (parts.length !== 5) throw new Error("Unexpected docker inspect output");
  const [state, health, startedAt, restarts, oom] = parts;
  if (!WORKER_STATES.has(state)) throw new Error("Unexpected container state");
  if (health !== "" && !WORKER_HEALTH.has(health)) throw new Error("Unexpected container health");
  const started = new Date(startedAt);
  const validStart = Number.isFinite(started.getTime()) && started.getUTCFullYear() > 2000;
  if (oom !== "true" && oom !== "false") throw new Error("Unexpected OOM flag");
  return {
    state, health: health || null,
    startedAt: state === "running" && validStart ? started.toISOString() : null,
    restartCount: strictInt(restarts), oomKilled: oom === "true",
  };
}
const percentText = (value) => {
  const match = /^(\d+(?:\.\d+)?)%$/.exec(String(value).trim());
  if (!match) throw new Error("Unexpected percentage");
  return Math.round(Number(match[1]) * 10) / 10;
};
// Output of: docker stats --no-stream --format '{{json .}}'
export function parseContainerStats(text) {
  const result = new Map();
  for (const line of String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    const row = JSON.parse(line);
    const [used, limit] = String(row.MemUsage).split("/").map((part) => part.trim());
    result.set(String(row.Name), {
      cpuPercent: percentText(row.CPUPerc),
      memoryUsedBytes: parseHumanBytes(used),
      memoryLimitBytes: parseHumanBytes(limit),
      memoryPercent: percentText(row.MemPerc),
      pids: strictInt(row.PIDs),
    });
  }
  return result;
}
export async function collectWorkers({ run, workers }) {
  const issues = [];
  const rows = [];
  for (const worker of workers) {
    const base = { id: worker.id, label: worker.label };
    try {
      const out = await run("docker", ["inspect", "--format", "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.OOMKilled}}", "--", worker.container], 10000);
      rows.push({ ...base, ...parseContainerState(out) });
    } catch (error) {
      // "No such object" is a missing container; anything else is unknown coverage.
      const missing = /no such (object|container)/i.test(String(error?.stderr ?? error?.message ?? ""));
      if (!missing) issues.push({ source: "workers", code: "command_failed" });
      rows.push({ ...base, state: missing ? "missing" : "unknown", health: null, startedAt: null, restartCount: 0, oomKilled: false });
    }
  }
  const running = workers.filter((_, i) => rows[i].state === "running");
  let stats = new Map();
  if (running.length) {
    try {
      stats = parseContainerStats(await run("docker", ["stats", "--no-stream", "--format", "{{json .}}", "--", ...running.map((w) => w.container)], 20000));
    } catch { issues.push({ source: "workers", code: "stats_failed" }); }
  }
  workers.forEach((worker, i) => {
    // Only a running container carries live usage; a stopped one never shows stale numbers.
    const sample = rows[i].state === "running" ? stats.get(worker.container) : undefined;
    rows[i] = { ...rows[i], ...(sample ?? { cpuPercent: null, memoryUsedBytes: null, memoryLimitBytes: null, memoryPercent: null, pids: null }) };
  });
  return { rows, issues: [...new Map(issues.map((item) => [item.code, item])).values()] };
}
// A worktree root is a directory whose immediate subdirectories are git worktrees; each is measured on its own.
// Entries are only listed one level deep and symlinks are never followed.
export async function collectWorktrees({ run, roots, listDir, modifiedAt, clock = () => Date.now(), budgetMs = 120_000 }) {
  const issues = [];
  const rows = [];
  const deadline = clock() + budgetMs;
  const note = (source, code) => { if (!issues.some((item) => item.source === source && item.code === code)) issues.push({ source, code }); };
  for (const root of roots) {
    let entries;
    try { entries = await listDir(root.path); }
    catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") note("worktrees", "list_failed");
      continue;
    }
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory || entry.isSymlink) continue;
      if (!WORKTREE_NAME.test(entry.name)) { note("worktrees", "invalid_name"); continue; }
      let modified = null;
      try { modified = await modifiedAt(root.path + "/" + entry.name); } catch { /* keep null */ }
      candidates.push({ name: entry.name, modified });
    }
    // Most recently touched first, so a cap drops the oldest rather than the active ones.
    candidates.sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? "") || a.name.localeCompare(b.name));
    if (candidates.length > MAX_WORKTREES_PER_ROOT) note("worktrees", "truncated");
    for (const candidate of candidates.slice(0, MAX_WORKTREES_PER_ROOT)) {
      const base = { rootId: root.id, rootLabel: root.label, name: candidate.name, modifiedAt: candidate.modified };
      const remaining = deadline - clock();
      if (remaining <= 0) { rows.push({ ...base, status: "unavailable", bytes: null }); note("worktrees", "deadline_exceeded"); continue; }
      try {
        const bytes = parseDu(await run("du", ["-x", "-s", "-B1", "--", root.path + "/" + candidate.name], Math.min(60_000, remaining)));
        rows.push({ ...base, status: "ok", bytes });
      } catch {
        rows.push({ ...base, status: "unavailable", bytes: null });
        note("worktrees", "command_failed");
      }
    }
  }
  return { rows, issues };
}
export function parseMeminfo(text) {
  const values = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)\s+kB\s*$/.exec(line);
    if (match) values.set(match[1], strictInt(match[2]) * 1024);
  }
  for (const key of ["MemTotal", "MemAvailable", "SwapTotal", "SwapFree"]) if (!values.has(key)) throw new Error("Unexpected meminfo");
  const totalBytes = values.get("MemTotal");
  const availableBytes = values.get("MemAvailable");
  const swapTotalBytes = values.get("SwapTotal");
  const swapFreeBytes = values.get("SwapFree");
  if (totalBytes <= 0 || availableBytes > totalBytes || swapFreeBytes > swapTotalBytes) throw new Error("Inconsistent meminfo values");
  const usedBytes = totalBytes - availableBytes;
  return {
    totalBytes, availableBytes, usedBytes,
    usedPercent: Math.round(usedBytes / totalBytes * 1000) / 10,
    swapTotalBytes, swapUsedBytes: swapTotalBytes - swapFreeBytes,
  };
}
// CPU usage needs two samples: busy share of all cores between them.
export function cpuUsagePercent(before, after) {
  let idle = 0;
  let total = 0;
  const count = Math.min(before.length, after.length);
  if (count === 0) throw new Error("No CPU samples");
  for (let i = 0; i < count; i += 1) {
    const a = before[i].times;
    const b = after[i].times;
    const sum = (t) => t.user + t.nice + t.sys + t.idle + t.irq;
    total += sum(b) - sum(a);
    idle += b.idle - a.idle;
  }
  if (!(total > 0) || idle < 0 || idle > total) throw new Error("Inconsistent CPU samples");
  return Math.round((1 - idle / total) * 1000) / 10;
}
export async function sampleCpu({ cpus = osCpus, loadavg = osLoadavg, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), sampleMs = 1000 } = {}) {
  const before = cpus();
  await sleep(sampleMs);
  const after = cpus();
  const [load1, load5, load15] = loadavg().map((value) => Math.round(value * 100) / 100);
  return { cores: after.length, usagePercent: cpuUsagePercent(before, after), load1, load5, load15 };
}

export async function collect({ run, inspect = async () => true, now = () => new Date(), clock = () => Date.now(), directories = DIRECTORIES, alertPolicy = {}, workers = [], worktreeRoots = [], listDir = async () => [], modifiedAt = async () => null, readText = async () => { throw new Error("readText not provided"); }, cpuSampler = sampleCpu, uptime = osUptime }) {
  const generatedAt = now().toISOString();
  const filesystem = parseDf(await run("df", ["-B1", "--output=size,used,avail,pcent", "--", "/"], 15000));
  const coverage = { partial: false, issues: [] };
  const issue = (source, code) => { coverage.partial = true; coverage.issues.push({ source, code }); };
  let cpu = null;
  try { cpu = await cpuSampler(); } catch { issue("cpu", "read_failed"); }
  let memory = null;
  try { memory = parseMeminfo(await readText("/proc/meminfo")); } catch { issue("memory", "read_failed"); }
  const uptimeSeconds = Math.floor(Number(uptime()));
  let workerRows = [];
  if (workers.length) {
    const result = await collectWorkers({ run, workers });
    workerRows = result.rows;
    for (const item of result.issues) issue(item.source, item.code);
  }
  let worktreeRows = [];
  if (worktreeRoots.length) {
    const result = await collectWorktrees({ run, roots: worktreeRoots, listDir, modifiedAt, clock });
    worktreeRows = result.rows;
    for (const item of result.issues) issue(item.source, item.code);
  }
  let docker = [];
  try { docker = parseDocker(await run("docker", ["system", "df", "--format", "{{json .}}"], 20000)); }
  catch { issue("docker", "command_failed"); }
  const readings = [];
  // df + Docker allow up to 35s. Leave >25s within systemd's 240s for
  // a bounded directory scan, serializing the snapshot, and atomic save.
  const deadline = clock() + 180_000;
  for (const dir of directories) {
    if (clock() >= deadline) {
      readings.push({ id: dir.id, label: dir.label, status: "unavailable", bytes: null });
      issue(dir.id, "deadline_exceeded");
      continue;
    }
    let present = false;
    try { present = await inspect(dir.path); }
    catch {
      readings.push({ id: dir.id, label: dir.label, status: "unavailable", bytes: null });
      issue(dir.id, "inspection_failed");
      continue;
    }
    if (!present) { readings.push({ id: dir.id, label: dir.label, status: "missing", bytes: null }); continue; }
    // Also limit the last du invocation to the remaining budget: simply
    // checking the deadline before a 30s call can overrun TimeoutStartSec.
    const remaining = deadline - clock();
    if (remaining <= 0) {
      readings.push({ id: dir.id, label: dir.label, status: "unavailable", bytes: null });
      issue(dir.id, "deadline_exceeded");
      continue;
    }
    try {
      const bytes = parseDu(await run("du", ["-x", "-s", "-B1", "--", dir.path], Math.min(30_000, remaining)));
      readings.push({ id: dir.id, label: dir.label, status: "ok", bytes });
    } catch {
      readings.push({ id: dir.id, label: dir.label, status: "unavailable", bytes: null });
      issue(dir.id, "command_failed");
    }
  }
  return {
    schemaVersion: 2, generatedAt, filesystem, cpu, memory,
    uptimeSeconds: Number.isSafeInteger(uptimeSeconds) && uptimeSeconds >= 0 ? uptimeSeconds : null,
    workers: workerRows, worktrees: worktreeRows, docker, directories: readings, alertPolicy, coverage, history: [],
  };
}
