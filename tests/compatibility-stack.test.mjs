import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCompatibilityPatchStack } from "../scripts/compatibility-patch-stack.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "paperclip-stack-test-"));
  const checkout = join(directory, "host");
  const patchDirectory = join(directory, "patches");
  mkdirSync(checkout);
  mkdirSync(patchDirectory);
  git(checkout, "init", "-q");
  git(checkout, "config", "user.name", "Compatibility test");
  git(checkout, "config", "user.email", "compatibility-test@example.invalid");
  writeFileSync(join(checkout, "shared.txt"), "seed\nkeep\n");
  git(checkout, "add", "shared.txt");
  git(checkout, "commit", "-qm", "base");

  const patches = [];
  for (const [index, value] of ["artifact", "evolution", "telegram"].entries()) {
    writeFileSync(join(checkout, "shared.txt"), `${value}\nkeep\n`);
    const patch = join(patchDirectory, `${index}.patch`);
    writeFileSync(patch, execFileSync("git", ["diff", "--binary", "--", "shared.txt"], { cwd: checkout }));
    git(checkout, "add", "shared.txt");
    patches.push(patch);
  }
  git(checkout, "reset", "--hard", "HEAD");

  return { directory, checkout, patches };
}

test("applies the ordered stack, recognizes repeat runs, and preserves unrelated files", (t) => {
  const state = fixture();
  t.after(() => rmSync(state.directory, { recursive: true, force: true }));
  const notePath = join(state.checkout, "operator-note.txt");
  writeFileSync(notePath, "staged note\n");
  git(state.checkout, "add", "operator-note.txt");
  writeFileSync(notePath, "preserve me\n");
  const stagedBefore = git(state.checkout, "diff", "--cached", "--binary");

  assert.deepEqual(applyCompatibilityPatchStack(state), { appliedPrefix: 0, appliedCount: 3 });
  assert.deepEqual(applyCompatibilityPatchStack(state), { appliedPrefix: 3, appliedCount: 0 });
  assert.equal(readFileSync(join(state.checkout, "shared.txt"), "utf8"), "telegram\nkeep\n");
  assert.equal(readFileSync(notePath, "utf8"), "preserve me\n");
  assert.equal(git(state.checkout, "diff", "--cached", "--binary"), stagedBefore);
});

test("upgrades an older applied prefix without reapplying overlapping patches", (t) => {
  const state = fixture();
  t.after(() => rmSync(state.directory, { recursive: true, force: true }));
  for (const patch of state.patches.slice(0, 2)) {
    execFileSync("git", ["apply", "--whitespace=nowarn", patch], { cwd: state.checkout });
  }

  assert.deepEqual(applyCompatibilityPatchStack(state), { appliedPrefix: 2, appliedCount: 1 });
  assert.equal(readFileSync(join(state.checkout, "shared.txt"), "utf8"), "telegram\nkeep\n");
});

test("rejects an incompatible partial stack without changing the checkout", (t) => {
  const state = fixture();
  t.after(() => rmSync(state.directory, { recursive: true, force: true }));
  writeFileSync(join(state.checkout, "shared.txt"), "operator edit\nkeep\n");
  const beforeFile = readFileSync(join(state.checkout, "shared.txt"), "utf8");
  const beforeStatus = git(state.checkout, "status", "--porcelain");

  assert.throws(() => applyCompatibilityPatchStack(state), /conflicting or partial/);
  assert.equal(readFileSync(join(state.checkout, "shared.txt"), "utf8"), beforeFile);
  assert.equal(git(state.checkout, "status", "--porcelain"), beforeStatus);
});
