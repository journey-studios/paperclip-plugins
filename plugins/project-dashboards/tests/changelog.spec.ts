import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ChangelogEntry, ChangelogPage } from "../src/contracts.js";
import { DATABASE_NAMESPACE } from "../src/manifest.js";
import {
  AGENT,
  ARCHIVED_PROJECT,
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
const ENTRY_ID = "99999999-9999-4999-8999-999999999999";

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
const add = (params: Record<string, unknown>, run = {}) => h.tool("add_changelog_entry", params, run);
const update = (params: Record<string, unknown>, run = {}) => h.tool("update_changelog_entry", params, run);
const page = async (params: Record<string, unknown> = {}, companyId = COMPANY) =>
  (await h.data("changelog.list", { companyId, ...params })) as ChangelogPage;
const entryOf = (result: { data?: unknown }) => result.data as ChangelogEntry;
const completeIssue = async (id: string, overrides: IssueSeed = {}) => {
  h.issues.set(id, issue({ id, ...overrides }));
  await h.emit("issue.updated", id);
};

describe("migration 002", () => {
  const read = (name: string) => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");

  it("applies after 001 on a database that already holds dashboards, leaving them intact", async () => {
    const db = new PGlite();
    try {
      await db.exec(
        `CREATE TABLE public.companies (id uuid PRIMARY KEY);
         CREATE TABLE public.projects (id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL);
         CREATE SCHEMA ${DATABASE_NAMESPACE};`,
      );
      await db.exec(await read("001_project_dashboards.sql"));
      await db.exec(`INSERT INTO public.companies VALUES ('${COMPANY}')`);
      await db.exec(
        `INSERT INTO ${DATABASE_NAMESPACE}.dashboards(id, company_id, slug, title, spec, revision, updated_by_kind)
         VALUES ('${ENTRY_ID}', '${COMPANY}', 'keep', 'Keep', '{}'::jsonb, 1, 'system')`,
      );
      await db.exec(await read("002_project_changelog.sql"));
      await db.exec(await read("002_project_changelog.sql"));
      expect((await db.query(`SELECT slug FROM ${DATABASE_NAMESPACE}.dashboards`)).rows).toEqual([{ slug: "keep" }]);
      expect((await db.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows).toEqual([{ n: 0 }]);
    } finally {
      await db.close();
    }
  });

  it("only uses SQL the host accepts in migrations: no drops, deletes, functions or triggers, everything qualified", async () => {
    const sql = (await read("002_project_changelog.sql")).toLowerCase();
    expect(sql).not.toMatch(/\bdrop\b|\bdelete\s+from\b|\bcreate\s+(or\s+replace\s+)?function\b|\bcreate\s+trigger\b|\bgrant\b/);
    const named = [...sql.matchAll(/create table if not exists\s+(\S+)/g), ...sql.matchAll(/references\s+(\S+)/g), ...sql.matchAll(/\bon\s+(?!delete\b)(\S+)/g)];
    expect(named.length).toBeGreaterThanOrEqual(6);
    for (const [, name] of named) {
      expect(name, name).toMatch(/^(plugin_project_dashboards_54173784c0|public)\./);
    }
  });

  const insert = (overrides: Record<string, string>) => {
    const row = {
      id: ENTRY_ID,
      kind: "'note'",
      title: "'T'",
      refs: "'[]'::jsonb",
      links: "'[]'::jsonb",
      issue_id: "NULL",
      ...overrides,
    };
    return h.db.query(
      `INSERT INTO ${TABLE} (id, company_id, project_id, kind, title, refs, links, occurred_at, issue_id, created_by_kind, updated_by_kind)
       VALUES ('${row.id}', '${COMPANY}', '${PROJECT}', ${row.kind}, ${row.title}, ${row.refs}, ${row.links}, now(), ${row.issue_id}, 'system', 'system')`,
    );
  };

  it("enforces that exactly the issue kind carries an issue id", async () => {
    await expect(insert({ kind: "'issue'" })).rejects.toThrow();
    await expect(insert({ kind: "'note'", issue_id: `'${ENTRY_ID}'` })).rejects.toThrow();
    await insert({ kind: "'issue'", issue_id: `'${ENTRY_ID}'` });
    await insert({ id: "88888888-8888-4888-8888-888888888888", kind: "'fix'" });
  });

  it("checks kind, title, body, version and the jsonb shapes in the database too", async () => {
    await expect(insert({ kind: "'bogus'" })).rejects.toThrow();
    await expect(insert({ title: "'   '" })).rejects.toThrow();
    await expect(insert({ title: `'${"x".repeat(201)}'` })).rejects.toThrow();
    await expect(insert({ refs: "'{}'::jsonb" })).rejects.toThrow();
    await expect(insert({ links: "'\"x\"'::jsonb" })).rejects.toThrow();
    await insert({});
    await expect(h.db.query(`UPDATE ${TABLE} SET version = ''`)).rejects.toThrow();
    await expect(h.db.query(`UPDATE ${TABLE} SET body = repeat('x', 20001)`)).rejects.toThrow();
  });

  it("allows one entry per issue and company, and removes entries with their project", async () => {
    await insert({ kind: "'issue'", issue_id: `'${ENTRY_ID}'` });
    await expect(insert({ id: "88888888-8888-4888-8888-888888888888", kind: "'issue'", issue_id: `'${ENTRY_ID}'` })).rejects.toThrow();
    await h.db.exec(`DELETE FROM public.projects WHERE id = '${PROJECT}'`);
    expect(await rows(`SELECT 1 FROM ${TABLE}`)).toHaveLength(0);
  });
});

describe("add_changelog_entry", () => {
  it("records a curated entry in the run's project and attributes it to the agent", async () => {
    const result = await add({ kind: "release", title: "  Checkout v2 shipped ", body: "Faster **payments**", version: "v2.0.0", refs: ["ACME-12", "abc1234"], links: [{ label: "PR", url: "https://example.com/pr/7" }] });
    expect(result.error).toBeUndefined();
    expect(result.content).toBe('Added release entry "Checkout v2 shipped" to the changelog of project Acme Web App.');
    const entry = entryOf(result);
    expect(entry).toMatchObject({
      projectId: PROJECT,
      projectName: "Acme Web App",
      kind: "release",
      title: "Checkout v2 shipped",
      body: "Faster **payments**",
      version: "v2.0.0",
      refs: ["ACME-12", "abc1234"],
      links: [{ label: "PR", url: "https://example.com/pr/7" }],
      issueId: null,
      createdBy: { kind: "agent", id: AGENT, name: "Tracker" },
      updatedBy: { kind: "agent", id: AGENT, name: "Tracker" },
    });
    expect(Date.parse(entry.occurredAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(h.activity.at(-1)).toMatchObject({ message: 'Added release changelog entry "Checkout v2 shipped" to project "Acme Web App"', entityType: "plugin_changelog_entry" });
    expect(await rows(`SELECT 1 FROM ${TABLE}`)).toHaveLength(1);
  });

  it("uses an explicit project and occurredAt, normalizing dates and URLs", async () => {
    const result = await add({ projectId: SECOND_PROJECT, kind: "decision", title: "Use Postgres", occurredAt: "2026-03-04", links: [{ label: " Doc ", url: " https://example.com " }] });
    expect(entryOf(result)).toMatchObject({
      projectId: SECOND_PROJECT,
      projectName: "Internal Tools",
      occurredAt: "2026-03-04T00:00:00.000Z",
      links: [{ label: "Doc", url: "https://example.com/" }],
    });
  });

  it("needs a project: the run's, or an explicit one", async () => {
    const result = await add({ kind: "note", title: "x" }, { projectId: "" });
    expect(result.error).toBe("projectId: is required because this run has no current project");
    expect((await add({ kind: "note", title: "x", projectId: "nope" })).error).toBe("projectId must be a UUID");
    expect((await add({ kind: "note", title: "x", projectId: SECOND_PROJECT }, { projectId: "" })).error).toBeUndefined();
    expect(await rows(`SELECT 1 FROM ${TABLE}`)).toHaveLength(1);
  });

  it("records history for an archived project too, unlike new dashboards", async () => {
    const result = await add({ projectId: ARCHIVED_PROJECT, kind: "decision", title: "Archive the project" });
    expect(result.error).toBeUndefined();
    expect(entryOf(result)).toMatchObject({ projectId: ARCHIVED_PROJECT, projectName: "Old Project" });
  });

  it("rejects projects of another company and never takes the company from parameters", async () => {
    expect((await add({ kind: "note", title: "x", projectId: OTHER_PROJECT })).error).toBe("Project not found in this company");
    const spoof = await add({ kind: "note", title: "x", companyId: OTHER_COMPANY });
    expect(spoof.error).toContain("companyId: unexpected field");
    expect(await rows(`SELECT 1 FROM ${TABLE}`)).toHaveLength(0);
    const other = await add({ kind: "note", title: "theirs" }, { companyId: OTHER_COMPANY, projectId: OTHER_PROJECT });
    expect(other.error).toBeUndefined();
    expect(await rows(`SELECT company_id FROM ${TABLE}`)).toEqual([{ company_id: OTHER_COMPANY }]);
  });

  it("reports every problem with its field path", async () => {
    const result = await add({
      kind: "party",
      title: "",
      body: "x".repeat(20_001),
      version: "v".repeat(65),
      refs: Array.from({ length: 21 }, (_, i) => `R-${i}`),
      links: "nope",
      occurredAt: "yesterday",
      extra: true,
    });
    expect(result.error).toContain("Invalid changelog entry:");
    for (const path of ["kind: must be one of milestone, release, feature, fix, improvement, decision, incident, note", "title: must be a string of 1-200", "body: must be a string of 1-20000", "version: must be a string of 1-64", "refs: must be an array of at most 20", "links: must be an array of at most 20", "occurredAt: must be an ISO 8601", "extra: unexpected field"]) {
      expect(result.error, path).toContain(path);
    }
    expect(await rows(`SELECT 1 FROM ${TABLE}`)).toHaveLength(0);
  });

  it("requires kind and title", async () => {
    expect((await add({})).error).toContain("kind: is required");
    expect((await add({})).error).toContain("title: is required");
    expect((await add({ kind: null, title: null })).error).toContain("kind: must be one of");
  });

  it("never accepts the issue kind from outside", async () => {
    const result = await add({ kind: "issue", title: "Fake" });
    expect(result.error).toContain('kind: "issue" entries are created automatically when an issue is completed');
    expect(await rows(`SELECT 1 FROM ${TABLE}`)).toHaveLength(0);
  });

  it("only links to absolute http and https URLs", async () => {
    for (const url of ["javascript:alert(1)", "ftp://example.com/x", "data:text/html,hi", "/relative", "example.com", "", `https://example.com/${"a".repeat(2000)}`]) {
      const result = await add({ kind: "note", title: "x", links: [{ label: "L", url }] });
      expect(result.error, url).toContain("links[0].url: must be an absolute http or https URL of at most 2000 characters");
    }
    const bad = await add({ kind: "note", title: "x", links: [{ label: "", url: "https://a.test", extra: 1 }, "str"] });
    expect(bad.error).toContain("links[0].label: must be a string of 1-100");
    expect(bad.error).toContain("links[0].extra: unexpected field (allowed: label, url)");
    expect(bad.error).toContain("links[1]: must be an object with label and url");
    expect((await add({ kind: "note", title: "x", links: Array.from({ length: 21 }, () => ({ label: "L", url: "https://a.test" })) })).error).toContain("links: must be an array of at most 20");
    expect((await add({ kind: "note", title: "x", links: Array.from({ length: 20 }, () => ({ label: "L", url: "https://a.test" })) })).error).toBeUndefined();
  });

  it("bounds refs and text fields", async () => {
    expect((await add({ kind: "note", title: "x", refs: ["ok", "", 5, "r".repeat(101)] })).error).toMatch(/refs\[1\]: .*\n.*refs\[2\]: .*\n.*refs\[3\]: /);
    expect((await add({ kind: "note", title: "t".repeat(201) })).error).toContain("title: must be a string of 1-200");
    expect((await add({ kind: "note", title: "t".repeat(200), body: "b".repeat(20_000), version: "v".repeat(64), refs: Array.from({ length: 20 }, () => "r".repeat(100)) })).error).toBeUndefined();
    expect((await add({ kind: "note", title: "x", body: "   " })).error).toContain("body: must be a string of 1-20000 characters, or null");
  });

  it("rejects reserved keys as unexpected fields", async () => {
    const payload = JSON.parse('{"kind":"note","title":"x","__proto__":{"admin":true},"constructor":1}');
    const result = await add(payload);
    expect(result.error).toContain("__proto__: unexpected field");
    expect(result.error).toContain("constructor: unexpected field");
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it("rejects dates outside a range both JavaScript and Postgres handle", async () => {
    for (const occurredAt of ["1969-12-31T23:59:59Z", "275760-09-13", "2026-13-45", 1760000000, "2026-10-13T12:00:00Z".padEnd(70, " ")]) {
      expect((await add({ kind: "note", title: "x", occurredAt })).error, String(occurredAt)).toContain("occurredAt: must be an ISO 8601");
    }
    expect((await add({ kind: "note", title: "x", occurredAt: "2026-10-13T12:00:00-03:00" })).error).toBeUndefined();
  });
});

describe("list_changelog and changelog.list", () => {
  const seed = async () => {
    const dates = ["2026-10-05T10:00:00Z", "2026-10-01T10:00:00Z", "2026-09-20T10:00:00Z", "2026-09-10T10:00:00Z", "2026-08-30T10:00:00Z"];
    const kinds = ["release", "fix", "note", "feature", "incident"] as const;
    for (const [index, occurredAt] of dates.entries()) {
      await add({ kind: kinds[index], title: `Entry ${index + 1}`, occurredAt });
    }
  };

  it("lists newest first with the project name and resolved agent names", async () => {
    await seed();
    const result = await page();
    expect(result.entries.map((entry) => entry.title)).toEqual(["Entry 1", "Entry 2", "Entry 3", "Entry 4", "Entry 5"]);
    expect(result.nextCursor).toBeNull();
    expect(result.entries[0]).toMatchObject({ projectName: "Acme Web App", createdBy: { kind: "agent", id: AGENT, name: "Tracker" } });
  });

  it("breaks ties on occurredAt by id, descending", async () => {
    for (let n = 0; n < 4; n += 1) {
      await add({ kind: "note", title: `Tie ${n}`, occurredAt: "2026-10-05T10:00:00Z" });
    }
    const ids = (await page()).entries.map((entry) => entry.id);
    expect(ids).toEqual([...ids].sort().reverse());
  });

  it("pages with an opaque keyset cursor and ends with a null cursor", async () => {
    await seed();
    const first = await page({ limit: 2 });
    expect(first.entries.map((entry) => entry.title)).toEqual(["Entry 1", "Entry 2"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await page({ limit: 2, before: first.nextCursor });
    expect(second.entries.map((entry) => entry.title)).toEqual(["Entry 3", "Entry 4"]);
    const third = await page({ limit: 2, before: second.nextCursor });
    expect(third.entries.map((entry) => entry.title)).toEqual(["Entry 5"]);
    expect(third.nextCursor).toBeNull();
    expect((await page({ limit: 5 })).nextCursor).toBeNull();
  });

  it("keeps paging stable when new entries arrive meanwhile and across equal timestamps", async () => {
    for (let n = 0; n < 5; n += 1) {
      await add({ kind: "note", title: `Same ${n}`, occurredAt: "2026-10-05T10:00:00Z" });
    }
    const first = await page({ limit: 2 });
    await add({ kind: "note", title: "Newer", occurredAt: "2026-10-06T10:00:00Z" });
    const second = await page({ limit: 2, before: first.nextCursor });
    const third = await page({ limit: 2, before: second.nextCursor });
    const seen = [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.title);
    expect(new Set(seen).size).toBe(5);
    expect(seen).not.toContain("Newer");
  });

  it("rejects malformed cursors, limits and filters", async () => {
    await seed();
    const forged = Buffer.from(JSON.stringify(["2026-10-05T10:00:00Z", "not-a-uuid"])).toString("base64url");
    for (const before of ["garbage", forged, Buffer.from("[1,2]").toString("base64url"), "x".repeat(201)]) {
      await expect(page({ before }), before).rejects.toThrow("before: not a valid cursor");
    }
    for (const limit of [0, 501, 1.5, "abc", "-1", "10000", {}]) {
      await expect(page({ limit }), String(limit)).rejects.toThrow("limit must be an integer from 1 to 500");
    }
    await expect(page({ kinds: ["bogus"] })).rejects.toThrow('kinds: unknown kind "bogus"');
    await expect(page({ includeIssues: "maybe" })).rejects.toThrow("includeIssues must be true or false");
    await expect(page({ projectId: "nope" })).rejects.toThrow("projectId must be a UUID");
    const tool = await h.tool("list_changelog", { limit: 0 });
    expect(tool.error).toContain("limit must be an integer");
  });

  it("filters by kind, accepting arrays and comma-separated lists", async () => {
    await seed();
    expect((await page({ kinds: ["fix", "release"] })).entries.map((entry) => entry.kind)).toEqual(["release", "fix"]);
    expect((await page({ kinds: "incident, note" })).entries.map((entry) => entry.kind)).toEqual(["note", "incident"]);
    expect((await page({ kinds: "issue" })).entries).toEqual([]);
    expect((await page({ kinds: [] })).entries).toHaveLength(5);
  });

  it("filters by project and keeps projects apart", async () => {
    await add({ kind: "note", title: "A", projectId: PROJECT, occurredAt: "2026-10-02" });
    await add({ kind: "note", title: "B", projectId: SECOND_PROJECT, occurredAt: "2026-10-01" });
    expect((await page({ projectId: SECOND_PROJECT })).entries.map((entry) => entry.title)).toEqual(["B"]);
    expect((await page({ projectId: PROJECT.toUpperCase() })).entries.map((entry) => entry.title)).toEqual(["A"]);
    expect((await page()).entries.map((entry) => entry.title)).toEqual(["A", "B"]);
  });

  it("can leave out entries generated from completed issues", async () => {
    await add({ kind: "note", title: "Curated", occurredAt: "2026-10-01" });
    await completeIssue("11111111-0000-4000-8000-000000000001");
    expect((await page()).entries.map((entry) => entry.kind)).toEqual(["issue", "note"]);
    expect((await page({ includeIssues: false })).entries.map((entry) => entry.kind)).toEqual(["note"]);
    expect((await page({ includeIssues: "false" })).entries.map((entry) => entry.kind)).toEqual(["note"]);
  });

  it("never returns another company's entries, even when asked for their project", async () => {
    await seed();
    expect((await page({}, OTHER_COMPANY)).entries).toEqual([]);
    expect((await page({ projectId: PROJECT }, OTHER_COMPANY)).entries).toEqual([]);
    await add({ kind: "note", title: "Theirs" }, { companyId: OTHER_COMPANY, projectId: OTHER_PROJECT });
    expect((await page({}, OTHER_COMPANY)).entries.map((entry) => entry.title)).toEqual(["Theirs"]);
    expect((await page()).entries).toHaveLength(5);
    await expect(h.data("changelog.list", { companyId: "nope" })).rejects.toThrow("companyId must be a UUID");
  });

  it("answers the agent tool with a readable list and the page as data", async () => {
    await seed();
    const result = await h.tool("list_changelog", { limit: 2, kinds: ["release", "fix", "note"] });
    expect(result.content?.split("\n")[0]).toBe("2 changelog entries, newest first; more available, pass nextCursor as before:");
    expect(result.content).toMatch(/- 2026-10-05 \[release\] Entry 1 - Acme Web App \(id [0-9a-f-]{36}\)/);
    expect((result.data as ChangelogPage).nextCursor).toEqual(expect.any(String));
    expect((await h.tool("list_changelog", { projectId: SECOND_PROJECT })).content).toBe("No changelog entries.");
  });

  it("exposes the company's projects for the page filter, by name", async () => {
    const projects = await h.data("projects.list", { companyId: COMPANY });
    expect(projects).toEqual([
      { id: PROJECT, name: "Acme Web App" },
      { id: SECOND_PROJECT, name: "Internal Tools" },
      { id: ARCHIVED_PROJECT, name: "Old Project" },
    ]);
    expect(await h.data("projects.list", { companyId: OTHER_COMPANY })).toEqual([{ id: OTHER_PROJECT, name: "Other Co Project" }]);
  });
});

describe("update_changelog_entry", () => {
  const create = async (extra: Record<string, unknown> = {}) =>
    entryOf(await add({ kind: "note", title: "Original", body: "Body", version: "v1", refs: ["A-1"], occurredAt: "2026-10-01T10:00:00Z", ...extra }));

  it("changes only the fields sent and records who edited", async () => {
    const entry = await create();
    const result = await update({ entryId: entry.id, title: "Renamed", kind: "fix", refs: ["B-2", "C-3"] }, { agentId: "55555555-5555-4555-8555-555555555555" });
    expect(result.error).toBeUndefined();
    expect(result.content).toBe('Updated changelog entry "Renamed" (fix).');
    const after = entryOf(result);
    expect(after).toMatchObject({
      id: entry.id,
      title: "Renamed",
      kind: "fix",
      refs: ["B-2", "C-3"],
      body: "Body",
      version: "v1",
      occurredAt: "2026-10-01T10:00:00.000Z",
      createdBy: { kind: "agent", id: AGENT },
      updatedBy: { kind: "agent", id: "55555555-5555-4555-8555-555555555555" },
    });
    expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(Date.parse(entry.updatedAt));
    expect(h.activity.at(-1)?.message).toBe('Updated changelog entry "Renamed"');
  });

  it("clears body and version with null and replaces links and the date", async () => {
    const entry = await create();
    const after = entryOf(await update({ entryId: entry.id, body: null, version: null, links: [{ label: "x", url: "https://a.test" }], occurredAt: "2026-11-02T00:00:00Z" }));
    expect(after).toMatchObject({ body: null, version: null, links: [{ label: "x", url: "https://a.test/" }], occurredAt: "2026-11-02T00:00:00.000Z" });
    const cleared = entryOf(await update({ entryId: entry.id, links: [], refs: [] }));
    expect(cleared).toMatchObject({ links: [], refs: [] });
  });

  it("reorders the list when occurredAt changes", async () => {
    const first = await create({ title: "First", occurredAt: "2026-10-01T10:00:00Z" });
    await create({ title: "Second", occurredAt: "2026-10-02T10:00:00Z" });
    await update({ entryId: first.id, occurredAt: "2026-10-03T10:00:00Z" });
    expect((await page()).entries.map((entry) => entry.title)).toEqual(["First", "Second"]);
  });

  it("validates like add, requires a change and never moves the entry to another project", async () => {
    const entry = await create();
    expect((await update({ entryId: entry.id })).error).toContain("at least one of kind, title, body, version, refs, links, occurredAt is required");
    expect((await update({ entryId: entry.id, projectId: SECOND_PROJECT })).error).toContain("projectId: unexpected field");
    expect((await update({ entryId: entry.id, kind: "issue" })).error).toContain('kind: "issue" entries are created automatically');
    expect((await update({ entryId: entry.id, title: "" })).error).toContain("title: must be a string of 1-200");
    expect((await update({ entryId: entry.id, body: "" })).error).toContain("body: must be a string of 1-20000 characters, or null");
    expect((await update({ entryId: entry.id, title: null })).error).toContain("title: must be a string");
    expect((await update({ entryId: entry.id, links: [{ label: "x", url: "javascript:1" }] })).error).toContain("links[0].url");
    expect((await update({ entryId: "nope", title: "x" })).error).toBe("entryId must be a UUID");
    expect((await update({ title: "x" })).error).toBe("entryId must be a UUID");
    expect(entryOf(await update({ entryId: entry.id, title: "Still fine" })).projectId).toBe(PROJECT);
    expect((await page()).entries[0]?.title).toBe("Still fine");
  });

  it("answers not found for unknown, deleted and other companies' entries", async () => {
    const entry = await create();
    expect((await update({ entryId: ENTRY_ID, title: "x" })).error).toBe("Changelog entry not found");
    expect((await update({ entryId: entry.id, title: "x" }, { companyId: OTHER_COMPANY, projectId: OTHER_PROJECT })).error).toBe("Changelog entry not found");
    await h.action("changelog.delete", { id: entry.id });
    expect((await update({ entryId: entry.id, title: "x" })).error).toBe("Changelog entry not found");
  });

  it("refuses to edit entries generated from issues", async () => {
    await completeIssue("11111111-0000-4000-8000-000000000002");
    const [generated] = (await page()).entries;
    expect(generated?.kind).toBe("issue");
    const result = await update({ entryId: generated?.id, title: "Rewritten" });
    expect(result.error).toContain("mirror the issue and cannot be edited");
    expect((await page()).entries[0]?.title).toBe("Ship checkout");
  });
});

describe("host action context for changelog mutations", () => {
  it("uses host action context, never client-supplied companyId, for mutations", async () => {
    const entry = entryOf(await add({ kind: "note", title: "Scoped" }));
    await h.action("changelog.delete", { companyId: OTHER_COMPANY, id: entry.id });
    expect((await page()).entries).toHaveLength(0);

    const victim = entryOf(await add({ kind: "note", title: "Still here" }));
    await expect(
      h.action("changelog.delete", { companyId: COMPANY, id: victim.id }, undefined, OTHER_COMPANY),
    ).rejects.toThrow("Changelog entry not found");
    expect((await page()).entries).toHaveLength(1);

    await expect(
      h.action("changelog.delete", { companyId: OTHER_COMPANY, id: victim.id }, undefined, null as unknown as string),
    ).rejects.toThrow("companyId must be a UUID");
  });
});

describe("board delete action", () => {
  it("hides the entry but keeps the row, and records the board user", async () => {
    const entry = entryOf(await add({ kind: "note", title: "Remove me" }));
    expect(await h.action("changelog.delete", { id: entry.id })).toEqual({ ok: true });
    expect((await page()).entries).toEqual([]);
    const stored = await rows(`SELECT deleted_at, updated_by_kind, updated_by_id FROM ${TABLE}`);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ updated_by_kind: "user", updated_by_id: "user-1" });
    expect(stored[0]?.deleted_at).not.toBeNull();
    expect(h.activity.at(-1)).toMatchObject({ message: 'Deleted changelog entry "Remove me"', entityType: "plugin_changelog_entry" });
    await expect(h.action("changelog.delete", { id: entry.id })).rejects.toThrow("Changelog entry not found");
  });

  it("is scoped to the company and validates the id", async () => {
    const entry = entryOf(await add({ kind: "note", title: "Mine" }));
    await expect(h.action("changelog.delete", { id: entry.id }, undefined, OTHER_COMPANY)).rejects.toThrow("Changelog entry not found");
    await expect(h.action("changelog.delete", { id: "nope" })).rejects.toThrow("id must be a UUID");
    expect((await page()).entries).toHaveLength(1);
  });

  it("is not available to agents: there is no delete tool", () => {
    expect(() => h.tool("delete_changelog_entry", {})).toThrow("no tool delete_changelog_entry");
  });
});

describe("concurrency", () => {
  it("serializes simultaneous writes from agents without losing entries", async () => {
    await Promise.all(Array.from({ length: 6 }, (_, n) => add({ kind: "note", title: `Parallel ${n}` })));
    expect((await page()).entries).toHaveLength(6);
  });
});
