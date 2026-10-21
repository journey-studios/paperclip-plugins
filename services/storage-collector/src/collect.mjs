import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertTrustedConfigFile, collect, DIRECTORIES, inspectDirectory, makeHistory, parseAlertPolicy, parseDirectoryConfig, parseWorkerConfig, parseWorktreeConfig } from "./lib.mjs";

const exec = promisify(execFile);
const outDir = process.env.STORAGE_OUTPUT_DIR || "/var/lib/paperclip-storage-manager";
if (!isAbsolute(outDir) || outDir === "/" || outDir.includes("..")) throw new Error("Invalid snapshot output directory");
const outPath = join(outDir, "snapshot.json");

async function run(command, args, timeout) {
  const { stdout } = await exec(command, args, { timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  return stdout;
}
async function current() {
  try {
    const contents = await readFile(outPath, "utf8");
    return contents.length <= 1024 * 1024 ? JSON.parse(contents) : null;
  } catch { return null; }
}
async function save(snapshot) {
  await mkdir(outDir, { recursive: true, mode: 0o755 });
  await chmod(outDir, 0o755);
  const temporary = join(outDir, ".snapshot-" + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, JSON.stringify(snapshot) + "\n", { encoding: "utf8", mode: 0o644, flag: "wx" });
    await chmod(temporary, 0o644);
    await rename(temporary, outPath);
  } finally { await unlink(temporary).catch(() => {}); }
}

const policy = parseAlertPolicy(process.env);
// Optional root-owned allowlist; without it the generic defaults apply.
const directoriesFile = process.env.VPS_STATUS_DIRECTORIES_FILE;
if (directoriesFile && (!isAbsolute(directoriesFile) || directoriesFile.includes(".."))) throw new Error("Invalid directories file path");
if (directoriesFile) assertTrustedConfigFile(await stat(directoriesFile));
const directories = directoriesFile ? parseDirectoryConfig(await readFile(directoriesFile, "utf8")) : DIRECTORIES;
// Optional root-owned list of containers to report as workers (none by default).
const workersFile = process.env.VPS_STATUS_WORKERS_FILE;
if (workersFile && (!isAbsolute(workersFile) || workersFile.includes(".."))) throw new Error("Invalid workers file path");
if (workersFile) assertTrustedConfigFile(await stat(workersFile));
const workers = workersFile ? parseWorkerConfig(await readFile(workersFile, "utf8")) : [];
// Optional root-owned list of directories whose subfolders are git worktrees to measure (none by default).
const worktreesFile = process.env.VPS_STATUS_WORKTREES_FILE;
if (worktreesFile && (!isAbsolute(worktreesFile) || worktreesFile.includes(".."))) throw new Error("Invalid worktrees file path");
if (worktreesFile) assertTrustedConfigFile(await stat(worktreesFile));
const worktreeConfig = worktreesFile ? parseWorktreeConfig(await readFile(worktreesFile, "utf8")) : [];
const worktreeRoots = worktreeConfig.filter((row) => row.kind === "worktrees");
const sharedRoots = worktreeConfig.filter((row) => row.kind === "shared");
// A real-size walk is the costliest probe: reuse the last one for up to this many minutes (default 60).
const attributionMinutes = process.env.VPS_STATUS_ATTRIBUTION_MAX_AGE_MINUTES === undefined ? 60 : Number(process.env.VPS_STATUS_ATTRIBUTION_MAX_AGE_MINUTES);
if (!Number.isFinite(attributionMinutes) || attributionMinutes < 0 || attributionMinutes > 1440) throw new Error("Invalid VPS_STATUS_ATTRIBUTION_MAX_AGE_MINUTES");
const previous = await current();
const snapshot = await collect({
  run, alertPolicy: policy, directories, workers, worktreeRoots, sharedRoots, previous, attributionMaxAgeMs: attributionMinutes * 60_000,
  listDir: async (path) => (await readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isSymlink: entry.isSymbolicLink() })),
  modifiedAt: async (path) => (await stat(path)).mtime.toISOString(),
  readText: (path) => readFile(path, "utf8"),
  inspect: (path) => inspectDirectory(path, access),
});
snapshot.history = makeHistory(previous, snapshot);
await save(snapshot);
process.stdout.write("vps status snapshot saved: " + snapshot.generatedAt +
  "; capacity used bytes " + snapshot.filesystem.usedBytes +
  "; cpu " + (snapshot.cpu ? snapshot.cpu.usagePercent + "%" : "n/a") +
  "; memory " + (snapshot.memory ? snapshot.memory.usedPercent + "%" : "n/a") +
  "; partial " + snapshot.coverage.partial + "\n");
