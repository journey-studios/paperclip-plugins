import test from "node:test";
import assert from "node:assert/strict";
import { fetchApprovalEvidence } from "../src/github-api.js";

const SHA = "a".repeat(40);
const run = (overrides = {}) => ({ name: "tests", status: "completed", conclusion: "success", head_sha: SHA, ...overrides });
function fixture({ runs = [run()], statuses = [], checkStatus = 200, total = runs.length } = {}) {
  const calls = [];
  const ctx = { http: { fetch: async (url) => {
    calls.push(url);
    if (url.includes("/check-runs?")) return Response.json({ total_count: total, check_runs: runs }, { status: checkStatus });
    return Response.json({ sha: SHA, total_count: statuses.length, statuses });
  } } };
  return { calls, review: () => fetchApprovalEvidence(ctx, "fixture-token", "o", "r", SHA) };
}

test("only actual success at the reviewed SHA proves CI execution", async () => {
  assert.equal((await fixture().review()).status, "pass");
  for (const conclusion of ["neutral", "skipped", "cancelled", null]) {
    assert.equal((await fixture({ runs: [run({ conclusion })] }).review()).status, "partial");
  }
  assert.equal((await fixture({ runs: [run({ head_sha: "b".repeat(40) })] }).review()).status, "partial");
  assert.equal((await fixture({ runs: [run({ status: "in_progress" })] }).review()).status, "partial");
  assert.equal((await fixture({ runs: [run({ conclusion: "failure" })] }).review()).status, "fail");
  assert.equal((await fixture({ runs: [] }).review()).status, "partial");
});

test("unreadable checks remain partial even when legacy statuses are green", async () => {
  for (const checkStatus of [403, 404, 502]) {
    const result = await fixture({ checkStatus, statuses: [{ context: "tests", state: "success" }] }).review();
    assert.equal(result.status, "partial");
  }
  assert.equal((await fixture({ runs: [], statuses: [{ context: "tests", state: "success" }] }).review()).status, "pass");
  assert.equal((await fixture({ statuses: [{ context: "external", state: "pending" }] }).review()).status, "partial");
});

test("a failure on a later CI page prevents approval", async () => {
  const calls = [];
  const ctx = { http: { fetch: async (url) => {
    calls.push(url);
    if (url.includes("/status?")) return Response.json({ sha: SHA, total_count: 0, statuses: [] });
    const page = Number(new URL(url).searchParams.get("page"));
    const runs = Array.from({ length: 100 }, () => run());
    if (page === 2) runs[0] = run({ conclusion: "failure" });
    return Response.json({ total_count: 200, check_runs: runs });
  } } };
  assert.equal((await fetchApprovalEvidence(ctx, "fixture", "o", "r", SHA)).status, "fail");
  assert.equal(calls.length, 3);
});

test("an unbounded or malformed CI response cannot silently look complete", async () => {
  const f = fixture({ runs: Array.from({ length: 100 }, () => run()), total: 500 });
  assert.equal((await f.review()).status, "partial");
  assert.equal(f.calls.length, 4);
  const ctx = { http: { fetch: async () => Response.json({}) } };
  assert.equal((await fetchApprovalEvidence(ctx, "fixture", "o", "r", SHA)).status, "partial");
});

test("an infrastructure annotation proves the check never ran instead of blaming the code", async () => {
  const notRun = run({ id: 1, conclusion: "failure", started_at: "2026-10-23T01:00:00Z", completed_at: "2026-10-23T01:00:00Z", output: { annotations_count: 1 } });
  const ctx = { http: { fetch: async (url) => {
    if (url.includes("/annotations?")) return Response.json([{ message: "The job was not started because the spending limit was reached." }]);
    if (url.includes("/check-runs?")) return Response.json({ check_runs: [notRun], total_count: 1 });
    return Response.json({ sha: SHA, statuses: [], total_count: 0 });
  } } };
  const result = await fetchApprovalEvidence(ctx, "fixture", "o", "r", SHA);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.successfulChecks, []);
});
