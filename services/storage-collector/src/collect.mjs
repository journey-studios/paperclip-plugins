import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { collect, DIRECTORIES, inspectDirectory, makeHistory, parseAlertPolicy, parseDirectoryConfig } from "./lib.mjs";

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
const directories = directoriesFile ? parseDirectoryConfig(await readFile(directoriesFile, "utf8")) : DIRECTORIES;
const snapshot = await collect({
  run, alertPolicy: policy, directories,
  readText: (path) => readFile(path, "utf8"),
  inspect: (path) => inspectDirectory(path, access),
});
snapshot.history = makeHistory(await current(), snapshot);
await save(snapshot);
process.stdout.write("vps status snapshot saved: " + snapshot.generatedAt +
  "; capacity used bytes " + snapshot.filesystem.usedBytes +
  "; cpu " + (snapshot.cpu ? snapshot.cpu.usagePercent + "%" : "n/a") +
  "; memory " + (snapshot.memory ? snapshot.memory.usedPercent + "%" : "n/a") +
  "; partial " + snapshot.coverage.partial + "\n");
