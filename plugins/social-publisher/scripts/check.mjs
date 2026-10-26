import { readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
async function check(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${item.name}`;
    if (item.isDirectory()) await check(path);
    else if (item.name.endsWith(".js") || item.name.endsWith(".mjs"))
      execFileSync(process.execPath, ["--check", path], { stdio: "inherit" });
  }
}
await check("src");
