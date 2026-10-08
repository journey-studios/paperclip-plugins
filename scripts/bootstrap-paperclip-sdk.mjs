import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCompatibilityPatchStack } from "./compatibility-patch-stack.mjs";
import {
  assertEvolutionCompatibilityPatch,
  assertPublicCompatibilityPatch,
  assertTelegramChatPublicationPatch,
  assertRepository,
  assertWorkspaceAlias,
  checkoutNeedsPin,
} from "./bootstrap-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localCheckout = resolve(root, ".paperclip");
const externalCheckout = process.env.PAPERCLIP_HOST_DIR ? resolve(process.env.PAPERCLIP_HOST_DIR) : null;
const checkout = externalCheckout ?? localCheckout;
const artifactPatch = resolve(root, "compat/paperclip-artifacts-read.patch");
const evolutionPatch = resolve(root, "compat/paperclip-evolution.patch");
const telegramChatPatch = resolve(root, "compat/paperclip-telegram-chat-publication.patch");
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

const compatibilityPatches = [
  { path: artifactPatch, validate: assertPublicCompatibilityPatch },
  { path: evolutionPatch, validate: assertEvolutionCompatibilityPatch },
  { path: telegramChatPatch, validate: assertTelegramChatPublicationPatch },
];

for (const compatibilityPatch of compatibilityPatches) {
  const patchText = readFileSync(compatibilityPatch.path, "utf8");
  compatibilityPatch.validate(patchText);
}
applyCompatibilityPatchStack({ checkout, patches: compatibilityPatches.map(({ path }) => path) });

const sdkPackage = JSON.parse(readFileSync(resolve(checkout, "packages/plugins/sdk/package.json"), "utf8"));
if (sdkPackage.version !== "1.0.0" || !existsSync(resolve(checkout, "packages/plugins/sdk/src/types.ts"))) {
  throw new Error("Pinned Paperclip checkout does not contain the expected Plugin SDK v1 source");
}
console.log(`Verified Paperclip ${commit} with Artifact Library, Evolution, and Telegram chat publication SDK compatibility patches.`);
