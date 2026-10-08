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
    { id: "private-files", label: "/etc/secret", status: "ok", bytes: 99999 },
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
  assert.equal(value.directories.length, 3);
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
