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

test("listing open pull requests never sends a conditional request (the host cannot represent a 304)", async () => {
  const seen = [];
  const ctx = {
    http: {
      fetch: async (_url, init) => {
        seen.push(init.headers);
        return new Response(JSON.stringify([{ number: 7 }]), { status: 200 });
      },
    },
  };
  const listing = await createGithubClient(ctx).listOpenPulls("token", "wallynm", "tesselapp");
  assert.deepEqual(listing.pulls, [{ number: 7 }]);
  for (const headers of seen) assert.ok(!("If-None-Match" in headers));
});
