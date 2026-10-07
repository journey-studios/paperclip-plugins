import assert from "node:assert/strict";
import test from "node:test";
import { withCaptureRetry } from "../src/capture-retry.ts";

function driverError(constraint, code = "23503") {
  return Object.assign(new Error("foreign key violation"), { code, constraint_name: constraint });
}

test("capture retries both merge-related driver foreign keys and preserves its result", async () => {
  let attempts = 0;
  const result = await withCaptureRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw driverError("evolution_change_items_company_set_fkey");
    if (attempts === 2) throw driverError("evolution_change_links_company_set_fkey");
    return { captured: true };
  });
  assert.equal(attempts, 3);
  assert.deepEqual(result, { captured: true });
});

test("capture recognizes foreign key errors whose worker RPC only preserves the message", async () => {
  for (const constraint of ["evolution_change_items_company_set_fkey", "evolution_change_links_company_set_fkey"]) {
    let attempts = 0;
    assert.equal(await withCaptureRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(
        new Error(`insert or update on table "child" violates foreign key constraint "${constraint}"`),
        { name: "JsonRpcCallError", code: -32603 },
      );
      return "captured";
    }), "captured");
    assert.equal(attempts, 2);
  }
});

test("capture failure is bounded at three attempts and propagates the original error", async () => {
  const error = driverError("evolution_change_items_company_set_fkey");
  let attempts = 0;
  await assert.rejects(withCaptureRetry(async () => {
    attempts += 1;
    throw error;
  }), (caught) => caught === error);
  assert.equal(attempts, 3);
});

test("capture does not retry other constraints, SQL states, or arbitrary errors", async () => {
  for (const error of [
    driverError("evolution_change_evidence_company_set_fkey"),
    driverError("evolution_change_items_company_set_fkey", "23505"),
    Object.assign(new Error('violates foreign key constraint "evolution_change_items_company_set_fkey"'), { code: -32000 }),
    new Error("evolution_change_items_company_set_fkey unrelated failure"),
    new Error('violates foreign key constraint "prefix_evolution_change_items_company_set_fkey_suffix"'),
    new Error("connection failed"),
    null,
  ]) {
    let attempts = 0;
    await assert.rejects(withCaptureRetry(async () => {
      attempts += 1;
      throw error;
    }), (caught) => caught === error);
    assert.equal(attempts, 1);
  }
});

test("successful capture is called once", async () => {
  let attempts = 0;
  assert.equal(await withCaptureRetry(async () => { attempts += 1; return 42; }), 42);
  assert.equal(attempts, 1);
});
