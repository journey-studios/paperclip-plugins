import test from "node:test";
import assert from "node:assert/strict";
import { assertTrustedConfigFile, parseWorktreeConfig, reusableAttribution, collect, collectWorkers, collectWorktrees, cpuUsagePercent, parseContainerState, parseContainerStats, parseWorkerConfig, DIRECTORIES, inspectDirectory, makeHistory, parseAlertPolicy, parseDf, parseDirectoryConfig, parseDocker, parseDu, parseHumanBytes, parseMeminfo } from "../src/lib.mjs";

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
test("the directory allowlist file must be a root-owned regular file that others cannot write", () => {
  const file = (mode, uid = 0, regular = true) => ({ isFile: () => regular, uid, mode });
  assertTrustedConfigFile(file(0o100644));
  assertTrustedConfigFile(file(0o100600));
  assert.throws(() => assertTrustedConfigFile(file(0o100664)), /writable/);
  assert.throws(() => assertTrustedConfigFile(file(0o100646)), /writable/);
  assert.throws(() => assertTrustedConfigFile(file(0o100644, 1000)), /root/);
  assert.throws(() => assertTrustedConfigFile(file(0o040755, 0, false)), /regular/);
});
test("the default directories satisfy the same rules as an operator config", () => {
  assert.deepEqual(parseDirectoryConfig(JSON.stringify(DIRECTORIES)).map((row) => row.id), DIRECTORIES.map((row) => row.id));
});
const statsJson = [
  JSON.stringify({ Name: "runner-base", CPUPerc: "0.01%", MemUsage: "1.812MiB / 3GiB", MemPerc: "0.06%", PIDs: "2" }),
  JSON.stringify({ Name: "runner-browser", CPUPerc: "152.40%", MemUsage: "1.5GiB / 5GiB", MemPerc: "30.0%", PIDs: "41" }),
].join("\n");
const runner = { id: "runner-base", label: "Runner base", container: "runner-base" };
const browser = { id: "runner-browser", label: "Runner browser", container: "runner-browser" };
test("container state and stats parse strictly and reject unknown values", () => {
  assert.deepEqual(parseContainerState("running|healthy|2026-10-21T00:30:38.087695723Z|2|false"),
    { state: "running", health: "healthy", startedAt: "2026-10-21T00:30:38.087Z", restartCount: 2, oomKilled: false });
  assert.equal(parseContainerState("exited||0001-01-01T00:00:00Z|0|true").startedAt, null);
  assert.equal(parseContainerState("running||2026-10-21T00:30:38Z|0|false").health, null);
  for (const bad of ["running|healthy|x", "weird||2026-10-21T00:00:00Z|0|false", "running|sick|2026-10-21T00:00:00Z|0|false", "running||2026-10-21T00:00:00Z|-1|false", "running||2026-10-21T00:00:00Z|0|maybe"]) {
    assert.throws(() => parseContainerState(bad));
  }
  const stats = parseContainerStats(statsJson);
  assert.deepEqual(stats.get("runner-base"), { cpuPercent: 0, memoryUsedBytes: Math.round(1.812 * 1024 ** 2), memoryLimitBytes: 3 * 1024 ** 3, memoryPercent: 0.1, pids: 2 });
  assert.equal(stats.get("runner-browser").cpuPercent, 152.4);
  assert.throws(() => parseContainerStats(JSON.stringify({ Name: "x", CPUPerc: "n/a", MemUsage: "1MiB / 2MiB", MemPerc: "1%", PIDs: "1" })));
});
test("worker config is an allowlist of valid, unique container names", () => {
  assert.deepEqual(parseWorkerConfig(JSON.stringify([runner, browser])).map((row) => row.container), ["runner-base", "runner-browser"]);
  for (const bad of [
    [], "nope", [{ ...runner, container: "-rf" }], [{ ...runner, container: "a/b" }], [{ ...runner, container: "x y" }],
    [runner, { ...browser, container: "runner-base" }], [runner, { ...browser, id: "runner-base" }],
    [{ ...runner, label: "/etc" }], [{ ...runner, id: "Bad Id" }],
    Array.from({ length: 13 }, (_, i) => ({ id: "w" + i, label: "W", container: "c" + i })),
  ]) assert.throws(() => parseWorkerConfig(typeof bad === "string" ? bad : JSON.stringify(bad)));
});
test("workers report state, health, restarts and resource use, isolating a missing or broken container", async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "inspect") {
      const name = args.at(-1);
      if (name === "ghost") throw Object.assign(new Error("Command failed"), { stderr: "Error: No such object: ghost" });
      if (name === "broken") throw Object.assign(new Error("Command failed"), { stderr: "permission denied" });
      return name === "runner-browser" ? "exited||2026-10-20T00:00:00Z|3|true\n" : "running|healthy|2026-10-21T00:30:38.087695723Z|0|false\n";
    }
    return statsJson;
  };
  const { rows, issues } = await collectWorkers({ run, workers: [runner, browser, { id: "g", label: "Ghost", container: "ghost" }, { id: "b", label: "Broken", container: "broken" }] });
  assert.deepEqual(rows.map((row) => [row.id, row.state]), [["runner-base", "running"], ["runner-browser", "exited"], ["g", "missing"], ["b", "unknown"]]);
  assert.equal(rows[0].health, "healthy");
  assert.equal(rows[0].memoryLimitBytes, 3 * 1024 ** 3);
  assert.equal(rows[1].oomKilled, true);
  assert.equal(rows[1].cpuPercent, null);
  assert.deepEqual(issues, [{ source: "workers", code: "command_failed" }]);
  // Only read-only docker verbs run, container names come after "--", and only running containers are sampled.
  assert.ok(calls.every(([cmd, verb]) => cmd === "docker" && (verb === "inspect" || verb === "stats")));
  assert.ok(calls.every((call) => call[call.length - 2] === "--" || call.includes("--")));
  assert.deepEqual(calls.find((call) => call[1] === "stats").slice(-2), ["--", "runner-base"]);
});
test("a failed stats call keeps the worker state and marks coverage partial", async () => {
  const run = async (cmd, args) => { if (args[0] === "stats") throw new Error("boom"); return "running||2026-10-21T00:30:38Z|0|false"; };
  const { rows, issues } = await collectWorkers({ run, workers: [runner] });
  assert.equal(rows[0].state, "running");
  assert.equal(rows[0].cpuPercent, null);
  assert.deepEqual(issues, [{ source: "workers", code: "stats_failed" }]);
});
test("collect puts workers in the snapshot and reports their issues as partial coverage", async () => {
  const run = async (cmd, args) => cmd === "df" ? df : cmd === "docker" && args[0] === "system" ? docker : args[0] === "inspect" ? "running||2026-10-21T00:30:38Z|0|false" : (() => { throw new Error("no stats"); })();
  const value = await collect({ ...host, run, now: () => date, directories: [], workers: [runner] });
  assert.equal(value.workers[0].state, "running");
  assert.deepEqual(value.coverage.issues, [{ source: "workers", code: "stats_failed" }]);
  assert.equal((await collect({ ...host, run, now: () => date, directories: [] })).workers.length, 0);
});
const root = { id: "tessel", label: "Tessel", path: "/srv/projects/tessel/.paperclip/worktrees" };
const entry = (name, extra = {}) => ({ name, isDirectory: true, isSymlink: false, ...extra });
test("worktrees are measured one level deep, newest first, skipping symlinks, files and unsafe names", async () => {
  const duCalls = [];
  const run = async (cmd, args) => { duCalls.push([cmd, ...args]); return "4096\t" + args.at(-1) + "\n"; };
  const mtimes = { "JOU-1-old": "2026-10-01T00:00:00.000Z", "JOU-2-new": "2026-10-20T00:00:00.000Z" };
  const { rows, issues } = await collectWorktrees({
    run, roots: [root],
    listDir: async () => [entry("JOU-1-old"), entry("JOU-2-new"), entry("link", { isDirectory: false, isSymlink: true }), entry("notes.txt", { isDirectory: false }), entry("bad name"), entry("$(rm -rf)")],
    modifiedAt: async (path) => mtimes[path.split("/").at(-1)],
  });
  assert.deepEqual(rows.map((row) => row.name), ["JOU-2-new", "JOU-1-old"]);
  assert.deepEqual(rows[0], { rootId: "tessel", rootLabel: "Tessel", name: "JOU-2-new", modifiedAt: "2026-10-20T00:00:00.000Z", status: "ok", bytes: 4096 });
  assert.deepEqual(issues, [{ source: "worktrees", code: "invalid_name" }]);
  assert.deepEqual(duCalls[0], ["du", "-x", "-s", "-B1", "--", root.path + "/JOU-2-new"]);
  assert.equal(duCalls.length, 2);
});
test("worktree scanning isolates a missing root, a failed du, a long list and the deadline", async () => {
  const missing = await collectWorktrees({ run: async () => "", roots: [root], listDir: async () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); }, modifiedAt: async () => null });
  assert.deepEqual(missing, { rows: [], issues: [] });
  const denied = await collectWorktrees({ run: async () => "", roots: [root], listDir: async () => { throw Object.assign(new Error("private"), { code: "EACCES" }); }, modifiedAt: async () => null });
  assert.deepEqual(denied.issues, [{ source: "worktrees", code: "list_failed" }]);
  const many = Array.from({ length: 45 }, (_, i) => entry("w" + String(i).padStart(2, "0")));
  const failing = await collectWorktrees({
    run: async (cmd, args) => { if (args.at(-1).endsWith("w00")) throw new Error("private du failure"); return "10\t" + args.at(-1); },
    roots: [root], listDir: async () => many, modifiedAt: async (path) => "2026-10-20T00:00:" + path.slice(-2) + ".000Z".replace(/^.*$/, ""),
  });
  assert.equal(failing.rows.length, 40);
  assert.ok(failing.issues.some((item) => item.code === "truncated"));
  assert.ok(!JSON.stringify(failing).includes("private"));
  let elapsed = 0;
  const slow = await collectWorktrees({
    run: async (cmd, args, timeout) => { elapsed += timeout; return "10\t" + args.at(-1); },
    roots: [root], listDir: async () => [entry("a"), entry("b"), entry("c")], modifiedAt: async () => null, clock: () => elapsed, budgetMs: 100_000,
  });
  assert.deepEqual(slow.rows.map((row) => row.status), ["ok", "ok", "unavailable"]);
  assert.deepEqual(slow.issues, [{ source: "worktrees", code: "deadline_exceeded" }]);
});
test("collect adds worktrees to the snapshot, and the root list reuses the directory config rules with a smaller cap", async () => {
  const run = async (cmd) => cmd === "df" ? df : cmd === "docker" ? docker : "100\t/x\n";
  const value = await collect({ ...host, run, now: () => date, directories: [], worktreeRoots: [root], listDir: async () => [entry("JOU-9")], modifiedAt: async () => "2026-10-20T00:00:00.000Z" });
  assert.equal(value.worktrees[0].name, "JOU-9");
  assert.deepEqual((await collect({ ...host, run, now: () => date, directories: [] })).worktrees, []);
  assert.equal(parseDirectoryConfig(JSON.stringify([root]), 6).length, 1);
  assert.throws(() => parseDirectoryConfig(JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ id: "r" + i, label: "R", path: "/r" + i }))), 6), /1 to 6/);
});
const shared = { id: "pnpm-store", label: "pnpm store", path: "/srv/store", kind: "shared" };
const attributionResult = {
  items: [
    { key: "worktree:tessel/JOU-9", apparentBytes: 1000, exclusiveBytes: 200, sharedBytes: 800, entries: 5, unreadable: 0 },
    { key: "shared:pnpm-store", apparentBytes: 5000, exclusiveBytes: 4000, sharedBytes: 1000, entries: 9, unreadable: 0 },
  ],
  totals: { physicalBytes: 5200, apparentBytes: 6000, savedByHardlinksBytes: 800, sharedBetweenBytes: 800, externallyLinkedBytes: 0 },
};
const trees = { run: async (cmd) => cmd === "df" ? df : cmd === "docker" ? docker : "100\t/x\n", listDir: async () => [entry("JOU-9")], modifiedAt: async () => "2026-10-20T00:00:00.000Z" };
test("worktree config accepts worktree roots and shared trees, and rejects unknown kinds", () => {
  const rows = parseWorktreeConfig(JSON.stringify([root, { ...shared }, { ...root, id: "second", kind: "worktrees" }]));
  assert.deepEqual(rows.map((row) => [row.id, row.kind]), [["tessel", "worktrees"], ["pnpm-store", "shared"], ["second", "worktrees"]]);
  assert.throws(() => parseWorktreeConfig(JSON.stringify([{ ...root, kind: "other" }])), /kind/);
  assert.throws(() => parseWorktreeConfig(JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ id: "w" + i, label: "W", path: "/w" + i })))), /At most 6/);
  assert.throws(() => parseWorktreeConfig(JSON.stringify([{ ...shared, path: "/" }])));
});
test("collect attributes real size to each worktree and shared tree, with the walk's own totals", async () => {
  const calls = [];
  const value = await collect({ ...host, ...trees, now: () => date, directories: [], worktreeRoots: [root], sharedRoots: [shared],
    attribute: (input) => { calls.push(input); return attributionResult; } });
  assert.deepEqual(value.worktrees[0], { rootId: "tessel", rootLabel: "Tessel", name: "JOU-9", modifiedAt: "2026-10-20T00:00:00.000Z", status: "ok", bytes: 100, apparentBytes: 1000, exclusiveBytes: 200, sharedBytes: 800 });
  assert.deepEqual(value.sharedPools, [{ id: "pnpm-store", label: "pnpm store", apparentBytes: 5000, exclusiveBytes: 4000, sharedBytes: 1000 }]);
  assert.equal(value.spaceAttribution.physicalBytes, 5200);
  assert.equal(value.spaceAttribution.collectedAt, date.toISOString());
  assert.deepEqual(calls[0].items.map((item) => item.path), [root.path + "/JOU-9", "/srv/store"]);
  assert.ok(calls[0].excludePaths.includes(root.path));
  assert.ok(calls[0].excludePaths.includes("/srv/store"));
});
test("a failed or expired attribution keeps the du sizes and reports partial coverage", async () => {
  for (const [message, code] of [["attribution deadline exceeded", "deadline_exceeded"], ["boom private", "failed"]]) {
    const value = await collect({ ...host, ...trees, now: () => date, directories: [], worktreeRoots: [root], sharedRoots: [shared], attribute: () => { throw new Error(message); } });
    assert.equal(value.worktrees[0].bytes, 100);
    assert.equal(value.worktrees[0].exclusiveBytes, null);
    assert.equal(value.spaceAttribution, null);
    assert.deepEqual(value.coverage.issues, [{ source: "attribution", code }]);
    assert.ok(!JSON.stringify(value).includes("private"));
  }
});
test("a recent attribution of the same trees is reused instead of walking again", async () => {
  const first = await collect({ ...host, ...trees, now: () => date, directories: [], worktreeRoots: [root], sharedRoots: [shared], attribute: () => attributionResult });
  let walked = 0;
  const later = new Date(date.getTime() + 10 * 60_000);
  const second = await collect({ ...host, ...trees, now: () => later, directories: [], worktreeRoots: [root], sharedRoots: [shared], previous: first, attribute: () => { walked += 1; return attributionResult; } });
  assert.equal(walked, 0);
  assert.equal(second.worktrees[0].exclusiveBytes, 200);
  assert.equal(second.spaceAttribution.collectedAt, date.toISOString());
  const expired = await collect({ ...host, ...trees, now: () => new Date(date.getTime() + 2 * 3_600_000), directories: [], worktreeRoots: [root], sharedRoots: [shared], previous: first, attribute: () => { walked += 1; return attributionResult; } });
  assert.equal(walked, 1);
  assert.equal(expired.spaceAttribution.collectedAt, new Date(date.getTime() + 2 * 3_600_000).toISOString());
  const keys = ["worktree:tessel/JOU-9", "shared:pnpm-store"];
  assert.ok(reusableAttribution(first, keys, date.getTime(), 3_600_000));
  assert.equal(reusableAttribution(first, [...keys, "shared:other"], date.getTime(), 3_600_000), null);
  assert.equal(reusableAttribution(first, ["worktree:tessel/JOU-OTHER", "shared:pnpm-store"], date.getTime(), 3_600_000), null);
  assert.equal(reusableAttribution(null, keys, date.getTime(), 3_600_000), null);
  assert.equal(reusableAttribution(first, keys, date.getTime(), 0) === null, false);
});
