import test from "node:test";
import assert from "node:assert/strict";
import { collect, DIRECTORIES, makeHistory, parseAlertPolicy, parseDf, parseDocker, parseDu, parseHumanBytes } from "../src/lib.mjs";

const df = "1B-blocks Used Available Use%\n10000 8000 2000 80%\n";
const docker = [
  JSON.stringify({ Type: "Images", TotalCount: "24", Active: "9", Size: "17.47GB", Reclaimable: "877.4MB (5%)" }),
  JSON.stringify({ Type: "Build Cache", TotalCount: "141", Active: "76", Size: "17.85GB", Reclaimable: "592MB (3%)" }),
].join("\n");
const date = new Date("2026-10-07T22:00:00.000Z");

test("parses df in exact bytes, Docker approximations, and du without adding layer sizes", () => {
  assert.deepEqual(parseDf(df), { mount: "/", totalBytes: 10000, usedBytes: 8000, availableBytes: 2000, usedPercent: 80 });
  assert.equal(parseDu("31000000000\t/var/lib/containerd\n"), 31000000000);
  assert.equal(parseHumanBytes("2.5GiB"), 2.5 * 1024 ** 3);
  assert.equal(parseHumanBytes("0B (0%)"), 0);
  const rows = parseDocker(docker);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sizeBytes, 17470000000);
  assert.equal(rows[0].reclaimableBytes, 877400000);
  assert.equal(rows[1].count, 141);
  assert.equal(rows[1].approximate, true);
});
test("bounded read-only command list, missing dirs, and partial coverage", async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "df") return df;
    if (cmd === "docker") return docker;
    if (cmd === "du" && args.includes("/missing")) throw new Error("private host failure");
    return "500\t" + args.at(-1) + "\n";
  };
  const snapshot = await collect({
    run, now: () => date,
    inspect: async (path) => path !== "/absent",
    directories: [
      { id: "containerd", label: "Containerd", path: "/var/lib/containerd" },
      { id: "repos", label: "Repos", path: "/absent" },
      { id: "builds", label: "Builds", path: "/missing" },
    ],
    alertPolicy: { warnFreeBytes: null, criticalFreeBytes: null },
  });
  assert.equal(snapshot.filesystem.availableBytes, 2000);
  assert.deepEqual(snapshot.directories.map((r) => r.status), ["ok", "missing", "unavailable"]);
  assert.equal(snapshot.coverage.partial, true);
  assert.ok(!JSON.stringify(snapshot).includes("private host failure"));
  assert.deepEqual(calls.map((call) => call.cmd), ["df", "docker", "du", "du"]);
  assert.deepEqual(calls[2].args, ["-x", "-s", "-B1", "--", "/var/lib/containerd"]);
});
test("directory scanning respects a total deadline and marks unvisited sources unavailable", async () => {
  let elapsed = 0;
  const duTimeouts = [];
  let inspectCalls = 0;
  const directories = Array.from({ length: 4 }, (_, i) => ({
    id: "source-" + i, label: "Source " + i, path: "/allowlisted/" + i,
  }));
  const snapshot = await collect({
    now: () => date, clock: () => elapsed, directories,
    inspect: async () => {
      inspectCalls++;
      if (inspectCalls === 1) elapsed += 155_000;
      return true;
    },
    run: async (command, args, timeout) => {
      if (command === "df") return df;
      if (command === "docker") return docker;
      if (command === "du") {
        duTimeouts.push(timeout);
        elapsed += timeout;
        return "100\t" + args.at(-1) + "\n";
      }
      throw new Error("Unexpected command");
    },
  });
  assert.deepEqual(duTimeouts, [25_000]);
  assert.equal(inspectCalls, 1);
  assert.deepEqual(snapshot.directories.map((row) => row.status),
    ["ok", "unavailable", "unavailable", "unavailable"]);
  assert.deepEqual(snapshot.coverage.issues, [
    { source: "source-1", code: "deadline_exceeded" },
    { source: "source-2", code: "deadline_exceeded" },
    { source: "source-3", code: "deadline_exceeded" },
  ]);
  assert.equal(snapshot.coverage.partial, true);
});

test("Docker failure is isolated; root disk remains available", async () => {
  const value = await collect({ now: () => date, directories: [],
    run: async (cmd) => cmd === "df" ? df : Promise.reject(new Error("socket unavailable")) });
  assert.equal(value.filesystem.usedBytes, 8000);
  assert.equal(value.docker.length, 0);
  assert.deepEqual(value.coverage.issues, [{ source: "docker", code: "command_failed" }]);
  await assert.rejects(collect({ now: () => date, directories: [], run: async () => "malformed" }), /df/);
});
test("history cannot grow unbounded and excludes future/corrupt rows", () => {
  const previous = { history: Array.from({ length: 1200 }, (_, i) => ({
    at: new Date(date.getTime() - (1200 - i) * 60000).toISOString(),
    usedBytes: i + 1, availableBytes: 5000,
  })).concat([{ at: "not-a-date", usedBytes: 1, availableBytes: 2 }, { at: "2030-01-01T00:00:00Z", usedBytes: 0, availableBytes: 0 }]) };
  const history = makeHistory(previous, { generatedAt: date.toISOString(), filesystem: { usedBytes: 8000, availableBytes: 2000 } });
  assert.equal(history.length, 1008);
  assert.equal(history.at(-1).usedBytes, 8000);
  assert.ok(history.every((item) => !Number.isNaN(Date.parse(item.at))));
});
test("alert thresholds are explicitly opted in and ordered", () => {
  assert.deepEqual(parseAlertPolicy({}), { warnFreeBytes: null, criticalFreeBytes: null });
  assert.deepEqual(parseAlertPolicy({ STORAGE_WARN_FREE_BYTES: "5368709120", STORAGE_CRITICAL_FREE_BYTES: "2147483648" }),
    { warnFreeBytes: 5368709120, criticalFreeBytes: 2147483648 });
  assert.throws(() => parseAlertPolicy({ STORAGE_WARN_FREE_BYTES: "-5" }), /non-negative/);
  assert.throws(() => parseAlertPolicy({ STORAGE_WARN_FREE_BYTES: "2", STORAGE_CRITICAL_FREE_BYTES: "5" }), /exceed/);
});
test("directory sources are static and cannot escape the allowlist", () => {
  assert.equal(DIRECTORIES.length, new Set(DIRECTORIES.map((r) => r.id)).size);
  for (const dir of DIRECTORIES) {
    assert.ok(dir.path.startsWith("/"));
    assert.ok(!dir.path.includes(".."));
    assert.ok(!/\/\/(?:$|[^/])/.test(dir.path));
  }
});
