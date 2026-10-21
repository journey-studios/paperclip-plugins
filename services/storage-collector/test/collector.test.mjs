import test from "node:test";
import assert from "node:assert/strict";
import { collect, cpuUsagePercent, DIRECTORIES, inspectDirectory, makeHistory, parseAlertPolicy, parseDf, parseDirectoryConfig, parseDocker, parseDu, parseHumanBytes, parseMeminfo } from "../src/lib.mjs";

const df = "1B-blocks Used Available Use%\n10000 8000 2000 80%\n";
const docker = [
  JSON.stringify({ Type: "Images", TotalCount: "24", Active: "9", Size: "17.47GB", Reclaimable: "877.4MB (5%)" }),
  JSON.stringify({ Type: "Build Cache", TotalCount: "141", Active: "76", Size: "17.85GB", Reclaimable: "592MB (3%)" }),
].join("\n");
const date = new Date("2026-10-07T22:00:00.000Z");
const meminfo = "MemTotal:       8000000 kB\nMemFree:         100000 kB\nMemAvailable:   2000000 kB\nSwapTotal:      1000000 kB\nSwapFree:        750000 kB\n";
const host = {
  cpuSampler: async () => ({ cores: 4, usagePercent: 25.5, load1: 0.5, load5: 0.4, load15: 0.3 }),
  readText: async () => meminfo,
  uptime: () => 12345.6,
};

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
    ...host, run, now: () => date,
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
test("distinguishes missing directories from inaccessible directories without leaking errors", async () => {
  const accessError = (code) => Object.assign(new Error("sensitive host diagnostic"), { code });
  for (const code of ["ENOENT", "ENOTDIR"]) {
    assert.equal(await inspectDirectory("/path", async () => { throw accessError(code); }), false);
  }
  for (const code of ["EACCES", "EPERM", "EIO"]) {
    await assert.rejects(inspectDirectory("/path", async () => { throw accessError(code); }),
      (error) => error.code === code);
  }
  assert.equal(await inspectDirectory("/path", async () => {}), true);

  const snapshot = await collect({
    ...host, now: () => date,
    directories: [
      { id: "denied", label: "Denied", path: "/denied" },
      { id: "broken", label: "Broken", path: "/broken" },
      { id: "absent", label: "Absent", path: "/absent" },
    ],
    inspect: (path) => inspectDirectory(path, async () => {
      if (path === "/denied") throw accessError("EACCES");
      if (path === "/broken") throw accessError("EIO");
      throw accessError("ENOENT");
    }),
    run: async (command) => command === "df" ? df : docker,
  });
  assert.deepEqual(snapshot.directories.map((row) => row.status),
    ["unavailable", "unavailable", "missing"]);
  assert.deepEqual(snapshot.coverage.issues, [
    { source: "denied", code: "inspection_failed" },
    { source: "broken", code: "inspection_failed" },
  ]);
  assert.equal(snapshot.coverage.partial, true);
  assert.ok(!JSON.stringify(snapshot).includes("sensitive host diagnostic"));
});

test("directory scanning respects a total deadline and marks unvisited sources unavailable", async () => {
  let elapsed = 0;
  const duTimeouts = [];
  let inspectCalls = 0;
  const directories = Array.from({ length: 4 }, (_, i) => ({
    id: "source-" + i, label: "Source " + i, path: "/allowlisted/" + i,
  }));
  const snapshot = await collect({
    ...host, now: () => date, clock: () => elapsed, directories,
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
  const value = await collect({ ...host, now: () => date, directories: [],
    run: async (cmd) => cmd === "df" ? df : Promise.reject(new Error("socket unavailable")) });
  assert.equal(value.filesystem.usedBytes, 8000);
  assert.equal(value.docker.length, 0);
  assert.deepEqual(value.coverage.issues, [{ source: "docker", code: "command_failed" }]);
  await assert.rejects(collect({ ...host, now: () => date, directories: [], run: async () => "malformed" }), /df/);
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

test("memory is derived from MemAvailable, with swap, and rejects malformed or inconsistent input", () => {
  assert.deepEqual(parseMeminfo(meminfo), {
    totalBytes: 8000000 * 1024, availableBytes: 2000000 * 1024, usedBytes: 6000000 * 1024, usedPercent: 75,
    swapTotalBytes: 1000000 * 1024, swapUsedBytes: 250000 * 1024,
  });
  assert.throws(() => parseMeminfo("MemTotal: 1 kB\n"), /meminfo/);
  assert.throws(() => parseMeminfo(meminfo.replace("MemAvailable:   2000000", "MemAvailable:   9000000")), /Inconsistent/);
  assert.throws(() => parseMeminfo(meminfo.replace("SwapFree:        750000", "SwapFree:        2000000")), /Inconsistent/);
});
test("cpu usage is the busy share between two samples and rejects impossible deltas", () => {
  const sample = (idle, busy) => [{ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }];
  assert.equal(cpuUsagePercent(sample(0, 0), sample(75, 25)), 25);
  assert.equal(cpuUsagePercent(sample(0, 0), sample(0, 100)), 100);
  assert.throws(() => cpuUsagePercent(sample(5, 5), sample(5, 5)), /Inconsistent/);
  assert.throws(() => cpuUsagePercent([], []), /No CPU/);
});
test("schema 2 snapshots carry cpu, memory and uptime, and a failed probe is isolated", async () => {
  const run = async (cmd) => cmd === "df" ? df : docker;
  const ok = await collect({ ...host, run, now: () => date, directories: [] });
  assert.equal(ok.schemaVersion, 2);
  assert.equal(ok.cpu.cores, 4);
  assert.equal(ok.memory.usedPercent, 75);
  assert.equal(ok.uptimeSeconds, 12345);
  assert.equal(ok.coverage.partial, false);
  const broken = await collect({ ...host, run, now: () => date, directories: [],
    cpuSampler: async () => { throw new Error("private cpu failure"); },
    readText: async () => { throw new Error("private proc failure"); } });
  assert.equal(broken.cpu, null);
  assert.equal(broken.memory, null);
  assert.equal(broken.filesystem.usedBytes, 8000);
  assert.deepEqual(broken.coverage.issues, [{ source: "cpu", code: "read_failed" }, { source: "memory", code: "read_failed" }]);
  assert.ok(!JSON.stringify(broken).includes("private"));
});
test("history keeps cpu and memory samples when present", () => {
  const snapshot = { generatedAt: date.toISOString(), filesystem: { usedBytes: 8000, availableBytes: 2000 }, cpu: { usagePercent: 25.5 }, memory: { usedBytes: 6144 } };
  assert.deepEqual(makeHistory(null, snapshot).at(-1), { at: date.toISOString(), usedBytes: 8000, availableBytes: 2000, cpuPercent: 25.5, memoryUsedBytes: 6144 });
  assert.equal("cpuPercent" in makeHistory(null, { ...snapshot, cpu: null }).at(-1), false);
});
test("operator directory config is validated: absolute, normalized, unique, bounded", () => {
  const good = [{ id: "data", label: "Dados", path: "/srv/data" }, { id: "logs-1", label: "Logs", path: "/var/log" }];
  assert.deepEqual(parseDirectoryConfig(JSON.stringify(good)).map((row) => row.id), ["data", "logs-1"]);
  for (const bad of [
    [], "not json", [{ id: "x", label: "X", path: "/" }], [{ id: "x", label: "X", path: "relative" }],
    [{ id: "x", label: "X", path: "/a/../b" }], [{ id: "x", label: "X", path: "/a//b" }], [{ id: "x", label: "X", path: "/a/" }],
    [{ id: "X!", label: "X", path: "/a" }], [{ id: "x", label: "/etc/shadow", path: "/a" }],
    [{ id: "x", label: "X", path: "/a" }, { id: "x", label: "Y", path: "/b" }],
    Array.from({ length: 31 }, (_, i) => ({ id: "d" + i, label: "D", path: "/d" + i })),
  ]) assert.throws(() => parseDirectoryConfig(typeof bad === "string" ? bad : JSON.stringify(bad)));
});
