// Host collector: a strictly allowlisted, read-only inventory. No arbitrary user paths.
export const DIRECTORIES = Object.freeze([
  { id: "containerd", label: "Containerd", path: "/var/lib/containerd" },
  { id: "containerd-snapshots", label: "Containerd · snapshots", path: "/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs" },
  { id: "containerd-content", label: "Containerd · blobs", path: "/var/lib/containerd/io.containerd.content.v1.content" },
  { id: "docker-volumes", label: "Docker · volumes", path: "/var/lib/docker/volumes" },
  { id: "paperclip-data", label: "Paperclip · dados persistentes", path: "/var/lib/docker/volumes/paperclip_paperclip_data/_data" },
  { id: "paperclip-pnpm", label: "Paperclip · pnpm store", path: "/var/lib/docker/volumes/paperclip_paperclip_data/_data/.local/share/pnpm/store" },
  { id: "paperclip-projects", label: "Paperclip · projetos", path: "/var/lib/docker/volumes/paperclip_paperclip_data/_data/instances/default/projects" },
  { id: "repos", label: "Repositórios Git", path: "/var/www/journey-studios" },
  { id: "paperclip-backups", label: "Paperclip · backups", path: "/opt/paperclip/backups" },
  { id: "builds", label: "Paperclip · builds", path: "/opt/paperclip-build" },
  { id: "rust-toolchain", label: "Rust toolchains", path: "/root/.rustup" },
  { id: "emsdk", label: "Emscripten SDK", path: "/opt/emsdk" },
  { id: "root-home", label: "Host · /root", path: "/root" },
]);
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
  recent.push({
    at: snapshot.generatedAt,
    usedBytes: snapshot.filesystem.usedBytes,
    availableBytes: snapshot.filesystem.availableBytes,
  });
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
export async function collect({ run, inspect = async () => true, now = () => new Date(), directories = DIRECTORIES, alertPolicy = {} }) {
  const generatedAt = now().toISOString();
  const filesystem = parseDf(await run("df", ["-B1", "--output=size,used,avail,pcent", "--", "/"], 15000));
  const coverage = { partial: false, issues: [] };
  const issue = (source, code) => { coverage.partial = true; coverage.issues.push({ source, code }); };
  let docker = [];
  try { docker = parseDocker(await run("docker", ["system", "df", "--format", "{{json .}}"], 20000)); }
  catch { issue("docker", "command_failed"); }
  const readings = [];
  for (const dir of directories) {
    let present = false;
    try { present = await inspect(dir.path); }
    catch { issue(dir.id, "inspection_failed"); }
    if (!present) { readings.push({ id: dir.id, label: dir.label, status: "missing", bytes: null }); continue; }
    try {
      const bytes = parseDu(await run("du", ["-x", "-s", "-B1", "--", dir.path], 30000));
      readings.push({ id: dir.id, label: dir.label, status: "ok", bytes });
    } catch {
      readings.push({ id: dir.id, label: dir.label, status: "unavailable", bytes: null });
      issue(dir.id, "command_failed");
    }
  }
  return { schemaVersion: 1, generatedAt, filesystem, docker, directories: readings, alertPolicy, coverage, history: [] };
}
