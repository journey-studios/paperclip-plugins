import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { COMPANY, OTHER_COMPANY, OTHER_PROJECT, PROJECT, SECOND_PROJECT, createHarness, issue, type Harness } from "./harness.js";

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

type Json = Record<string, any>;
const body = (response: { body?: unknown }): Json => (response.body ?? {}) as Json;
const addEntry = (payload: unknown, extra: object = {}) => h.api("changelog-add", { method: "POST", body: payload, ...extra });
const list = (query: Record<string, string | string[]> = {}, extra: object = {}) =>
  h.api("changelog-list", { query: { companyId: COMPANY, ...query }, ...extra });
const valid = { projectId: PROJECT, kind: "release", title: "Checkout v2", body: "Faster", version: "v2.0.0", refs: ["ACME-1"], links: [{ label: "PR", url: "https://example.com/1" }], occurredAt: "2026-10-01T10:00:00Z" };

describe("changelog REST routes", () => {
  it("adds, lists and updates entries as the board user", async () => {
    const created = await addEntry(valid);
    expect(created.status).toBe(200);
    expect(created.headers?.["cache-control"]).toBe("no-store");
    expect(body(created)).toMatchObject({
      companyId: COMPANY,
      entry: {
        projectId: PROJECT,
        projectName: "Acme Web App",
        kind: "release",
        title: "Checkout v2",
        version: "v2.0.0",
        occurredAt: "2026-10-01T10:00:00.000Z",
        createdBy: { kind: "user", id: "board-user-1" },
      },
    });
    const id = body(created).entry.id as string;

    const listed = await list();
    expect(listed.status).toBe(200);
    expect(body(listed)).toMatchObject({ companyId: COMPANY, nextCursor: null });
    expect(body(listed).entries.map((entry: Json) => entry.id)).toEqual([id]);

    const updated = await h.api("changelog-update", { method: "POST", params: { entryId: id }, body: { title: "Checkout v2.0.1", body: null } });
    expect(updated.status).toBe(200);
    expect(body(updated)).toMatchObject({ companyId: COMPANY, entry: { id, title: "Checkout v2.0.1", body: null, version: "v2.0.0", updatedBy: { kind: "user", id: "board-user-1" } } });
    expect(h.activity.map((entry) => entry.message)).toEqual([
      'Added release changelog entry "Checkout v2" to project "Acme Web App"',
      'Updated changelog entry "Checkout v2.0.1"',
    ]);
  });

  it("filters and pages the list from query parameters", async () => {
    await addEntry({ ...valid, kind: "fix", title: "A", occurredAt: "2026-10-03" });
    await addEntry({ ...valid, kind: "release", title: "B", occurredAt: "2026-10-02" });
    await addEntry({ ...valid, kind: "note", title: "C", projectId: SECOND_PROJECT, occurredAt: "2026-10-01" });
    const titles = async (query: Record<string, string>) => body(await list(query)).entries.map((entry: Json) => entry.title);
    expect(await titles({ projectId: SECOND_PROJECT })).toEqual(["C"]);
    expect(await titles({ kind: "fix,release" })).toEqual(["A", "B"]);
    expect(await titles({ kind: "note", projectId: PROJECT })).toEqual([]);
    expect(await titles({ includeIssues: "false" })).toEqual(["A", "B", "C"]);
    const first = body(await list({ limit: "2" }));
    expect(first.entries.map((entry: Json) => entry.title)).toEqual(["A", "B"]);
    const second = body(await list({ limit: "2", before: first.nextCursor }));
    expect(second.entries.map((entry: Json) => entry.title)).toEqual(["C"]);
    expect(second.nextCursor).toBeNull();
  });

  it("includes and excludes entries generated from issues", async () => {
    const id = randomUUID();
    h.issues.set(id, issue({ id }));
    await h.emit("issue.updated", id);
    await addEntry(valid);
    expect(body(await list()).entries.map((entry: Json) => entry.kind)).toEqual(["issue", "release"]);
    expect(body(await list({ includeIssues: "false" })).entries.map((entry: Json) => entry.kind)).toEqual(["release"]);
    expect(body(await list({ kind: "issue" })).entries.map((entry: Json) => entry.kind)).toEqual(["issue"]);
  });

  it("imports completed issues of a project through its own route", async () => {
    for (const title of ["One", "Two"]) {
      const id = randomUUID();
      h.issues.set(id, issue({ id, title }));
    }
    const response = await h.api("changelog-import", { method: "POST", body: { projectId: PROJECT } });
    expect(response.status).toBe(200);
    expect(body(response)).toEqual({ companyId: COMPANY, scanned: 2, imported: 2, skipped: 0, truncated: false });
    expect(body(await h.api("changelog-import", { method: "POST", body: { projectId: PROJECT } }))).toMatchObject({ imported: 0, skipped: 2 });
    expect(body(await list()).entries).toHaveLength(2);
  });

  it("maps errors to 400, 404 and 422 with the company always echoed", async () => {
    const id = body(await addEntry(valid)).entry.id as string;
    const cases: [string, Awaited<ReturnType<Harness["api"]>>, number, Json][] = [
      ["array body", await addEntry([1]), 400, { error: "body must be a JSON object" }],
      ["null body", await addEntry(null), 400, { error: "body must be a JSON object" }],
      ["no project", await addEntry({ kind: "note", title: "x" }), 400, { error: "projectId must be a UUID" }],
      ["bad project", await addEntry({ ...valid, projectId: "nope" }), 400, { error: "projectId must be a UUID" }],
      ["foreign project", await addEntry({ ...valid, projectId: OTHER_PROJECT }), 400, { error: "Project not found in this company" }],
      ["bad kind", await addEntry({ ...valid, kind: "party" }), 422, { error: "invalid_entry" }],
      ["issue kind", await addEntry({ ...valid, kind: "issue" }), 422, { error: "invalid_entry" }],
      ["bad url", await addEntry({ ...valid, links: [{ label: "x", url: "javascript:alert(1)" }] }), 422, { error: "invalid_entry" }],
      ["unexpected field", await addEntry({ ...valid, companyId: OTHER_COMPANY }), 422, { error: "invalid_entry" }],
      ["update nothing", await h.api("changelog-update", { method: "POST", params: { entryId: id }, body: {} }), 422, { error: "invalid_entry" }],
      ["update bad body", await h.api("changelog-update", { method: "POST", params: { entryId: id }, body: [] }), 400, { error: "body must be a JSON object" }],
      ["update bad id", await h.api("changelog-update", { method: "POST", params: { entryId: "import" }, body: { title: "x" } }), 400, { error: "entryId must be a UUID" }],
      ["update unknown", await h.api("changelog-update", { method: "POST", params: { entryId: randomUUID() }, body: { title: "x" } }), 404, { error: "not_found" }],
      ["list bad limit", await list({ limit: "0" }), 400, { error: "limit must be an integer from 1 to 500" }],
      ["list limit text", await list({ limit: "ten" }), 400, { error: "limit must be an integer from 1 to 500" }],
      ["list bad kind", await list({ kind: "bogus" }), 400, { error: 'kinds: unknown kind "bogus"' }],
      ["list bad cursor", await list({ before: "zzz" }), 400, { error: "before: not a valid cursor; pass the nextCursor of a previous response" }],
      ["list bad flag", await list({ includeIssues: "yes" }), 400, { error: "includeIssues must be true or false" }],
      ["list bad project", await list({ projectId: "nope" }), 400, { error: "projectId must be a UUID" }],
      ["list repeated project", await list({ projectId: [PROJECT, SECOND_PROJECT] }), 400, { error: "projectId must be given once" }],
      ["import bad body", await h.api("changelog-import", { method: "POST", body: "x" }), 400, { error: "body must be a JSON object" }],
      ["import no project", await h.api("changelog-import", { method: "POST", body: {} }), 400, { error: "projectId must be a UUID" }],
      ["import foreign project", await h.api("changelog-import", { method: "POST", body: { projectId: OTHER_PROJECT } }), 400, { error: "Project not found in this company" }],
    ];
    for (const [name, response, status, expected] of cases) {
      expect(response.status, name).toBe(status);
      expect(body(response).companyId, name).toBe(COMPANY);
      expect(response.headers?.["cache-control"], name).toBe("no-store");
      expect(body(response), name).toMatchObject(expected);
    }
  });

  it("returns every field problem with its path, capped, on 422", async () => {
    const response = await addEntry({ projectId: PROJECT, kind: "party", title: "", refs: Array.from({ length: 80 }, () => 5), links: "x" });
    expect(response.status).toBe(422);
    const details = body(response).details as string[];
    expect(details[0]).toContain("kind: must be one of");
    expect(details).toEqual(expect.arrayContaining([expect.stringContaining("title: must be a string of 1-200"), expect.stringContaining("links: must be an array")]));
    expect(details.length).toBeLessThanOrEqual(50);
    expect(details.every((detail) => detail.length <= 300)).toBe(true);
  });

  it("refuses to edit an entry generated from an issue", async () => {
    const id = randomUUID();
    h.issues.set(id, issue({ id }));
    await h.emit("issue.updated", id);
    const [generated] = body(await list()).entries as Json[];
    const response = await h.api("changelog-update", { method: "POST", params: { entryId: generated?.id }, body: { title: "x" } });
    expect(response.status).toBe(400);
    expect(body(response).error).toContain("cannot be edited");
  });

  it("isolates companies in every route", async () => {
    const id = body(await addEntry(valid)).entry.id as string;
    const other = { companyId: OTHER_COMPANY, query: { companyId: OTHER_COMPANY } };
    expect(body(await list({ companyId: OTHER_COMPANY }, other))).toEqual({ companyId: OTHER_COMPANY, entries: [], nextCursor: null });
    const update = await h.api("changelog-update", { method: "POST", params: { entryId: id }, body: { title: "hijacked" }, ...other });
    expect(update.status).toBe(404);
    expect(body(update).companyId).toBe(OTHER_COMPANY);
    expect((await addEntry({ ...valid, projectId: PROJECT }, other)).status).toBe(400);
    expect((await h.api("changelog-import", { method: "POST", body: { projectId: PROJECT }, ...other })).status).toBe(400);
    expect(body(await list()).entries[0].title).toBe("Checkout v2");
  });

  it("serializes concurrent writes", async () => {
    const results = await Promise.all([1, 2, 3, 4].map((n) => addEntry({ ...valid, title: `Parallel ${n}` })));
    expect(results.every((response) => response.status === 200)).toBe(true);
    expect(body(await list()).entries).toHaveLength(4);
  });

  it("wraps unexpected failures as 500 without leaking and logs them", async () => {
    await h.db.exec(`DROP TABLE ${"plugin_project_dashboards_54173784c0"}.changelog_entries`);
    const response = await list();
    expect(response.status).toBe(500);
    expect(body(response)).toEqual({ companyId: COMPANY, error: "internal_error" });
    expect(h.errors).toHaveLength(1);
  });
});
