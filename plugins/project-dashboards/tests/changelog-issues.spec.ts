import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Issue } from "@paperclipai/plugin-sdk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { isChangelogEligible } from "../src/changelog-issues.js";
import type { ChangelogImportResult, ChangelogPage } from "../src/contracts.js";
import manifest, { DATABASE_NAMESPACE } from "../src/manifest.js";
import { API_ROUTES } from "../src/routes.js";
import {
  COMPANY,
  OTHER_COMPANY,
  OTHER_PROJECT,
  PROJECT,
  SECOND_PROJECT,
  createHarness,
  issue,
  type Harness,
  type IssueSeed,
} from "./harness.js";

const TABLE = `${DATABASE_NAMESPACE}.changelog_entries`;
const ISSUE = "11111111-0000-4000-8000-000000000001";
const SUB = "11111111-0000-4000-8000-000000000002";

let h: Harness;
beforeEach(async () => {
  if (h) {
    await h.db.close();
  }
  h = await createHarness();
});
afterAll(async () => {
  await h.db.close();
});

const rows = async (sql: string, params: unknown[] = []) => (await h.db.query<Record<string, unknown>>(sql, params)).rows;
const entries = async (params: Record<string, unknown> = {}, companyId = COMPANY) =>
  ((await h.data("changelog.list", { companyId, ...params })) as ChangelogPage).entries;
/** Put an issue in the fake host and deliver an issue.updated event for it. */
const complete = async (overrides: IssueSeed = {}, companyId = COMPANY) => {
  const seed = issue({ id: randomUUID(), ...overrides });
  h.issues.set(String(seed.id), seed);
  await h.emit("issue.updated", String(seed.id), companyId);
  return String(seed.id);
};
const importIssues = async (projectId: unknown = PROJECT) =>
  (await h.action("changelog.importIssues", { projectId })) as ChangelogImportResult;

describe("eligibility", () => {
  // The rule is pure; the issue is a loose host object, so the cast is confined to this helper.
  const eligible = (overrides: IssueSeed, mode: "top-level" | "all" = "top-level") =>
    isChangelogEligible({ ...issue(), ...overrides } as unknown as Issue, mode);

  it("accepts a completed, visible, manually created issue of a project", () => {
    expect(eligible({})).toBe(true);
    expect(eligible({ originKind: undefined })).toBe(true);
    expect(eligible({ originKind: null })).toBe(true);
    expect(eligible({ originKind: "manual" })).toBe(true);
  });

  it("rejects anything that is not done, has no project or is hidden", () => {
    for (const status of ["todo", "in_progress", "in_review", "blocked", "cancelled", "backlog"]) {
      expect(eligible({ status }), status).toBe(false);
    }
    expect(eligible({ projectId: null })).toBe(false);
    expect(eligible({ hiddenAt: "2026-10-01T00:00:00Z" })).toBe(false);
    expect(eligible({ hiddenAt: new Date() })).toBe(false);
  });

  it("only lets manual origins through: routines, watchdogs, recoveries and plugin issues are noise", () => {
    for (const originKind of ["routine_execution", "task_watchdog", "stranded_issue_recovery", "stale_active_run_evaluation", "harness_liveness_escalation", "chat_channel", "onboarding_first_task", "plugin:acme.sync", "something_new"]) {
      expect(eligible({ originKind }, "all"), originKind).toBe(false);
    }
  });

  it("skips sub-issues in top-level mode and accepts them in all mode", () => {
    expect(eligible({ parentId: ISSUE })).toBe(false);
    expect(eligible({ parentId: ISSUE }, "all")).toBe(true);
  });
});

describe("capture from issue.updated", () => {
  it("records a completed top-level issue with its identifier, completion time and a system actor", async () => {
    const id = await complete({ title: "  Ship the checkout  ", identifier: "ACME-7", completedAt: "2026-10-11T09:30:00.000Z" });
    const [entry] = await entries();
    expect(entry).toMatchObject({
      kind: "issue",
      title: "Ship the checkout",
      body: null,
      version: null,
      refs: ["ACME-7"],
      links: [],
      occurredAt: "2026-10-11T09:30:00.000Z",
      issueId: id,
      projectId: PROJECT,
      projectName: "Acme Web App",
      createdBy: { kind: "system", id: null, name: null },
    });
    expect(await entries()).toHaveLength(1);
    expect(h.activity).toHaveLength(0);
    expect(h.issueCalls.get).toEqual([id]);
  });

  it("does not duplicate on repeated events (done to done, re-delivery) or after edits to the issue", async () => {
    const id = await complete({});
    await h.emit("issue.updated", id);
    await h.emit("issue.updated", id);
    h.issues.set(id, issue({ id, title: "Renamed later" }));
    await h.emit("issue.updated", id);
    const stored = await entries();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.title).toBe("Ship checkout");
  });

  it("handles concurrent deliveries of the same event", async () => {
    const id = randomUUID();
    h.issues.set(id, issue({ id }));
    await Promise.all([1, 2, 3, 4].map(() => h.emit("issue.updated", id)));
    expect(await entries()).toHaveLength(1);
  });

  it("falls back to the event time when the issue has no completion time, and accepts Date objects", async () => {
    await complete({ completedAt: null, title: "No completion time" });
    await complete({ completedAt: new Date("2026-02-03T04:05:06.000Z"), title: "Real Date" });
    await complete({ completedAt: "garbage", title: "Garbage" });
    const byTitle = Object.fromEntries((await entries()).map((entry) => [entry.title, entry.occurredAt]));
    expect(byTitle["Real Date"]).toBe("2026-02-03T04:05:06.000Z");
    expect(Date.parse(byTitle["No completion time"] ?? "")).toBeGreaterThan(Date.now() - 60_000);
    expect(Date.parse(byTitle.Garbage ?? "")).toBeGreaterThan(Date.now() - 60_000);
  });

  it("ignores sub-issues in top-level mode and records them in all mode", async () => {
    await complete({ id: SUB, parentId: ISSUE, title: "Sub task" });
    expect(await entries()).toEqual([]);
    h.config[COMPANY] = { changelogFromIssues: "all" };
    await h.emit("issue.updated", SUB);
    expect((await entries()).map((entry) => entry.title)).toEqual(["Sub task"]);
  });

  it("does nothing when the company turned capture off, and settings are per company", async () => {
    h.config[COMPANY] = { changelogFromIssues: "off" };
    await complete({});
    expect(await entries()).toEqual([]);
    expect(h.issueCalls.get).toEqual([]);
    await complete({ companyId: OTHER_COMPANY, projectId: OTHER_PROJECT }, OTHER_COMPANY);
    expect(await entries({}, OTHER_COMPANY)).toHaveLength(1);
  });

  it("falls back to the default mode when the setting is invalid", async () => {
    h.config[COMPANY] = { changelogFromIssues: "sometimes" };
    await complete({ parentId: ISSUE });
    expect(await entries()).toEqual([]);
    await complete({});
    expect(await entries()).toHaveLength(1);
  });

  it("ignores issues that are not completed, have no project, are hidden or come from automation", async () => {
    for (const overrides of [
      { status: "in_progress" },
      { status: "cancelled" },
      { projectId: null },
      { hiddenAt: "2026-10-01T00:00:00Z" },
      { originKind: "routine_execution" },
      { originKind: "plugin:acme.sync" },
      { originKind: "task_watchdog" },
    ]) {
      await complete(overrides);
    }
    expect(await entries()).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("ignores events for issues the host cannot find or that belong to another company", async () => {
    await h.emit("issue.updated", randomUUID());
    const foreign = issue({ id: randomUUID(), companyId: OTHER_COMPANY, projectId: OTHER_PROJECT });
    h.issues.set(String(foreign.id), foreign);
    await h.emit("issue.updated", String(foreign.id), COMPANY);
    expect(await entries()).toEqual([]);
    expect(await entries({}, OTHER_COMPANY)).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("logs and swallows a host failure instead of throwing into the event loop", async () => {
    h.faults.issueGet = true;
    const id = randomUUID();
    h.issues.set(id, issue({ id }));
    await expect(h.emit("issue.updated", id)).resolves.toBeUndefined();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("changelog capture failed");
    expect(h.errors[0]).toContain("host unavailable");
    h.faults.issueGet = false;
    await h.emit("issue.updated", id);
    expect(await entries()).toHaveLength(1);
  });

  it("logs and swallows a database failure", async () => {
    await complete({ projectId: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
    expect(h.errors).toHaveLength(1);
    expect(await entries()).toEqual([]);
  });

  it("clips long titles without splitting characters and fills in a missing title", async () => {
    await complete({ title: `${"a".repeat(197)}😀😀😀` });
    await complete({ title: "b".repeat(500), identifier: "ACME-2" });
    await complete({ title: "   ", identifier: "ACME-3" });
    await complete({ title: "", identifier: null });
    const titles = (await entries()).map((entry) => entry.title);
    expect(titles).toHaveLength(4);
    for (const title of titles) {
      expect(title.length).toBeLessThanOrEqual(200);
      // encodeURIComponent throws on a lone surrogate, i.e. a split character.
      expect(() => encodeURIComponent(title)).not.toThrow();
    }
    expect(titles).toContain(`${"a".repeat(197)}😀…`);
    expect(titles).toContain(`${"b".repeat(199)}…`);
    expect(titles).toContain("ACME-3");
    expect(titles).toContain("Untitled issue");
  });

  it("omits the ref when the issue has no identifier", async () => {
    await complete({ identifier: null });
    expect((await entries())[0]?.refs).toEqual([]);
  });
});

describe("import completed issues", () => {
  const seedProject = () => {
    for (const overrides of [
      { id: "a0000000-0000-4000-8000-000000000001", title: "Top 1", completedAt: "2026-10-01T10:00:00Z" },
      { id: "a0000000-0000-4000-8000-000000000002", title: "Top 2", completedAt: "2026-10-02T10:00:00Z" },
      { id: "a0000000-0000-4000-8000-000000000003", title: "Top 3", completedAt: "2026-10-03T10:00:00Z" },
      { id: "a0000000-0000-4000-8000-000000000004", title: "Sub", parentId: ISSUE },
      { id: "a0000000-0000-4000-8000-000000000005", title: "Routine", originKind: "routine_execution" },
      { id: "a0000000-0000-4000-8000-000000000006", title: "Still open", status: "in_progress" },
      { id: "a0000000-0000-4000-8000-000000000007", title: "Other project", projectId: SECOND_PROJECT },
    ]) {
      h.issues.set(String(overrides.id), issue(overrides));
    }
  };

  it("imports eligible issues, counts what it saw and skipped, and asks the host without an offset", async () => {
    seedProject();
    expect(await importIssues()).toEqual({ scanned: 5, imported: 3, skipped: 2, truncated: false });
    expect((await entries({ projectId: PROJECT })).map((entry) => entry.title)).toEqual(["Top 3", "Top 2", "Top 1"]);
    expect(h.issueCalls.list).toEqual([{ companyId: COMPANY, projectId: PROJECT, status: "done", limit: 1000 }]);
    expect(h.issueCalls.list[0]).not.toHaveProperty("offset");
    expect(h.activity.at(-1)).toMatchObject({
      message: 'Imported 3 completed issue(s) into the changelog of project "Acme Web App" (5 scanned)',
      entityType: "plugin_changelog",
      entityId: PROJECT,
      metadata: { scanned: 5, imported: 3, skipped: 2, truncated: false, actor: "user" },
    });
  });

  it("is idempotent and does not duplicate what the live capture already recorded", async () => {
    seedProject();
    await h.emit("issue.updated", "a0000000-0000-4000-8000-000000000001");
    expect(await importIssues()).toEqual({ scanned: 5, imported: 2, skipped: 3, truncated: false });
    expect(await importIssues()).toEqual({ scanned: 5, imported: 0, skipped: 5, truncated: false });
    expect(await entries()).toHaveLength(3);
    expect(h.activity.filter((entry) => entry.entityType === "plugin_changelog")).toHaveLength(2);
  });

  it("follows the company mode: all brings sub-issues, off still imports top-level ones", async () => {
    seedProject();
    h.config[COMPANY] = { changelogFromIssues: "all" };
    expect((await importIssues()).imported).toBe(4);
    await h.db.exec(`DELETE FROM ${TABLE}`);
    h.config[COMPANY] = { changelogFromIssues: "off" };
    expect(await importIssues()).toMatchObject({ imported: 3, skipped: 2 });
  });

  it("never brings back an automatic entry the board deleted", async () => {
    seedProject();
    await importIssues();
    const [victim] = await entries();
    await h.action("changelog.delete", { id: victim?.id });
    expect(await importIssues()).toMatchObject({ imported: 0 });
    expect(await entries()).toHaveLength(2);
    expect(await rows(`SELECT 1 FROM ${TABLE} WHERE deleted_at IS NOT NULL`)).toHaveLength(1);
    // The live capture respects the deletion too.
    await h.emit("issue.updated", "a0000000-0000-4000-8000-000000000001");
    await h.emit("issue.updated", "a0000000-0000-4000-8000-000000000002");
    await h.emit("issue.updated", "a0000000-0000-4000-8000-000000000003");
    expect(await entries()).toHaveLength(2);
  });

  it("inserts in batches of at most 100 rows and flags a full page as truncated", { timeout: 60_000 }, async () => {
    for (let n = 0; n < 1000; n += 1) {
      const id = randomUUID();
      h.issues.set(id, issue({ id, title: `Bulk ${n}`, identifier: `ACME-${n + 10}` }));
    }
    const result = await importIssues();
    expect(result).toEqual({ scanned: 1000, imported: 1000, skipped: 0, truncated: true });
    const inserts = h.executed.filter((statement) => statement.sql.includes("INSERT INTO"));
    expect(inserts).toHaveLength(10);
    expect(inserts.every((statement) => statement.params.length === 100 * 13)).toBe(true);
    expect(await rows(`SELECT 1 FROM ${TABLE}`)).toHaveLength(1000);
  });

  it("splits a smaller import into 100, 100 and 50", { timeout: 30_000 }, async () => {
    for (let n = 0; n < 250; n += 1) {
      const id = randomUUID();
      h.issues.set(id, issue({ id, title: `Bulk ${n}` }));
    }
    expect((await importIssues()).truncated).toBe(false);
    expect(h.executed.filter((statement) => statement.sql.includes("INSERT INTO")).map((statement) => statement.params.length / 13)).toEqual([100, 100, 50]);
  });

  it("validates the project and keeps companies apart", async () => {
    await expect(h.action("changelog.importIssues", { projectId: OTHER_PROJECT })).rejects.toThrow("Project not found in this company");
    await expect(h.action("changelog.importIssues", { projectId: "nope" })).rejects.toThrow("projectId must be a UUID");
    await expect(h.action("changelog.importIssues", {})).rejects.toThrow("projectId must be a UUID");
    expect(h.issueCalls.list).toEqual([]);
    h.issues.set(ISSUE, issue({ id: ISSUE, companyId: OTHER_COMPANY, projectId: OTHER_PROJECT }));
    expect(await importIssues()).toEqual({ scanned: 0, imported: 0, skipped: 0, truncated: false });
  });

  it("records the acting board user and reports an empty project", async () => {
    expect(await importIssues(SECOND_PROJECT)).toEqual({ scanned: 0, imported: 0, skipped: 0, truncated: false });
    expect(h.activity.at(-1)?.message).toBe('Imported 0 completed issue(s) into the changelog of project "Internal Tools" (0 scanned)');
  });
});

describe("manifest", () => {
  it("declares the new capabilities, tools, routes and ordered tabs", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(manifest.version).toBe("0.4.0");
    expect(pkg.version).toBe(manifest.version);
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["events.subscribe", "issues.read"]));
    expect(manifest.capabilities).not.toEqual(expect.arrayContaining(["issues.create", "issues.update"]));
    expect(manifest.description).toContain("changelog");
    const tabs = (manifest.ui?.slots ?? []).filter((slot) => slot.type === "detailTab");
    expect(tabs.map((tab) => tab.displayName)).toEqual(["Dashboard", "Changelog"]);
    const [first, second] = tabs;
    expect(first?.order).toBeTypeOf("number");
    expect(second?.order).toBeGreaterThan(first?.order ?? Number.POSITIVE_INFINITY);
    expect(manifest.tools?.filter((tool) => tool.name.endsWith("changelog") || tool.name.endsWith("changelog_entry")).map((tool) => tool.name)).toEqual([
      "add_changelog_entry",
      "list_changelog",
      "update_changelog_entry",
    ]);
  });

  it("keeps changelog-import ahead of changelog-update, which would otherwise capture it", () => {
    // The host dispatches to the first route whose path matches.
    const first = (method: string, path: string) =>
      API_ROUTES.find((route) => route.method === method && new RegExp(`^${route.path.replace(/:[A-Za-z]+/g, "[^/]+")}$`).test(path))?.routeKey;
    expect(first("POST", "/changelog/import")).toBe("changelog-import");
    expect(first("POST", "/changelog/99999999-9999-4999-8999-999999999999")).toBe("changelog-update");
    expect(first("POST", "/changelog")).toBe("changelog-add");
    expect(first("GET", "/changelog")).toBe("changelog-list");
  });
});
