import test from "node:test";
import assert from "node:assert/strict";
import {
  assertEvolutionCompatibilityPatch,
  assertPublicCompatibilityPatch,
  assertRepository,
  assertWorkspaceAlias,
  checkoutNeedsPin,
} from "../scripts/bootstrap-contract.mjs";

const remote = "https://github.com/paperclipai/paperclip.git";
const pinned = "8f8a0ab7effbd6a0584107d8038736c134ee5047";

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
    '"activity_log"',
    '"journeystudios.evolution"',
    '"evolution"',
  ].join("\n");
  assert.doesNotThrow(() => assertEvolutionCompatibilityPatch(valid));
  assert.throws(() => assertEvolutionCompatibilityPatch('"activity_log" only'), /Evolution compatibility/);
});

test("rejects a workspace alias that points away from the requested host checkout", () => {
  assert.doesNotThrow(() => assertWorkspaceAlias("/workspace/host", "/workspace/host"));
  assert.throws(() => assertWorkspaceAlias("/workspace/other", "/workspace/host"), /exact checkout/);
});
