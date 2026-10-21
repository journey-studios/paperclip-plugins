import test from "node:test";
import assert from "node:assert/strict";
import { getHotspots, getOverview, parseLimit, sanitizeSnapshot } from "../src/service.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompany = "22222222-2222-4222-8222-222222222222";
const generatedAt = "2026-10-07T22:00:00.000Z";
const now = Date.parse("2026-10-07T22:10:00.000Z");
const raw = {
  schemaVersion: 1,
  generatedAt,
  filesystem: { mount: "/", totalBytes: 10000, usedBytes: 8000, availableBytes: 2000, usedPercent: 80, secret: "never-return" },
  directories: [
    { id: "repos", label: "Repositórios Git", status: "ok", bytes: 500, path: "/confidential/path" },
    { id: "containerd", label: "Containerd", status: "ok", bytes: 6000 },
    { id: "private-files", label: "/etc/secret", status: "ok", bytes: 90 },
    { id: "../shadow", label: "Bad id", status: "ok", bytes: 99999 },
    { id: "docker-volumes", label: "Docker volumes", status: "unavailable", bytes: null },
  ],
  docker: [
    { id: "images", label: "Imagens", count: 12, active: 4, sizeBytes: 7000, reclaimableBytes: 10, approximate: true, hidden: "secret" },
    { id: "other", label: "secret", count: 1, active: 0, sizeBytes: 10, reclaimableBytes: 10 },
  ],
  history: [{ at: generatedAt, usedBytes: 8000, availableBytes: 2000 }],
  coverage: { partial: true, issues: [{ source: "docker", code: "command_failed", raw: "private" }] },
  alertPolicy: { warnFreeBytes: 3000, criticalFreeBytes: 1000 },
  private: "do-not-leak",
};
function ctxFor(snapshot = raw, status = { configured: true, healthy: true, access: "read" }) {
  const calls = [];
  return {
    calls,
    localFolders: {
      async status(id, folder) { calls.push(["status", id, folder]); return status; },
      async readText(id, folder, file) { calls.push(["read", id, folder, file]); return JSON.stringify(snapshot); },
    },
  };
}
test("read-only snapshot strips unknown fields, secret paths, and reports opt-in alerts", async () => {
  const ctx = ctxFor();
  const value = await getOverview(ctx, companyId, now);
  assert.equal(value.status, "ready");
  assert.equal(value.filesystem.usedBytes, 8000);
  assert.equal(value.filesystem.secret, undefined);
  // Ids are operator-defined, so only their shape is checked; a path-like label is replaced by the id.
  assert.deepEqual(value.directories.map((row) => row.id), ["repos", "containerd", "private-files", "docker-volumes"]);
  assert.equal(value.directories.find((row) => row.id === "private-files").label, "private-files");
  assert.ok(!JSON.stringify(value).includes("do-not-leak"));
  assert.ok(!JSON.stringify(value).includes("/confidential/path"));
  assert.ok(!JSON.stringify(value).includes("/etc/secret"));
  assert.equal(value.docker.length, 1);
  assert.equal(value.alerts[0].level, "warning");
  assert.equal(value.coverage.partial, true);
  assert.deepEqual(ctx.calls, [
    ["status", companyId, "storage-snapshot"],
    ["read", companyId, "storage-snapshot", "snapshot.json"],
  ]);
});
const cpu = { cores: 4, usagePercent: 25.54, load1: 0.5, load5: 0.4, load15: 0.3, model: "never-return" };
const memory = { totalBytes: 8000, availableBytes: 2000, usedBytes: 6000, usedPercent: 75, swapTotalBytes: 1000, swapUsedBytes: 250, extra: "never-return" };
test("schema 2 exposes cpu, memory and uptime and strips unknown fields", () => {
  const value = sanitizeSnapshot({ ...raw, schemaVersion: 2, cpu, memory, uptimeSeconds: 3600,
    history: [{ at: generatedAt, usedBytes: 8000, availableBytes: 2000, cpuPercent: 25.5, memoryUsedBytes: 6000 }] }, now);
  assert.deepEqual(value.cpu, { cores: 4, usagePercent: 25.5, load1: 0.5, load5: 0.4, load15: 0.3 });
  assert.deepEqual(value.memory, { totalBytes: 8000, availableBytes: 2000, usedBytes: 6000, usedPercent: 75, swapTotalBytes: 1000, swapUsedBytes: 250 });
  assert.equal(value.uptimeSeconds, 3600);
  assert.equal(value.history[0].cpuPercent, 25.5);
  assert.equal(value.history[0].memoryUsedBytes, 6000);
  assert.ok(!JSON.stringify(value).includes("never-return"));
});
test("a malformed optional history metric is omitted without losing the disk sample", () => {
  const value = sanitizeSnapshot({ ...raw, schemaVersion: 2, history: [
    { at: generatedAt, usedBytes: 8000, availableBytes: 2000, cpuPercent: 140, memoryUsedBytes: "lots" },
  ] }, now);
  assert.equal(value.history.length, 1);
  assert.equal(value.history[0].usedBytes, 8000);
  assert.equal("cpuPercent" in value.history[0], false);
  assert.equal("memoryUsedBytes" in value.history[0], false);
});
test("schema 1 snapshots and bad cpu or memory degrade to null without invalidating disk metrics", () => {
  const legacy = sanitizeSnapshot(raw, now);
  assert.equal(legacy.cpu, null);
  assert.equal(legacy.memory, null);
  assert.equal(legacy.uptimeSeconds, null);
  const bad = sanitizeSnapshot({ ...raw, schemaVersion: 2, cpu: { ...cpu, usagePercent: 140 }, memory: { ...memory, usedBytes: 9000 }, uptimeSeconds: -5 }, now);
  assert.equal(bad.status, "ready");
  assert.equal(bad.cpu, null);
  assert.equal(bad.memory, null);
  assert.equal(bad.uptimeSeconds, null);
  assert.equal(bad.filesystem.usedBytes, 8000);
});
test("unconfigured folder never reads a file or claims live data", async () => {
  const ctx = ctxFor(raw, { configured: false, healthy: false, access: "read" });
  const data = await getOverview(ctx, companyId, now);
  assert.equal(data.status, "unconfigured");
  assert.equal(data.filesystem, null);
  assert.equal(ctx.calls.length, 1);
});
test("a writable or unhealthy folder is rejected", async () => {
  for (const status of [{ configured: true, healthy: true, access: "readWrite" }, { configured: true, healthy: false, access: "read" }]) {
    const ctx = ctxFor(raw, status);
    assert.equal((await getOverview(ctx, companyId, now)).status, "unavailable");
    assert.equal(ctx.calls.length, 1);
  }
});
test("invalid or out-of-date snapshot is explicit and cannot invent metrics", async () => {
  const stale = await getOverview(ctxFor(raw), companyId, now + 40 * 60 * 1000);
  assert.equal(stale.status, "stale");
  assert.equal(stale.filesystem.totalBytes, 10000);
  const invalid = await getOverview(ctxFor({ ...raw, filesystem: { ...raw.filesystem, totalBytes: -1 } }), companyId, now);
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.filesystem, null);
  assert.throws(() => sanitizeSnapshot({ ...raw, generatedAt: "2026-10-08T00:00:00.000Z" }, now), /future/);
  assert.throws(() => sanitizeSnapshot({ ...raw, schemaVersion: 7 }, now), /schema/);
});
test("company isolation and validated parameters", async () => {
  const ctx = ctxFor(raw);
  await assert.rejects(getOverview(ctx, "invalid-company", now), /company/);
  assert.equal(ctx.calls.length, 0);
  const x = await getHotspots(ctx, otherCompany, 1, now);
  assert.equal(x.companyId, otherCompany);
  assert.deepEqual(x.directories.map((r) => r.id), ["containerd"]);
  assert.deepEqual(ctx.calls[0], ["status", otherCompany, "storage-snapshot"]);
  assert.equal(parseLimit(undefined), 10);
  assert.equal(parseLimit("20"), 20);
  assert.throws(() => parseLimit(21), /limit/);
  assert.throws(() => parseLimit(-1), /limit/);
});
test("invalid JSON and oversized snapshots fail closed", async () => {
  const ctx = ctxFor();
  ctx.localFolders.readText = async () => "{broken";
  assert.equal((await getOverview(ctx, companyId, now)).status, "invalid");
  ctx.localFolders.readText = async () => " ".repeat(1024 * 1024 + 1);
  assert.equal((await getOverview(ctx, companyId, now)).status, "invalid");
});
test("invalid optional thresholds do not become arbitrary automatic warnings", () => {
  const noPolicy = sanitizeSnapshot({ ...raw, alertPolicy: undefined }, now);
  assert.deepEqual(noPolicy.alerts, []);
});
test("workers keep only listed shapes and degrade usage fields one by one", () => {
  const value = sanitizeSnapshot({ ...raw, schemaVersion: 2, workers: [
    { id: "runner-base", label: "Runner base", state: "running", health: "healthy", startedAt: "2026-10-21T00:30:38.087Z", restartCount: 2, oomKilled: false,
      cpuPercent: 152.44, memoryUsedBytes: 100, memoryLimitBytes: 300, memoryPercent: 33.3, pids: 4, hidden: "never-return" },
    { id: "runner-browser", label: "/srv/secret", state: "exited", health: "sick", startedAt: "2026-10-21T00:00:00.000Z", cpuPercent: 999999, memoryUsedBytes: -1, pids: 1.5 },
    { id: "../escape", label: "Bad", state: "running" },
    { id: "weird", label: "Weird", state: "levitating" },
    "not-an-object",
  ] }, now);
  assert.deepEqual(value.workers.map((row) => row.id), ["runner-base", "runner-browser"]);
  assert.deepEqual(value.workers[0], { id: "runner-base", label: "Runner base", state: "running", health: "healthy", startedAt: "2026-10-21T00:30:38.087Z", restartCount: 2, oomKilled: false,
    cpuPercent: 152.4, memoryUsedBytes: 100, memoryLimitBytes: 300, memoryPercent: 33.3, pids: 4 });
  assert.equal(value.workers[1].label, "runner-browser");
  assert.equal(value.workers[1].health, null);
  assert.equal(value.workers[1].startedAt, null);
  assert.equal(value.workers[1].cpuPercent, null);
  assert.equal(value.workers[1].memoryUsedBytes, null);
  assert.equal(value.workers[1].pids, null);
  assert.ok(!JSON.stringify(value).includes("never-return"));
  assert.deepEqual(sanitizeSnapshot(raw, now).workers, []);
});
test("worktrees keep only safe names and roots, and are sorted by size", () => {
  const value = sanitizeSnapshot({ ...raw, schemaVersion: 2, worktrees: [
    { rootId: "tessel", rootLabel: "Tessel", name: "JOU-1-small", status: "ok", bytes: 100, modifiedAt: "2026-10-20T00:00:00.000Z", path: "/never-return" },
    { rootId: "tessel", rootLabel: "/srv/secret", name: "JOU-2-big", status: "ok", bytes: 900, modifiedAt: "garbage" },
    { rootId: "tessel", rootLabel: "Tessel", name: "JOU-3-failed", status: "boom", bytes: 5 },
    { rootId: "tessel", rootLabel: "Tessel", name: "bad name", status: "ok", bytes: 1 },
    { rootId: "tessel", rootLabel: "Tessel", name: "../etc", status: "ok", bytes: 1 },
    { rootId: "Bad Root", rootLabel: "X", name: "ok-name", status: "ok", bytes: 1 },
    { rootId: "tessel", rootLabel: "Tessel", name: "negative", status: "ok", bytes: -3 },
  ] }, now);
  assert.deepEqual(value.worktrees.map((row) => [row.name, row.bytes, row.status]), [["JOU-2-big", 900, "ok"], ["JOU-1-small", 100, "ok"], ["JOU-3-failed", null, "unavailable"]]);
  assert.equal(value.worktrees[0].rootLabel, "tessel");
  assert.equal(value.worktrees[0].modifiedAt, null);
  assert.ok(!JSON.stringify(value).includes("never-return"));
  assert.deepEqual(sanitizeSnapshot(raw, now).worktrees, []);
});
test("real size fields are kept only when consistent, and the summary and pools are validated", () => {
  const value = sanitizeSnapshot({ ...raw, schemaVersion: 2,
    worktrees: [
      { rootId: "tessel", rootLabel: "Tessel", name: "big-shared", status: "ok", bytes: 900, apparentBytes: 900, exclusiveBytes: 100, sharedBytes: 12345, modifiedAt: generatedAt },
      { rootId: "tessel", rootLabel: "Tessel", name: "mostly-own", status: "ok", bytes: 500, apparentBytes: 500, exclusiveBytes: 450, modifiedAt: generatedAt },
      { rootId: "tessel", rootLabel: "Tessel", name: "inconsistent", status: "ok", bytes: 800, apparentBytes: 50, exclusiveBytes: 700, modifiedAt: generatedAt },
      { rootId: "tessel", rootLabel: "Tessel", name: "legacy", status: "ok", bytes: 300, modifiedAt: generatedAt },
    ],
    sharedPools: [{ id: "pnpm-store", label: "pnpm store", apparentBytes: 6000, exclusiveBytes: 5000, secret: "never-return" }, { id: "Bad Id", label: "x", apparentBytes: 1, exclusiveBytes: 1 }],
    spaceAttribution: { collectedAt: generatedAt, durationMs: 4200, physicalBytes: 7000, apparentBytes: 9000, savedByHardlinksBytes: 2000, sharedBetweenBytes: 1500, externallyLinkedBytes: 0, extra: "never-return" },
  }, now);
  assert.deepEqual(value.worktrees.map((row) => row.name), ["mostly-own", "big-shared", "inconsistent", "legacy"].sort((a, b) => {
    const size = { "mostly-own": 450, "big-shared": 100, inconsistent: 800, legacy: 300 }; return size[b] - size[a];
  }));
  const by = Object.fromEntries(value.worktrees.map((row) => [row.name, row]));
  assert.deepEqual([by["big-shared"].apparentBytes, by["big-shared"].exclusiveBytes, by["big-shared"].sharedBytes], [900, 100, 800]);
  assert.deepEqual([by.inconsistent.apparentBytes, by.inconsistent.exclusiveBytes, by.inconsistent.sharedBytes], [null, null, null]);
  assert.equal(by.legacy.exclusiveBytes, null);
  assert.deepEqual(value.sharedPools, [{ id: "pnpm-store", label: "pnpm store", apparentBytes: 6000, exclusiveBytes: 5000, sharedBytes: 1000 }]);
  assert.deepEqual(value.spaceAttribution, { collectedAt: generatedAt, durationMs: 4200, physicalBytes: 7000, apparentBytes: 9000, savedByHardlinksBytes: 2000, sharedBetweenBytes: 1500, externallyLinkedBytes: 0 });
  assert.ok(!JSON.stringify(value).includes("never-return"));
  assert.equal(sanitizeSnapshot({ ...raw, spaceAttribution: { collectedAt: generatedAt, physicalBytes: 10, apparentBytes: 5, savedByHardlinksBytes: 0, sharedBetweenBytes: 0, externallyLinkedBytes: 0 } }, now).spaceAttribution, null);
});
