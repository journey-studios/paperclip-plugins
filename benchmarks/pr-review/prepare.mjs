import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { git, writeJson } from "./io.mjs";
import { importReviewBenchGold } from "./normalize.mjs";
import { digest, requireValue } from "./score.mjs";

const blob = (raw) => createHash("sha1").update(`blob ${Buffer.byteLength(raw)}\0`).update(raw).digest("hex");
const prIdentity = (item) => ({ repo: item.repo, pr_number: item.number, base: item.base, head: item.head });

/** Reads committed blobs, so a dirty upstream checkout cannot replace reference labels. */
export async function readReference(corpus, item, upstream) {
  const raw = await git(upstream, ["show", `${corpus.source.revision}:${item.goldenPath}`]);
  requireValue(blob(raw) === item.goldenBlob, "Reference blob differs from corpus pin");
  const reference = JSON.parse(raw);
  return { reference, referenceText: raw, gold: importReviewBenchGold(reference, prIdentity(item)) };
}

export async function readManifest(corpus, upstream) {
  const raw = await git(upstream, ["show", `${corpus.source.revision}:corpus/manifest.json`]);
  requireValue(blob(raw) === corpus.source.manifestBlob, "Manifest blob differs from corpus pin");
  return JSON.parse(raw);
}

/** Only base/head ancestry is fetched. No PR discussions, future branch tips, builds, or hooks run. */
export async function prepareCase(corpus, item, upstream, destination) {
  requireValue(/^[\w.-]+$/.test(item.id), "Unsafe case id");
  requireValue(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(item.repo), "Unsupported repository URL");
  const manifest = await readManifest(corpus, upstream);
  const entry = manifest.find((candidate) => candidate.repo === item.repo && candidate.pr_number === item.number);
  requireValue(entry?.base === item.base && entry?.head === item.head, "Manifest snapshot differs from corpus");
  const root = resolve(destination, item.id);
  await mkdir(root, { recursive: false });
  const repo = join(root, "repo");
  const prDir = join(root, "pr");
  await mkdir(repo);
  await mkdir(prDir);
  await git(repo, ["init", "--quiet"]);
  const nwo = item.repo.slice("https://github.com/".length);
  const mirror = `https://github.com/review-bench/${nwo.replace("/", "_")}.git`;
  await git(repo, ["fetch", "--quiet", "--no-tags", "--depth=128", mirror, item.base, item.head]);
  await git(repo, ["branch", "review-base", item.base]);
  await git(repo, ["checkout", "--quiet", "-b", "review-head", item.head]);
  let mergeBase;
  try {
    mergeBase = (await git(repo, ["merge-base", item.base, item.head])).trim();
  } catch {
    // An unusually long PR can exceed the shallow boundary; deepen ancestry instead of guessing its base.
    await git(repo, ["fetch", "--quiet", "--no-tags", "--unshallow", mirror, item.base, item.head]);
    mergeBase = (await git(repo, ["merge-base", item.base, item.head])).trim();
  }
  const patch = await git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", `${mergeBase}..${item.head}`]);
  const paths = (await git(repo, ["diff", "--name-only", "-z", `${mergeBase}..${item.head}`])).split("\0").filter(Boolean);
  await writeFile(join(prDir, "diff.patch"), patch, { flag: "wx" });
  await writeJson(join(prDir, "pr.json"), { ...entry, merge_base: mergeBase }, 0o644);
  // Rules come from the frozen base: the patch cannot change its own reviewer policy.
  const basePaths = (await git(repo, ["ls-tree", "--name-only", item.base])).split("\n");
  let rules = "";
  if (basePaths.includes(".pr_agent.toml")) {
    rules = await git(repo, ["show", `${item.base}:.pr_agent.toml`]);
  }
  await writeFile(join(prDir, "rules.toml"), rules, { flag: "wx" });
  await writeJson(join(prDir, "coverage.json"), { changedPaths: paths }, 0o644);
  const reference = await readReference(corpus, item, upstream);
  const snapshot = {
    schemaVersion: 1, caseId: item.id, corpusDigest: digest(corpus), pr: prIdentity(item), mergeBase,
    metadataDigest: digest({ ...entry, merge_base: mergeBase }), patchDigest: digest(patch), rulesDigest: digest(rules),
    changedPaths: paths, rulesBasis: "frozen-base", sourceRevision: corpus.source.revision,
    referenceDigest: digest(reference.reference), goldDigest: digest(reference.gold),
  };
  // Reference data stays outside repo/pr; only those two directories enter reviewer containers.
  await writeJson(join(root, "reference.json"), reference);
  await writeJson(join(root, "snapshot.json"), snapshot);
  return snapshot;
}

export async function verifySnapshot(root, job, corpusDigest) {
  const snapshot = JSON.parse(await readFile(join(root, "snapshot.json"), "utf8"));
  requireValue(snapshot.corpusDigest === corpusDigest && snapshot.caseId === job.caseId, "Snapshot belongs to another corpus/case");
  requireValue(digest(snapshot.pr) === digest(prIdentity({ ...job, number: job.number })), "Snapshot PR identity changed");
  requireValue((await git(join(root, "repo"), ["rev-parse", "HEAD"])).trim() === job.head, "Snapshot head changed");
  requireValue((await git(join(root, "repo"), ["rev-parse", "review-base"])).trim() === job.base, "Snapshot base changed");
  requireValue((await git(join(root, "repo"), ["merge-base", job.base, job.head])).trim() === snapshot.mergeBase, "Snapshot merge base changed");
  requireValue(!(await git(join(root, "repo"), ["status", "--porcelain", "--untracked-files=all"])).trim(), "Snapshot checkout is dirty");
  const pr = JSON.parse(await readFile(join(root, "pr/pr.json"), "utf8"));
  requireValue(digest(pr) === snapshot.metadataDigest, "Snapshot metadata changed");
  const patch = await readFile(join(root, "pr/diff.patch"), "utf8");
  const actual = await git(join(root, "repo"), ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", `${snapshot.mergeBase}..${job.head}`]);
  requireValue(digest(patch) === snapshot.patchDigest && patch === actual, "Snapshot diff changed");
  requireValue(digest(await readFile(join(root, "pr/rules.toml"), "utf8")) === snapshot.rulesDigest, "Snapshot rules changed");
  return snapshot;
}
