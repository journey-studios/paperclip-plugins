import test from "node:test";
import assert from "node:assert/strict";
import { RETRY_SPACING, RETRY_WINDOW, listRetryableReceipts } from "../src/receipt-store.js";

// The query runs in Postgres, which these tests do not have. They pin down the shape that matters:
// the retry window is measured from created_at (fixed) and only the spacing from updated_at (which
// every attempt refreshes). Measuring the window from updated_at would retry a permanent failure forever.
test("the retry window is bounded by created_at, the spacing by updated_at", async () => {
  const calls = [];
  const ctx = { db: { namespace: "plugin_test", query: async (sql, params) => { calls.push({ sql, params }); return []; } } };
  await listRetryableReceipts(ctx, 7);

  const { sql, params } = calls[0];
  const normalized = sql.replace(/\s+/g, " ");
  assert.match(normalized, /status = 'failed'/);
  assert.match(normalized, new RegExp(`created_at > now\\(\\) - interval '${RETRY_WINDOW}'`));
  assert.match(normalized, new RegExp(`updated_at < now\\(\\) - interval '${RETRY_SPACING}'`));
  assert.doesNotMatch(normalized, /updated_at > now\(\)/, "the upper bound must not slide with each attempt");
  assert.deepEqual(params, [7]);
  assert.match(normalized, /FROM plugin_test\.review_receipts/);
});
