import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { collect, makeHistory, parseAlertPolicy } from "./lib.mjs";

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
const snapshot = await collect({
  run, alertPolicy: policy,
  inspect: async (path) => access(path).then(() => true, () => false),
});
snapshot.history = makeHistory(await current(), snapshot);
await save(snapshot);
process.stdout.write("storage snapshot saved: " + snapshot.generatedAt +
  "; capacity used bytes " + snapshot.filesystem.usedBytes +
  "; partial " + snapshot.coverage.partial + "\n");
