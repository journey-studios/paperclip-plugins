import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../src/engine.js";
import { targetOf } from "../src/contract.js";
const companyId = "11111111-1111-4111-8111-111111111111";
const target = targetOf({ key: "chat", environment: "prod", projectId: "22222222-2222-4222-8222-222222222222", url: "https://dash.tessel.app/chat" });
function context() {
  const writes = [];
  const ctx = { companies: { list: async () => [{ id: companyId }] }, config: { get: async () => ({ targets: [target], controllerUrl: "https://controller.example.test", controllerTokenRef: { type: "secret_ref", secretId: companyId } }) },
    secrets: { resolve: async () => "test-only-not-a-credential" }, logger: { warn() {} },
    db: { namespace: "plugin_performance_observatory_27b58b0e8b", query: async () => [{ id: "44444444-4444-4444-8444-444444444444", status: "running", target_snapshot: target }], execute: async (sql, values) => { writes.push({ sql, values }); return { rowCount: 1 }; } } };
  return { ctx, writes };
}
test("a completed but invalid result becomes a failed run rather than staying running forever", async () => {
  const { ctx, writes } = context(); const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: "completed", result: { schema: "invalid" } }));
  try { await reconcile(ctx); } finally { globalThis.fetch = original; }
  assert.ok(writes.some((write) => write.sql.includes("status = 'failed'") && write.values.includes("RESULT_TARGET_MISMATCH")));
});
test("transport failure keeps an already submitted run resumable", async () => {
  const { ctx, writes } = context(); const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  try { await reconcile(ctx); } finally { globalThis.fetch = original; }
  assert.ok(writes.some((write) => write.values.includes("CONTROLLER_UNREACHABLE")));
  assert.equal(writes.some((write) => write.sql.includes("status = 'failed'")), false);
});
