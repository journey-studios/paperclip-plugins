import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertEvolutionCompatibilityPatch,
  assertDeliveryQualityCompatibilityPatch,
  assertPublicCompatibilityPatch,
  assertRepository,
  assertTelegramChatPublicationPatch,
  assertWorkspaceAlias,
  checkoutNeedsPin,
} from "../scripts/bootstrap-contract.mjs";

const remote = "https://github.com/paperclipai/paperclip.git";
const pinned = "8f8a0ab7effbd6a0584107d8038736c134ee5047";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("accepts only the public upstream origin", () => {
  assert.doesNotThrow(() => assertRepository(remote, remote));
  assert.throws(() => assertRepository("https://example.invalid/paperclip.git", remote), /origin/);
});

test("pins a clean or newly cloned checkout and refuses dirty mismatched source", () => {
  assert.equal(checkoutNeedsPin({ currentCommit: pinned, pinnedCommit: pinned, status: "", newlyCloned: false }), false);
  assert.equal(checkoutNeedsPin({ currentCommit: "other", pinnedCommit: pinned, status: "", newlyCloned: false }), true);
  assert.equal(checkoutNeedsPin({ currentCommit: "other", pinnedCommit: pinned, status: "D  src/a.ts", newlyCloned: true }), true);
  assert.throws(
    () => checkoutNeedsPin({ currentCommit: "other", pinnedCommit: pinned, status: " M src/a.ts", newlyCloned: false }),
    /modified/,
  );
  assert.throws(
    () => checkoutNeedsPin({ currentCommit: "other", pinnedCommit: pinned, status: "D  src/a.ts", newlyCloned: false }),
    /modified/,
  );
});

test("rejects compatibility patches with missing API or organization fixtures", () => {
  assert.doesNotThrow(() => assertPublicCompatibilityPatch("artifacts.read\n\"artifacts.list\"\n"));
  assert.throws(() => assertPublicCompatibilityPatch("artifacts.read only"), /missing/);
  assert.throws(() => assertPublicCompatibilityPatch(`artifacts.read\n\"artifacts.list\"\n${"JOU-"}999999`), /fixtures/);
});

test("validates the Evolution compatibility patch contract", () => {
  const valid = [
    '"agent_config_revisions"',
    '"company_skill_versions"',
    '"company_skills"',
    '"activity_log"',
    '"activity.logged"',
    "activityAction",
    '"journeystudios.evolution"',
    '"evolution"',
  ].join("\n");
  assert.doesNotThrow(() => assertEvolutionCompatibilityPatch(valid));
  assert.throws(() => assertEvolutionCompatibilityPatch('"activity_log" only'), /Evolution compatibility/);
});

test("delivery-quality compatibility adds only core read-table allowlist entries", () => {
  const patch = readFileSync(resolve(repositoryRoot, "compat/paperclip-delivery-quality-read.patch"), "utf8");
  assert.doesNotThrow(() => assertDeliveryQualityCompatibilityPatch(patch));
  assert.throws(() => assertDeliveryQualityCompatibilityPatch(patch.replace('"run_execution_profiles",', '"other_table",')), /three core read-table/);
  assert.throws(() => assertDeliveryQualityCompatibilityPatch(patch.replace('+  "run_execution_profiles",', '+  "run_execution_profiles",\n+  "extra_table",')), /three core read-table/);
  assert.throws(() => assertDeliveryQualityCompatibilityPatch(patch.replace('   "company_skill_versions",', '-  "company_skill_versions",\n   "company_skill_versions",')), /three core read-table/);
  assert.throws(() => assertDeliveryQualityCompatibilityPatch(`${patch}\n+CREATE TABLE delivery_evaluations(id uuid);`), /three core read-table|host code or schema/);
  assert.throws(() => assertDeliveryQualityCompatibilityPatch(patch.replace("packages/shared/src/constants.ts", "packages/db/src/schema.ts")), /three core read-table/);
});

test("Telegram chat publication compatibility patch is limited to SDK client files", () => {
  const valid = readFileSync(resolve(repositoryRoot, "compat/paperclip-telegram-chat-publication.patch"), "utf8");
  assert.doesNotThrow(() => assertTelegramChatPublicationPatch(valid));
  assert.throws(() => assertTelegramChatPublicationPatch(valid.replace("+++ b/packages/plugins/sdk/src/types.ts", "+++ b/server/src/types.ts")), /only the SDK/);
  assert.throws(() => assertTelegramChatPublicationPatch(valid.replace("--- a/packages/plugins/sdk/src/types.ts", "--- a/packages/db/src/types.ts")), /only the SDK/);
  assert.throws(() => assertTelegramChatPublicationPatch(valid.replaceAll("chat.publications.publish_existing_comment", "missing")), /missing its capability/);
  assert.throws(() => assertTelegramChatPublicationPatch(valid.replace(
    '+  "chat.publications.publish_existing_comment",',
    '+  "chat.publications.publish_existing_comment",\n+  "issues.delete",',
  )), /single capability/);
});

test("rejects Evolution patches that omit a required read table or Audit forwarding field", () => {
  const valid = [
    '"agent_config_revisions"',
    '"company_skill_versions"',
    '"company_skills"',
    '"activity_log"',
    '"activity.logged"',
    "activityAction",
    '"journeystudios.evolution"',
    '"evolution"',
  ].join("\n");

  for (const omitted of ['"company_skills"', '"activity.logged"', "activityAction"]) {
    const incomplete = valid.split("\n").filter((token) => token !== omitted).join("\n");
    assert.throws(
      () => assertEvolutionCompatibilityPatch(incomplete),
      /Evolution compatibility/,
      `Missing ${omitted} must fail even when every other contract token is present`,
    );
  }
});

test("rejects a workspace alias that points away from the requested host checkout", () => {
  assert.doesNotThrow(() => assertWorkspaceAlias("/workspace/host", "/workspace/host"));
  assert.throws(() => assertWorkspaceAlias("/workspace/other", "/workspace/host"), /exact checkout/);
});
