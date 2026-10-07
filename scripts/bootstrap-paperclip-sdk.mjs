import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPublicCompatibilityPatch,
  assertRepository,
  assertWorkspaceAlias,
  checkoutNeedsPin,
} from "./bootstrap-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localCheckout = resolve(root, ".paperclip");
const externalCheckout = process.env.PAPERCLIP_HOST_DIR ? resolve(process.env.PAPERCLIP_HOST_DIR) : null;
const checkout = externalCheckout ?? localCheckout;
const patch = resolve(root, "compat/paperclip-artifacts-read.patch");
const repository = "https://github.com/paperclipai/paperclip.git";
const commit = "8f8a0ab7effbd6a0584107d8038736c134ee5047";

function git(...args) {
  return execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
}

if (externalCheckout && !existsSync(localCheckout)) {
  symlinkSync(checkout, localCheckout, "dir");
}
if (externalCheckout && realpathSync(localCheckout) !== realpathSync(externalCheckout)) {
  assertWorkspaceAlias(realpathSync(localCheckout), realpathSync(externalCheckout));
}
let newlyCloned = false;
if (!existsSync(checkout)) {
  execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", repository, checkout], {
    cwd: root,
    stdio: "inherit",
  });
  newlyCloned = true;
}
if (!statSync(checkout).isDirectory() || !existsSync(resolve(checkout, ".git"))) {
  throw new Error("Paperclip host directory must be a Git checkout");
}
assertRepository(git("remote", "get-url", "origin"), repository);
const currentCommit = git("rev-parse", "HEAD");
if (checkoutNeedsPin({ currentCommit, pinnedCommit: commit, status: git("status", "--porcelain"), newlyCloned })) {
  execFileSync("git", ["fetch", "--depth", "1", "origin", commit], { cwd: checkout, stdio: "inherit" });
  execFileSync("git", ["checkout", "--detach", commit], { cwd: checkout, stdio: "inherit" });
}
if (git("rev-parse", "HEAD") !== commit) throw new Error("Paperclip checkout does not match the required commit");

const patchText = readFileSync(patch, "utf8");
assertPublicCompatibilityPatch(patchText);
try {
  execFileSync("git", ["apply", "--reverse", "--check", patch], { cwd: checkout, stdio: "ignore" });
} catch {
  execFileSync("git", ["apply", "--check", patch], { cwd: checkout, stdio: "inherit" });
  execFileSync("git", ["apply", "--whitespace=nowarn", patch], { cwd: checkout, stdio: "inherit" });
}

const sdkPackage = JSON.parse(readFileSync(resolve(checkout, "packages/plugins/sdk/package.json"), "utf8"));
if (sdkPackage.version !== "1.0.0" || !existsSync(resolve(checkout, "packages/plugins/sdk/src/types.ts"))) {
  throw new Error("Pinned Paperclip checkout does not contain the expected Plugin SDK v1 source");
}
console.log(`Verified Paperclip ${commit} with the artifacts.read host compatibility patch.`);
