import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertNativeDecisionPublicationPatch } from "../scripts/bootstrap-contract.mjs";
const patch = readFileSync(new URL("../compat/paperclip-native-decision-publication.patch", import.meta.url), "utf8");

test("native publication compatibility is SDK-only and declares one narrow capability", () => {
  assert.doesNotThrow(() => assertNativeDecisionPublicationPatch(patch));
  assert.throws(() => assertNativeDecisionPublicationPatch(patch.replaceAll("packages/plugins/sdk/src/types.ts", "server/src/services/chat-channels.ts")), /SDK\/shared/);
  assert.throws(() => assertNativeDecisionPublicationPatch(patch.replace('"chat.publications.publish_decision_card",', '"approvals.respond",')), /capability/);
});

test("client compatibility cannot add human impersonation, voting or raw bot transport", () => {
  for (const field of ["actorUserId", "botToken", "approvals.decide", "respondInteraction", "callback_query"]) {
    assert.throws(() => assertNativeDecisionPublicationPatch(patch + "\n+// " + field + "\n"), /votes, callback/);
  }
});
