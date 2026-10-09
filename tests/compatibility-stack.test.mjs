import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  for (const [index, value] of ["artifact", "evolution", "telegram", "delivery-quality"].entries()) {
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

  assert.deepEqual(applyCompatibilityPatchStack(state), { appliedPrefix: 0, appliedCount: 4 });
  assert.deepEqual(applyCompatibilityPatchStack(state), { appliedPrefix: 4, appliedCount: 0 });
  assert.equal(readFileSync(join(state.checkout, "shared.txt"), "utf8"), "delivery-quality\nkeep\n");
  assert.equal(readFileSync(notePath, "utf8"), "preserve me\n");
  assert.equal(git(state.checkout, "diff", "--cached", "--binary"), stagedBefore);
});

test("upgrades an older applied prefix without reapplying overlapping patches", (t) => {
  const state = fixture();
  t.after(() => rmSync(state.directory, { recursive: true, force: true }));
  for (const patch of state.patches.slice(0, 2)) {
    execFileSync("git", ["apply", "--whitespace=nowarn", patch], { cwd: state.checkout });
  }

  assert.deepEqual(applyCompatibilityPatchStack(state), { appliedPrefix: 2, appliedCount: 2 });
  assert.equal(readFileSync(join(state.checkout, "shared.txt"), "utf8"), "delivery-quality\nkeep\n");
});

test("adds delivery-quality as a suffix to the already-applied Artifact+Evolution+Telegram stack", (t) => {
  const state = fixture();
  t.after(() => rmSync(state.directory, { recursive: true, force: true }));
  for (const patch of state.patches.slice(0, 3)) {
    execFileSync("git", ["apply", "--whitespace=nowarn", patch], { cwd: state.checkout });
  }

  assert.deepEqual(applyCompatibilityPatchStack(state), { appliedPrefix: 3, appliedCount: 1 });
  assert.deepEqual(applyCompatibilityPatchStack(state), { appliedPrefix: 4, appliedCount: 0 });
  assert.equal(readFileSync(join(state.checkout, "shared.txt"), "utf8"), "delivery-quality\nkeep\n");
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

test("applies the delivery-quality table allowlist patch after an Evolution-patched host", (t) => {
  const state = fixture();
  t.after(() => rmSync(state.directory, { recursive: true, force: true }));
  const constants = join(state.checkout, "packages/shared/src/constants.ts");
  mkdirSync(join(state.checkout, "packages/shared/src"), { recursive: true });
  writeFileSync(constants, `export const PLUGIN_DATABASE_CORE_READ_TABLES = [\n  "activity_log",\n  "agent_config_revisions",\n  "company_skills",\n  "company_skill_versions",\n] as const;\n`);
  git(state.checkout, "add", "packages/shared/src/constants.ts");
  git(state.checkout, "commit", "-qm", "evolution table allowlist");
  const patch = resolve(dirname(fileURLToPath(import.meta.url)), "../compat/paperclip-delivery-quality-read.patch");
  const stack = { checkout: state.checkout, patches: [patch] };

  assert.deepEqual(applyCompatibilityPatchStack(stack), { appliedPrefix: 0, appliedCount: 1 });
  assert.deepEqual(applyCompatibilityPatchStack(stack), { appliedPrefix: 1, appliedCount: 0 });
  const result = readFileSync(constants, "utf8");
  assert.match(result, /"delivery_revisions"/);
  assert.match(result, /"delivery_evaluations"/);
  assert.match(result, /"run_execution_profiles"/);
  assert.doesNotMatch(result, /CREATE TABLE|CREATE INDEX/i);
});
