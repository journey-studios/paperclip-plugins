import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DashboardSpec } from "../src/contracts.js";
import manifest from "../src/manifest.js";
import { API_ROUTES } from "../src/routes.js";
import { ARCHIVED_PROJECT, COMPANY, EXPLODING_PROJECT, OTHER_COMPANY, OTHER_PROJECT, PROJECT, SECOND_PROJECT, createHarness, type ApiCall, type Harness } from "./harness.js";
import { DATABASE_NAMESPACE } from "../src/manifest.js";

function spec(title = "Demo", value = 1, extra: object = {}): DashboardSpec {
  return {
    version: 1,
    title,
    datasets: { d: { title: "D", source: "unit test", columns: ["name", "n"], rows: [{ name: "a", n: value }], ...extra } },
    sections: [{ id: "s", blocks: [{ type: "kpis", items: [{ label: "N", value: { dataset: "d", field: "n" } }] }] }],
  };
}

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
const rowsOf = async () => (await h.db.query(`SELECT 1 FROM ${DATABASE_NAMESPACE}.dashboards`)).rows;
const body = (response: { body?: unknown }): Json => (response.body ?? {}) as Json;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
// Every dashboard needs a project: default to one of the company's, unless the test sets projectId itself.
const post = (_path: string, payload: unknown, extra: ApiCall = {}) => {
  const withProject = isObject(payload) && !("projectId" in payload)
    ? { ...payload, projectId: extra.companyId === OTHER_COMPANY ? OTHER_PROJECT : PROJECT }
    : payload;
  return h.api("dashboard-upsert", { method: "POST", body: withProject, ...extra });
};

describe("manifest declarations", () => {
  it("declares the 15 board routes with company resolution from the query", () => {
    expect(manifest.version).toBe("0.5.0");
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["api.routes.register", "companies.read"]));
    expect(manifest.apiRoutes?.map((r) => [r.routeKey, r.method, r.path])).toEqual([
      ["dashboards-list", "GET", "/dashboards"],
      ["dashboard-get", "GET", "/dashboards/:slug"],
      ["dashboard-status", "GET", "/dashboards/:slug/status"],
      ["dashboard-upsert", "POST", "/dashboards"],
      ["dataset-update", "POST", "/dashboards/:slug/datasets/:datasetId"],
      ["dashboard-move", "POST", "/dashboards/:slug/project"],
      ["spec-validate", "POST", "/validate"],
      ["milestones-list", "GET", "/milestones"],
      ["milestone-get", "GET", "/milestones/:milestoneId"],
      ["milestone-create", "POST", "/milestones"],
      ["milestone-update", "POST", "/milestones/:milestoneId"],
      ["changelog-list", "GET", "/changelog"],
      ["changelog-add", "POST", "/changelog"],
      ["changelog-import", "POST", "/changelog/import"],
      ["changelog-update", "POST", "/changelog/:entryId"],
    ]);
    expect(API_ROUTES).toHaveLength(15);
    for (const route of manifest.apiRoutes ?? []) {
      expect(route).toMatchObject({ auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } });
    }
  });
});

describe("REST API", () => {
  it("upserts, lists, gets, validates and updates datasets", async () => {
    const created = await post("", { slug: "acme", spec: spec("Demo", 1), projectId: PROJECT });
    expect(created.status).toBe(200);
    expect(body(created)).toMatchObject({
      companyId: COMPANY,
      created: true,
      dashboard: { slug: "acme", title: "Demo", revision: 1, projectId: PROJECT, projectName: "Acme Web App", viewPath: "/ACME/dashboards?d=acme", updatedBy: { kind: "user", id: "board-user-1" } },
    });
    expect(body(created).dashboard).not.toHaveProperty("spec");

    const again = await post("", { slug: "acme", spec: spec("Demo 2", 2) });
    expect(body(again)).toMatchObject({ created: false, dashboard: { revision: 2, projectId: PROJECT } });

    const list = await h.api("dashboards-list");
    expect(body(list).dashboards).toHaveLength(1);
    expect(body(list).dashboards[0]).toMatchObject({ slug: "acme", viewPath: "/ACME/dashboards?d=acme" });
    const none = await h.api("dashboards-list", { query: { companyId: COMPANY, projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } });
    expect(body(none).dashboards).toEqual([]);

    const got = await h.api("dashboard-get", { params: { slug: "acme" } });
    expect(body(got).dashboard.spec.datasets.d.rows[0].n).toBe(2);

    const valid = await h.api("spec-validate", { method: "POST", body: { spec: spec() } });
    expect(body(valid)).toEqual({ companyId: COMPANY, valid: true, datasets: 1, sections: 1 });

    const updated = await h.api("dataset-update", { method: "POST", params: { slug: "acme", datasetId: "d" }, body: { rows: [{ name: "a", n: 9 }], source: "nightly" } });
    expect(updated.status).toBe(200);
    expect(body(updated)).toMatchObject({
      companyId: COMPANY,
      dashboard: { revision: 3 },
      dataset: { id: "d", title: "D", rows: 1, stale: false, staleAfterHours: null },
    });
    expect(Date.parse(body(updated).dataset.updatedAt)).toBeGreaterThan(Date.now() - 60_000);
    const after = await h.api("dashboard-get", { params: { slug: "acme" } });
    expect(body(after).dashboard.spec.datasets.d.source).toBe("nightly");
    expect(h.activity.length).toBe(3);
  });

  it("reports status with freshness per dataset", async () => {
    h.config[COMPANY] = { defaultStaleAfterHours: 24 };
    const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
    await post("", { slug: "fresh-check", spec: spec("S", 1, { updatedAt: old }) });
    const response = await h.api("dashboard-status", { params: { slug: "fresh-check" } });
    const status = body(response).status;
    expect(response.status).toBe(200);
    expect(status).toMatchObject({ slug: "fresh-check", revision: 1, health: "stale", staleCount: 1, sections: 1, blocks: 1, viewPath: "/ACME/dashboards?d=fresh-check" });
    expect(status.datasets[0]).toMatchObject({ id: "d", rows: 1, stale: true, staleAfterHours: 24, updatedAt: old });
    expect(status.datasets[0].ageMinutes).toBeGreaterThanOrEqual(48 * 60);
    expect(Date.parse(status.checkedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(status).not.toHaveProperty("spec");
  });

  it("requires a project for new dashboards and rejects null", async () => {
    const missing = await post("", { slug: "p1", spec: spec(), projectId: undefined });
    expect(missing.status).toBe(400);
    expect(body(missing)).toEqual({ companyId: COMPANY, error: "project_required" });
    const nulled = await post("", { slug: "p1", spec: spec(), projectId: null });
    expect(nulled.status).toBe(400);
    expect(body(nulled).companyId).toBe(COMPANY);
    expect(typeof body(nulled).error).toBe("string");
    expect((await post("", { slug: "p1", spec: spec(), projectId: "nope" })).status).toBe(400);
    expect((await post("", { slug: "p1", spec: spec(), projectId: 5 })).status).toBe(400);
    expect(await rowsOf()).toHaveLength(0);
  });

  it("keeps the project when omitted on an existing dashboard and moves it with a uuid", async () => {
    await post("", { slug: "p1", spec: spec(), projectId: PROJECT });
    await post("", { slug: "p1", spec: spec("y"), projectId: undefined });
    expect(body(await h.api("dashboard-get", { params: { slug: "p1" } })).dashboard.projectId).toBe(PROJECT);
    await post("", { slug: "p1", spec: spec("z"), projectId: SECOND_PROJECT });
    expect(body(await h.api("dashboard-get", { params: { slug: "p1" } })).dashboard).toMatchObject({ projectId: SECOND_PROJECT, projectName: "Internal Tools" });
  });

  it("lets an existing projectless dashboard be updated without a project, or moved with one", async () => {
    await post("", { slug: "orphan", spec: spec(), projectId: PROJECT });
    await h.db.exec(`DELETE FROM public.projects WHERE id = '${PROJECT}'`);
    const stayed = await post("", { slug: "orphan", spec: spec("again"), projectId: undefined });
    expect(stayed.status).toBe(200);
    expect(body(stayed)).toMatchObject({ created: false, dashboard: { revision: 2, projectId: null, projectName: null } });
    expect(body(await h.api("dashboard-status", { params: { slug: "orphan" } })).status).toMatchObject({ orphan: true, revision: 2 });
    const dataset = await h.api("dataset-update", { method: "POST", params: { slug: "orphan", datasetId: "d" }, body: { rows: [{ name: "a", n: 3 }] } });
    expect(dataset.status).toBe(200);
    expect(body(dataset).dashboard.projectId).toBeNull();
    const moved = await post("", { slug: "orphan", spec: spec("again"), projectId: SECOND_PROJECT });
    expect(body(moved).dashboard).toMatchObject({ projectId: SECOND_PROJECT, revision: 4 });
    expect(body(await h.api("dashboard-status", { params: { slug: "orphan" } })).status.orphan).toBe(false);
  });

  it("rejects projects of another company, unknown and archived projects with contract codes", async () => {
    const foreign = await post("", { slug: "p2", spec: spec(), projectId: OTHER_PROJECT });
    expect(foreign.status).toBe(400);
    expect(body(foreign)).toEqual({ companyId: COMPANY, error: "project_not_found" });
    const unknown = await post("", { slug: "p2", spec: spec(), projectId: "99999999-9999-4999-8999-999999999999" });
    expect(body(unknown)).toEqual({ companyId: COMPANY, error: "project_not_found" });
    const archived = await post("", { slug: "p2", spec: spec(), projectId: ARCHIVED_PROJECT });
    expect(archived.status).toBe(400);
    expect(body(archived)).toEqual({ companyId: COMPANY, error: "project_archived" });
    expect(await rowsOf()).toHaveLength(0);
    // Moving into an archived project is rejected too; staying in a project that later gets archived is not.
    await post("", { slug: "p3", spec: spec(), projectId: PROJECT });
    expect(body(await post("", { slug: "p3", spec: spec(), projectId: ARCHIVED_PROJECT })).error).toBe("project_archived");
  });

  it("maps errors to the contract and always includes companyId", async () => {
    const cases: [string, Awaited<ReturnType<Harness["api"]>>, number, Json][] = [
      ["bad slug", await post("", { slug: "Bad Slug", spec: spec() }), 400, {}],
      ["no slug", await post("", { spec: spec() }), 400, { error: "slug is required" }],
      ["no spec", await post("", { slug: "x" }), 400, { error: "spec is required" }],
      ["array body", await post("", [1]), 400, { error: "body must be a JSON object" }],
      ["null body", await post("", null), 400, { error: "body must be a JSON object" }],
      ["get unknown", await h.api("dashboard-get", { params: { slug: "missing" } }), 404, { error: "not_found" }],
      ["get bad slug", await h.api("dashboard-get", { params: { slug: "BAD" } }), 400, {}],
      ["status unknown", await h.api("dashboard-status", { params: { slug: "missing" } }), 404, { error: "not_found" }],
      ["dataset unknown dashboard", await h.api("dataset-update", { method: "POST", params: { slug: "missing", datasetId: "d" }, body: { rows: [] } }), 404, { error: "not_found" }],
      ["dataset bad id", await h.api("dataset-update", { method: "POST", params: { slug: "x", datasetId: "bad id!" }, body: { rows: [] } }), 400, {}],
      ["dataset rows missing", await h.api("dataset-update", { method: "POST", params: { slug: "x", datasetId: "d" }, body: {} }), 400, { error: "rows must be an array" }],
      ["validate no spec", await h.api("spec-validate", { method: "POST", body: {} }), 400, { error: "spec is required" }],
      ["unknown route", await h.api("nope"), 404, { error: "not_found" }],
      ["projectId array", await h.api("dashboards-list", { query: { companyId: COMPANY, projectId: ["a", "b"] } }), 400, { error: "projectId must be given once" }],
    ];
    for (const [name, response, status, expected] of cases) {
      expect(response.status, name).toBe(status);
      expect(body(response).companyId, name).toBe(COMPANY);
      expect(response.headers?.["cache-control"], name).toBe("no-store");
      expect(body(response), name).toMatchObject(expected);
      expect(typeof body(response).error, name).toBe("string");
    }
    await post("", { slug: "known", spec: spec() });
    const unknownDataset = await h.api("dataset-update", { method: "POST", params: { slug: "known", datasetId: "zzz" }, body: { rows: [] } });
    expect(unknownDataset.status).toBe(404);
    expect(body(unknownDataset)).toEqual({ companyId: COMPANY, error: "not_found" });
  });

  it("returns 422 with capped path-precise details", async () => {
    const bad = spec();
    bad.sections = Array.from({ length: 80 }, (_, i) => ({ id: `s${i}`, blocks: [{ type: "table", dataset: `nope-${"x".repeat(400)}`, rowKey: "id", columns: [{ field: "id", label: "ID" }] }] }));
    const response = await post("", { slug: "bad", spec: bad });
    expect(response.status).toBe(422);
    const result = body(response);
    expect(result.error).toBe("invalid_spec");
    expect(result.companyId).toBe(COMPANY);
    expect(result.details.length).toBeLessThanOrEqual(50);
    expect(result.details.every((d: string) => d.length <= 300)).toBe(true);
    expect(result.details[0]).toContain("sections[0].blocks[0].dataset: unknown dataset");
    const small = await h.api("spec-validate", { method: "POST", body: { spec: { version: 1, title: "T", datasets: {}, sections: [{ id: "s", blocks: [{ type: "kpis", items: [{ label: "x", value: { dataset: "foo", field: "a" } }] }] }] } } });
    expect(small.status).toBe(422);
    expect(body(small).details).toEqual(['sections[0].blocks[0].items[0].value.dataset: unknown dataset "foo" (declared: none)']);
    // Rows that break references surface as 422 too.
    await post("", { slug: "refs", spec: spec() });
    const broken = await h.api("dataset-update", { method: "POST", params: { slug: "refs", datasetId: "d" }, body: { rows: [{ other: 1 }], columns: ["other"] } });
    expect(broken.status).toBe(422);
  });

  it("returns 413 with the configured limit", async () => {
    h.config[COMPANY] = { maxSpecBytes: 2048 };
    const big = spec();
    big.datasets.d!.rows = Array.from({ length: 200 }, (_, i) => ({ name: `row-${i}`, n: i }));
    const response = await post("", { slug: "big", spec: big });
    expect(response.status).toBe(413);
    expect(body(response)).toEqual({ companyId: COMPANY, error: "spec_too_large", limitBytes: 2048 });
    const validate = await h.api("spec-validate", { method: "POST", body: { spec: big } });
    expect(validate.status).toBe(413);
    expect(await h.db.query(`SELECT 1 FROM ${DATABASE_NAMESPACE}.dashboards`)).toMatchObject({ rows: [] });
  });

  it("wraps unexpected errors as 500 without leaking details and logs them", async () => {
    const response = await post("", { slug: "boom", spec: spec(), projectId: EXPLODING_PROJECT });
    expect(response.status).toBe(500);
    expect(body(response)).toEqual({ companyId: COMPANY, error: "internal_error" });
    expect(response.headers?.["cache-control"]).toBe("no-store");
    expect(JSON.stringify(response)).not.toContain("secrets");
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("boom");
  });

  it("isolates companies in every route", async () => {
    await post("", { slug: "secret", spec: spec("Secret") });
    const other = { companyId: OTHER_COMPANY, query: { companyId: OTHER_COMPANY } };
    const list = await h.api("dashboards-list", other);
    expect(body(list)).toEqual({ companyId: OTHER_COMPANY, dashboards: [] });
    for (const [key, call] of [
      ["dashboard-get", { params: { slug: "secret" } }],
      ["dashboard-status", { params: { slug: "secret" } }],
      ["dataset-update", { method: "POST", params: { slug: "secret", datasetId: "d" }, body: { rows: [] } }],
    ] as const) {
      const response = await h.api(key, { ...call, ...other });
      expect(response.status, key).toBe(404);
      expect(body(response).companyId).toBe(OTHER_COMPANY);
    }
    expect((await post("", { slug: "secret", spec: spec("B copy") }, other)).status).toBe(200);
    expect(body(await h.api("dashboard-get", { params: { slug: "secret" } })).dashboard.title).toBe("Secret");
    expect(body(await h.api("dashboard-get", { params: { slug: "secret" }, ...other })).dashboard.viewPath).toBe("/BETA/dashboards?d=secret");
    // Per-company settings apply per company.
    h.config[OTHER_COMPANY] = { maxSpecBytes: 1024 };
    const big = spec();
    big.datasets.d!.rows = Array.from({ length: 100 }, (_, i) => ({ name: `row-${i}`, n: i }));
    expect((await post("", { slug: "big", spec: big }, other)).status).toBe(413);
    expect((await post("", { slug: "big", spec: big })).status).toBe(200);
  });

  it("attributes writes to the board user, falling back to the actor id", async () => {
    await post("", { slug: "who", spec: spec() }, { actor: { actorType: "user", actorId: "session-9" } });
    expect(body(await h.api("dashboard-get", { params: { slug: "who" } })).dashboard.updatedBy).toEqual({ kind: "user", id: "session-9", name: null });
  });

  it("caches the company prefix lookup", async () => {
    await post("", { slug: "c1", spec: spec() });
    await h.api("dashboards-list");
    await h.api("dashboard-get", { params: { slug: "c1" } });
    expect(h.companyLookups.filter((id) => id === COMPANY)).toHaveLength(1);
  });

  it("serializes concurrent REST writes", async () => {
    const results = await Promise.all([1, 2, 3, 4].map((n) => post("", { slug: "race", spec: spec("R", n) })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const status = await h.api("dashboard-status", { params: { slug: "race" } });
    expect(body(status).status.revision).toBe(4);
  });
});

describe("POST /dashboards/:slug/project (dashboard-move)", () => {
  const move = (slug: string, payload: unknown, extra: ApiCall = {}) =>
    h.api("dashboard-move", { method: "POST", params: { slug }, body: payload, ...extra });
  const revisionsOf = async (id: string) => (await h.data("dashboard.revisions", { companyId: COMPANY, id })) as { revision: number }[];

  it("moves the dashboard atomically: one new revision, unchanged spec, activity logged, board user as author", async () => {
    await post("", { slug: "mv", spec: spec("Movable", 4) });
    const before = body(await h.api("dashboard-get", { params: { slug: "mv" } })).dashboard;
    expect(before).toMatchObject({ projectId: PROJECT, revision: 1 });
    const writes = h.executed.length;

    const response = await move("mv", { projectId: SECOND_PROJECT });
    expect(response.status).toBe(200);
    expect(response.headers?.["cache-control"]).toBe("no-store");
    expect(body(response)).toEqual({
      companyId: COMPANY,
      moved: true,
      dashboard: {
        id: before.id,
        slug: "mv",
        title: "Movable",
        projectId: SECOND_PROJECT,
        projectName: "Internal Tools",
        revision: 2,
        updatedAt: expect.any(String),
        updatedBy: { kind: "user", id: "board-user-1", name: null },
        viewPath: "/ACME/dashboards?d=mv",
      },
    });
    // One single statement writes the row and its revision.
    expect(h.executed.length - writes).toBe(1);
    const after = body(await h.api("dashboard-get", { params: { slug: "mv" } })).dashboard;
    expect(after.spec).toEqual(before.spec);
    expect(after).toMatchObject({ title: "Movable", projectId: SECOND_PROJECT, revision: 2 });
    expect((await revisionsOf(before.id)).map((r) => r.revision)).toEqual([2, 1]);
    expect(h.activity.at(-1)?.message).toBe('Moved dashboard "Movable" to project "Internal Tools"');
    expect(body(await h.api("dashboards-list", { query: { companyId: COMPANY, projectId: SECOND_PROJECT } })).dashboards.map((d: Json) => d.slug)).toEqual(["mv"]);
    expect(body(await h.api("dashboards-list", { query: { companyId: COMPANY, projectId: PROJECT } })).dashboards).toEqual([]);
  });

  it("answers moved: false without a new revision or activity when the project does not change", async () => {
    await post("", { slug: "stay", spec: spec() });
    const id = body(await h.api("dashboard-get", { params: { slug: "stay" } })).dashboard.id as string;
    const writes = h.executed.length;
    const activity = h.activity.length;
    const response = await move("stay", { projectId: PROJECT });
    expect(response.status).toBe(200);
    expect(body(response)).toMatchObject({ companyId: COMPANY, moved: false, dashboard: { slug: "stay", projectId: PROJECT, revision: 1 } });
    expect(h.executed).toHaveLength(writes);
    expect(h.activity).toHaveLength(activity);
    expect((await revisionsOf(id)).map((r) => r.revision)).toEqual([1]);
    // An uppercase UUID is the same project.
    expect(body(await move("stay", { projectId: PROJECT.toUpperCase() })).moved).toBe(false);
    // Moving twice to the target only moves once.
    expect(body(await move("stay", { projectId: SECOND_PROJECT })).moved).toBe(true);
    expect(body(await move("stay", { projectId: SECOND_PROJECT })).moved).toBe(false);
    expect((await revisionsOf(id)).map((r) => r.revision)).toEqual([2, 1]);
  });

  it("moves a projectless dashboard into a project", async () => {
    await post("", { slug: "lost", spec: spec() });
    await h.db.exec(`DELETE FROM public.projects WHERE id = '${PROJECT}'`);
    expect(body(await h.api("dashboard-get", { params: { slug: "lost" } })).dashboard.projectId).toBeNull();
    const response = await move("lost", { projectId: SECOND_PROJECT });
    expect(body(response)).toMatchObject({ moved: true, dashboard: { projectId: SECOND_PROJECT, projectName: "Internal Tools", revision: 2 } });
  });

  it("reports project_required for a missing, null or malformed projectId, before looking the dashboard up", async () => {
    await post("", { slug: "req", spec: spec() });
    const writes = h.executed.length;
    for (const payload of [{}, { projectId: null }, { projectId: "nope" }, { projectId: 5 }, { projectId: "" }, { projectId: [PROJECT] }, { project: PROJECT }, null, [PROJECT], "text"]) {
      const response = await move("req", payload);
      expect(response.status, JSON.stringify(payload)).toBe(400);
      expect(body(response), JSON.stringify(payload)).toEqual({ companyId: COMPANY, error: "project_required" });
    }
    // The documented order: a malformed projectId is reported even when the dashboard does not exist.
    expect(body(await move("missing", {})).error).toBe("project_required");
    expect(h.executed).toHaveLength(writes);
    expect(body(await h.api("dashboard-get", { params: { slug: "req" } })).dashboard.revision).toBe(1);
  });

  it("reports project_not_found for unknown projects and projects of another company, and project_archived", async () => {
    await post("", { slug: "chk", spec: spec() });
    const writes = h.executed.length;
    const unknown = await move("chk", { projectId: "99999999-9999-4999-8999-999999999999" });
    expect(unknown.status).toBe(400);
    expect(body(unknown)).toEqual({ companyId: COMPANY, error: "project_not_found" });
    const foreign = await move("chk", { projectId: OTHER_PROJECT });
    expect(foreign.status).toBe(400);
    expect(body(foreign)).toEqual({ companyId: COMPANY, error: "project_not_found" });
    const archived = await move("chk", { projectId: ARCHIVED_PROJECT });
    expect(archived.status).toBe(400);
    expect(body(archived)).toEqual({ companyId: COMPANY, error: "project_archived" });
    expect(h.executed).toHaveLength(writes);
    expect(body(await h.api("dashboard-get", { params: { slug: "chk" } })).dashboard).toMatchObject({ projectId: PROJECT, revision: 1 });
  });

  it("answers 404 not_found for an unknown dashboard and 400 for a bad slug, with the company echo", async () => {
    const unknown = await move("missing", { projectId: SECOND_PROJECT });
    expect(unknown.status).toBe(404);
    expect(unknown.headers?.["cache-control"]).toBe("no-store");
    expect(body(unknown)).toEqual({ companyId: COMPANY, error: "not_found" });
    const bad = await move("Bad Slug", { projectId: SECOND_PROJECT });
    expect(bad.status).toBe(400);
    expect(body(bad).companyId).toBe(COMPANY);
    expect(typeof body(bad).error).toBe("string");
    expect(await rowsOf()).toHaveLength(0);
  });

  it("isolates companies: another company cannot see or move the dashboard, nor move one into a foreign project", async () => {
    await post("", { slug: "secret", spec: spec("Secret") });
    const other = { companyId: OTHER_COMPANY, query: { companyId: OTHER_COMPANY } };
    const hidden = await move("secret", { projectId: OTHER_PROJECT }, other);
    expect(hidden.status).toBe(404);
    expect(body(hidden)).toEqual({ companyId: OTHER_COMPANY, error: "not_found" });
    // The owner cannot move it into the other company's project either.
    expect(body(await move("secret", { projectId: OTHER_PROJECT })).error).toBe("project_not_found");
    // Each company moves only its own dashboard with the same slug.
    await post("", { slug: "secret", spec: spec("B copy") }, other);
    expect(body(await move("secret", { projectId: SECOND_PROJECT })).moved).toBe(true);
    const bView = body(await h.api("dashboard-get", { params: { slug: "secret" }, ...other })).dashboard;
    expect(bView).toMatchObject({ title: "B copy", projectId: OTHER_PROJECT, revision: 1 });
    expect(body(await h.api("dashboard-get", { params: { slug: "secret" } })).dashboard).toMatchObject({ title: "Secret", projectId: SECOND_PROJECT, revision: 2 });
  });

  it("serializes moves with other writes of the company", async () => {
    await post("", { slug: "race", spec: spec() });
    const results = await Promise.all([
      move("race", { projectId: SECOND_PROJECT }),
      move("race", { projectId: SECOND_PROJECT }),
      post("", { slug: "race", spec: spec("again", 2), projectId: undefined }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results.slice(0, 2).map((r) => body(r).moved).sort()).toEqual([false, true]);
    expect(body(await h.api("dashboard-status", { params: { slug: "race" } })).status).toMatchObject({ revision: 3 });
  });
});

describe("reserved names and own-property lookups", () => {
  it("answers 422 with a clear path for __proto__/constructor dataset ids", async () => {
    for (const id of ["__proto__", "constructor", "prototype"]) {
      const payload = JSON.parse(`{"slug":"evil","spec":{"version":1,"title":"T","datasets":{"${id}":{"title":"x","rows":[]}},"sections":[]}}`);
      const response = await post("", payload);
      expect(response.status, id).toBe(422);
      expect(body(response).details, id).toEqual([`datasets.${id}: "${id}" is a reserved name and cannot be a dataset id`]);
    }
    expect(({} as Record<string, unknown>).title).toBeUndefined();
    expect(await h.db.query(`SELECT 1 FROM ${DATABASE_NAMESPACE}.dashboards`)).toMatchObject({ rows: [] });
  });

  it("treats inherited names as unknown datasets (404 over REST, error from the tool)", async () => {
    await post("", { slug: "known", spec: spec() });
    for (const datasetId of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const response = await h.api("dataset-update", { method: "POST", params: { slug: "known", datasetId }, body: { rows: [] } });
      expect(response.status, datasetId).toBe(404);
      expect(body(response), datasetId).toEqual({ companyId: COMPANY, error: "not_found" });
    }
    const tool = await h.tool("update_dataset", { slug: "known", datasetId: "constructor", rows: [] });
    expect(tool.error).toContain('unknown dataset "constructor" (declared: d)');
    const record = body(await h.api("dashboard-get", { params: { slug: "known" } })).dashboard;
    expect(record.revision).toBe(1);
  });
});

describe("get_dashboard_status tool", () => {
  it("summarizes health in one line and returns the data", async () => {
    h.config[COMPANY] = { defaultStaleAfterHours: 1 };
    const old = new Date(Date.now() - 5 * 3_600_000).toISOString();
    await h.tool("upsert_dashboard", { slug: "tool-status", spec: spec("T", 1, { updatedAt: old }) });
    const result = await h.tool("get_dashboard_status", { slug: "tool-status" });
    expect(result.content).toBe('Dashboard "tool-status" revision 1 is stale: 1 of 1 dataset(s) stale (d); 1 section(s), 1 block(s).');
    expect(result.data).toMatchObject({ health: "stale", viewPath: "/ACME/dashboards?d=tool-status" });
    expect((await h.tool("get_dashboard_status", { slug: "nope" })).error).toBe('Dashboard "nope" not found');
  });

  it("exposes the lightweight dashboard.status handler without a spec", async () => {
    await h.tool("upsert_dashboard", { slug: "live", spec: spec() });
    const status = (await h.data("dashboard.status", { companyId: COMPANY, slug: "live" })) as Json;
    expect(status).toMatchObject({ revision: 1, health: "unknown", staleCount: 0, datasetCount: 1 });
    expect(status).not.toHaveProperty("spec");
    expect(await h.data("dashboard.status", { companyId: OTHER_COMPANY, slug: "live" })).toBeNull();
  });
});
