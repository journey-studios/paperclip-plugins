// Real disk attribution across trees that share files by hardlink (pnpm store, worktrees, checkouts).
// One read-only pass counts every inode once, so "exclusive" bytes are what deleting a tree frees,
// "shared" bytes are what other trees still keep alive. Symlinks are never followed and a mount
// point is never crossed. Paths come from the operator's config, never from the snapshot.
import { lstatSync, readdirSync } from "node:fs";

export const BLOCK_BYTES = 512;
const CHECK_EVERY = 2000;

function ignorable(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

/**
 * items: [{ key, path }]. excludePaths: absolute paths never entered (other items, worktree roots).
 * Returns per-item { apparentBytes, exclusiveBytes, sharedBytes, entries } and totals, or throws
 * Error("attribution deadline exceeded") so a partial walk is never reported as a result.
 */
export function attributeUsage({ items, excludePaths = [], fs = { lstatSync, readdirSync }, clock = () => Date.now(), budgetMs = 150_000 }) {
  const deadline = clock() + budgetMs;
  const excluded = new Set(excludePaths);
  const hardlinked = new Map(); // ino -> { owner, seen, links, bytes }  (owner: -2 none, -1 several trees)
  const per = items.map(() => ({ apparentBytes: 0, exclusiveBytes: 0, entries: 0, unreadable: 0 }));
  let physicalBytes = 0;
  let sharedBetweenBytes = 0;
  let counter = 0;
  items.forEach((item, index) => {
    const rootStat = fs.lstatSync(item.path);
    const seenInItem = new Set();
    const stack = [item.path];
    const visit = (path, stat) => {
      const bytes = stat.blocks * BLOCK_BYTES;
      per[index].entries += 1;
      const plain = stat.isDirectory() || !stat.isFile() || stat.nlink <= 1;
      if (plain) {
        per[index].apparentBytes += bytes;
        per[index].exclusiveBytes += bytes;
        physicalBytes += bytes;
        return;
      }
      let record = hardlinked.get(stat.ino);
      if (!record) { record = { owner: -2, seen: 0, links: stat.nlink, bytes }; hardlinked.set(stat.ino, record); }
      record.seen += 1;
      if (seenInItem.has(stat.ino)) return;
      seenInItem.add(stat.ino);
      per[index].apparentBytes += bytes;
      if (record.owner === -2) {
        record.owner = index;
        per[index].exclusiveBytes += bytes;
        physicalBytes += bytes;
      } else if (record.owner >= 0) {
        per[record.owner].exclusiveBytes -= bytes;
        sharedBetweenBytes += bytes;
        record.owner = -1;
      }
    };
    visit(item.path, rootStat);
    while (stack.length) {
      if (++counter % CHECK_EVERY === 0 && clock() > deadline) throw new Error("attribution deadline exceeded");
      const dir = stack.pop();
      let names;
      try { names = fs.readdirSync(dir); }
      catch (error) { if (!ignorable(error)) per[index].unreadable += 1; continue; }
      for (const name of names) {
        const path = dir + "/" + name;
        if (excluded.has(path)) continue;
        let stat;
        try { stat = fs.lstatSync(path); }
        catch (error) { if (!ignorable(error)) per[index].unreadable += 1; continue; }
        if (stat.dev !== rootStat.dev) continue;
        visit(path, stat);
        if (stat.isDirectory()) stack.push(path);
        if (++counter % CHECK_EVERY === 0 && clock() > deadline) throw new Error("attribution deadline exceeded");
      }
    }
  });
  // A file with links outside the measured trees is not freed by deleting these trees.
  let externallyLinkedBytes = 0;
  for (const record of hardlinked.values()) {
    if (record.seen >= record.links) continue;
    externallyLinkedBytes += record.bytes;
    if (record.owner >= 0) per[record.owner].exclusiveBytes -= record.bytes;
  }
  const apparentTotal = per.reduce((sum, row) => sum + row.apparentBytes, 0);
  return {
    items: items.map((item, index) => ({
      key: item.key,
      apparentBytes: per[index].apparentBytes,
      exclusiveBytes: Math.max(0, per[index].exclusiveBytes),
      sharedBytes: per[index].apparentBytes - Math.max(0, per[index].exclusiveBytes),
      entries: per[index].entries,
      unreadable: per[index].unreadable,
    })),
    totals: {
      physicalBytes,
      apparentBytes: apparentTotal,
      savedByHardlinksBytes: Math.max(0, apparentTotal - physicalBytes),
      sharedBetweenBytes,
      externallyLinkedBytes,
    },
  };
}
