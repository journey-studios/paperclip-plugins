import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsRoot = resolve(root, "plugins");
const output = resolve(root, ".package-output");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const pluginDirs = readdirSync(pluginsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
  .map((entry) => join(pluginsRoot, entry.name));
if (!pluginDirs.length) throw new Error("No plugin workspaces found");
for (const dir of pluginDirs) {
  const manifest = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
  if (!manifest.name || !manifest.version || manifest.private === true) {
    throw new Error(`Plugin package must be publishable: ${dir}`);
  }
  execFileSync("pnpm", ["pack", "--pack-destination", output], { cwd: dir, stdio: "inherit" });
  console.log(`Packed ${manifest.name}@${manifest.version}`);
}
const archives = readdirSync(output).filter((file) => file.endsWith(".tgz")).sort();
const sums = archives.map((file) => {
  const digest = createHash("sha256").update(readFileSync(resolve(output, file))).digest("hex");
  return `${digest}  ${file}`;
});
writeFileSync(resolve(output, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`Wrote ${archives.length} package archives and SHA256SUMS to ${output}`);
