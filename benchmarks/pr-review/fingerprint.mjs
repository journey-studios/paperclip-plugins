import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { digest } from "./score.mjs";

async function sourcesIn(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const contents = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && entry.name === "adapters") contents.push(...await sourcesIn(`${path}/${entry.name}`));
    if (entry.isFile() && /\.(mjs|py)$/.test(entry.name) && !entry.name.includes(".spec.")) contents.push([entry.name, await readFile(`${path}/${entry.name}`, "utf8")]);
  }
  return contents;
}

export async function measurementFingerprint() {
  const local = (path) => fileURLToPath(new URL(path, import.meta.url));
  const sources = await sourcesIn(local("."));
  for (const path of ["../../plugins/github-pr-review-sync/src/verdict.js", "../../shared/github-text.js"]) sources.push([path, await readFile(local(path), "utf8")]);
  return digest(sources);
}
