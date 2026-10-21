import test from "node:test";
import assert from "node:assert/strict";
import { createGithubClient } from "../src/github-client.js";

test("every GitHub request carries a User-Agent (GitHub answers 403 without one)", async () => {
  const seen = [];
  const ctx = {
    http: {
      fetch: async (url, init) => {
        seen.push(init.headers);
        return new Response(JSON.stringify({ number: 1, state: "open", head: { sha: "a".repeat(40) }, base: {}, user: {}, labels: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  };
  await createGithubClient(ctx).getPull("token", "wallynm", "tesselapp", 1);
  assert.ok(seen.length > 0);
  for (const headers of seen) assert.ok(headers["User-Agent"], "User-Agent header is set");
});
