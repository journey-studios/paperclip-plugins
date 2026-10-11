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
  for (const field of ["actorUserId", "botToken", "approvals.decide", "respondInteraction", "callback_query", "fetch (", "fetch\n("]) {
    assert.throws(() => assertNativeDecisionPublicationPatch(patch + "\n+// " + field.replaceAll("\n", "\n+") + "\n"), /votes, callback/);
  }
});


test("SDK worker publication guards reject unknown serialized input fields before RPC", () => {
  // Exercise the literal added guards from the reviewed compatibility patch.
  const added = [...patch.matchAll(/^\+(?!\+)(.*)$/gm)].map((m) => m[1]).join("\n");
  const approval = { kind: "approval", id: "00000000-0000-4000-8000-000000000001" };
  for (const name of ["getDecisionCardContext", "publishDecisionCard"]) {
    const begin = added.indexOf("async " + name + "(input, companyId) {");
    const end = added.indexOf("const capability =", begin);
    assert.ok(begin >= 0 && end > begin);
    const code = added.slice(added.indexOf("{", begin) + 1, end);
    const validate = new Function("input", code);
    const valid = name === "getDecisionCardContext"
      ? { decision: approval, destinationIssueId: "chat-issue" }
      : { decision: approval, destinationConversationId: "conversation", expectedRevision: "revision" };
    assert.doesNotThrow(() => validate(valid));
    for (const value of [null, [], "string", {}, { ...valid, unrecognized: "field" },
      { ...valid, decision: { ...approval, spoofedPrincipal: "other" } }]) assert.throws(() => validate(value), /shape invalid/);
    if (name === "getDecisionCardContext") {
      assert.throws(() => validate({ ...valid, destinationConversationId: "other" }), /shape invalid/);
      assert.doesNotThrow(() => validate({ decision: approval, destinationConversationId: "conversation" }));
    }
  }
});
