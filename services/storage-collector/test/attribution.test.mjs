import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, symlinkSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attributeUsage } from "../src/attribution.mjs";

// In-memory filesystem: nodes are { type, ino, nlink, blocks, children }.
function fakeFs(tree) {
  const find = (path) => path.split("/").filter(Boolean).reduce((node, part) => { if (!node?.children?.[part]) { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } return node.children[part]; }, tree);
  const stat = (node) => ({ dev: node.dev ?? 1, ino: node.ino, nlink: node.nlink ?? 1, blocks: node.blocks, isDirectory: () => node.type === "dir", isFile: () => node.type === "file", isSymbolicLink: () => node.type === "link" });
  return { lstatSync: (path) => stat(find(path)), readdirSync: (path) => Object.keys(find(path).children) };
}
const dir = (ino, children = {}, extra = {}) => ({ type: "dir", ino, blocks: 8, nlink: 2, children, ...extra });
const file = (ino, blocks, nlink = 1, extra = {}) => ({ type: "file", ino, blocks, nlink, ...extra });

test("exclusive bytes are what deleting a tree frees; hardlinks shared with another tree are not", () => {
  // store has file 100 (10 blocks) linked into wtA and wtB; wtA also has a private file; wtB links 101 only to store.
  const tree = dir(1, {
    store: dir(2, { a: file(100, 10, 3), b: file(101, 20, 2) }),
    wtA: dir(3, { nm: file(100, 10, 3), own: file(200, 5) }),
    wtB: dir(4, { nm: file(100, 10, 3), nm2: file(101, 20, 2) }),
  });
  const result = attributeUsage({ items: [{ key: "store", path: "/store" }, { key: "A", path: "/wtA" }, { key: "B", path: "/wtB" }], fs: fakeFs(tree) });
  const by = Object.fromEntries(result.items.map((row) => [row.key, row]));
  assert.equal(by.A.apparentBytes, (8 + 10 + 5) * 512);
  assert.equal(by.A.exclusiveBytes, (8 + 5) * 512); // only its directory and private file
  assert.equal(by.A.sharedBytes, 10 * 512);
  assert.equal(by.B.exclusiveBytes, 8 * 512);
  assert.equal(by.store.apparentBytes, (8 + 10 + 20) * 512);
  assert.equal(by.store.exclusiveBytes, 8 * 512);
  // inode 100 counted once (10), 101 once (20), directories 3*8, private 5
  assert.equal(result.totals.physicalBytes, (30 + 24 + 5) * 512);
  assert.equal(result.totals.apparentBytes, (by.store.apparentBytes + by.A.apparentBytes + by.B.apparentBytes));
  assert.equal(result.totals.savedByHardlinksBytes, result.totals.apparentBytes - result.totals.physicalBytes);
  assert.equal(result.totals.sharedBetweenBytes, (10 + 20) * 512);
  assert.equal(result.totals.externallyLinkedBytes, 0);
});
test("a hardlinked file counts once inside its own tree and stays exclusive when all its links are inside", () => {
  const tree = dir(1, { t: dir(2, { x: file(300, 10, 2), y: file(300, 10, 2) }) });
  const [row] = attributeUsage({ items: [{ key: "T", path: "/t" }], fs: fakeFs(tree) }).items;
  assert.equal(row.apparentBytes, (8 + 10) * 512);
  assert.equal(row.exclusiveBytes, (8 + 10) * 512);
});
test("links outside the measured trees keep a file out of the exclusive size", () => {
  const tree = dir(1, { t: dir(2, { x: file(400, 10, 3) }) }); // nlink 3 but only one link is inside
  const result = attributeUsage({ items: [{ key: "T", path: "/t" }], fs: fakeFs(tree) });
  assert.equal(result.items[0].apparentBytes, (8 + 10) * 512);
  assert.equal(result.items[0].exclusiveBytes, 8 * 512);
  assert.equal(result.totals.externallyLinkedBytes, 10 * 512);
});
test("excluded paths, symlinks and other devices are never entered", () => {
  const tree = dir(1, { t: dir(2, { keep: file(500, 4), link: { type: "link", ino: 501, blocks: 0 }, nested: dir(3, { big: file(502, 1000) }), mnt: dir(4, { big: file(503, 1000) }, { dev: 9 }) }) });
  const [row] = attributeUsage({ items: [{ key: "T", path: "/t" }], excludePaths: ["/t/nested"], fs: fakeFs(tree) }).items;
  assert.equal(row.apparentBytes, (8 + 4 + 0) * 512);
});
test("a missing entry is skipped and an expired budget never yields a partial result", () => {
  const tree = dir(1, { t: dir(2, { a: file(600, 2) }) });
  const base = fakeFs(tree);
  const flaky = { ...base, lstatSync: (path) => { if (path === "/t/a") throw Object.assign(new Error("gone"), { code: "ENOENT" }); return base.lstatSync(path); } };
  assert.equal(attributeUsage({ items: [{ key: "T", path: "/t" }], fs: flaky }).items[0].entries, 1);
  const big = dir(1, { t: dir(2, Object.fromEntries(Array.from({ length: 5000 }, (_, i) => ["f" + i, file(1000 + i, 1)]))) });
  let now = 0;
  assert.throws(() => attributeUsage({ items: [{ key: "T", path: "/t" }], fs: fakeFs(big), clock: () => (now += 100), budgetMs: 50 }), /deadline/);
});
test("on a real Linux or macOS filesystem hardlinks are attributed to the trees that hold them", () => {
  const root = mkdtempSync(join(tmpdir(), "attribution-"));
  try {
    mkdirSync(join(root, "store")); mkdirSync(join(root, "wt"));
    writeFileSync(join(root, "store", "pkg"), Buffer.alloc(300_000, 1));
    linkSync(join(root, "store", "pkg"), join(root, "wt", "pkg"));
    writeFileSync(join(root, "wt", "own"), Buffer.alloc(100_000, 2));
    symlinkSync("/etc", join(root, "wt", "escape"));
    const result = attributeUsage({ items: [{ key: "store", path: join(root, "store") }, { key: "wt", path: join(root, "wt") }] });
    const wt = result.items.find((row) => row.key === "wt");
    const store = result.items.find((row) => row.key === "store");
    assert.ok(wt.apparentBytes >= 400_000);
    assert.ok(wt.exclusiveBytes < wt.apparentBytes - 250_000, "the hardlinked file is not exclusive to the worktree");
    assert.ok(wt.exclusiveBytes >= 100_000, "its private file is");
    assert.ok(store.exclusiveBytes < 100_000, "the store keeps nothing of its own besides the directory");
    assert.ok(result.totals.physicalBytes < result.totals.apparentBytes);
    assert.ok(result.totals.sharedBetweenBytes >= 300_000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
