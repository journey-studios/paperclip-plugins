import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DashboardRecord, DashboardSpec, DashboardSummary, RevisionSummary } from "../src/contracts.js";
import manifest, { DATABASE_NAMESPACE } from "../src/manifest.js";
import {
  AGENT,
  COMPANY,
  OTHER_COMPANY,
  ARCHIVED_PROJECT,
  OTHER_PROJECT,
  PROJECT,
  SECOND_PROJECT,
  createHarness,
  type Harness,
} from "./harness.js";

const example = JSON.parse(await readFile(new URL("../examples/project-dashboard.example.json", import.meta.url), "utf8"));

function spec(title = "Demo", value = 1): DashboardSpec {
  return {
    version: 1,
    title,
    datasets: { d: { title: "D", source: "unit test", rows: [{ name: "a", n: value }], columns: ["name", "n"] } },
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

const upsert = (params: Record<string, unknown>, run = {}) => h.tool("upsert_dashboard", params, run);
const rows = async (sql: string, params: unknown[] = []) => (await h.db.query<Record<string, unknown>>(sql, params)).rows;

describe("manifest", () => {
  it("is least-privilege and needs no artifact access", () => {
    expect(manifest.id).toBe("journeystudios.project-dashboards");
    expect(manifest.capabilities).not.toContain("artifacts.read");
    expect(manifest.database?.coreReadTables).toEqual(["companies", "projects"]);
    expect(manifest.tools?.map((tool) => tool.name)).toEqual([
      "upsert_dashboard",
      "get_dashboard",
      "list_dashboards",
      "get_dashboard_status",
      "update_dataset",
      "validate_dashboard_spec",
    ]);
    const slots = manifest.ui?.slots ?? [];
    expect(slots.map((slot) => slot.type)).toEqual(["sidebar", "page", "detailTab"]);
    expect(slots.find((slot) => slot.type === "page")?.routePath).toBe("dashboards");
    expect(slots.find((slot) => slot.type === "detailTab")?.entityTypes).toEqual(["project"]);
    expect(DATABASE_NAMESPACE).toBe("plugin_project_dashboards_54173784c0");
  });
});

describe("upsert_dashboard", () => {
  it("creates revision 1 then revision 2 and records the agent actor", async () => {
    const first = await upsert({ slug: "acme", spec: spec("Demo", 1) });
    expect(first.error).toBeUndefined();
    expect(first.content).toContain('Created dashboard "acme" revision 1');
    const second = await upsert({ slug: "acme", spec: spec("Demo v2", 2) });
    expect(second.content).toContain("Updated dashboard");
    expect(second.content).toContain("revision 2");

    const record = (await h.data("dashboard.get", { companyId: COMPANY, slug: "acme" })) as DashboardRecord;
    expect(record.revision).toBe(2);
    expect(record.title).toBe("Demo v2");
    expect(record.projectId).toBe(PROJECT);
    expect(record.projectName).toBe("Acme Web App");
    expect(record.updatedBy).toEqual({ kind: "agent", id: AGENT, name: "Tracker" });
    expect(record.spec?.datasets.d?.rows[0]?.n).toBe(2);
    const revisions = (await h.data("dashboard.revisions", { companyId: COMPANY, id: record.id })) as RevisionSummary[];
    expect(revisions.map((r) => r.revision)).toEqual([2, 1]);
    expect(h.activity.map((a) => a.message)).toEqual([
      'Created dashboard "Demo" (revision 1)',
      'Updated dashboard "Demo v2" (revision 2)',
    ]);
  });

  it("stores the full example fixture", async () => {
    const result = await upsert({ slug: "acme-web-app", spec: example });
    expect(result.error).toBeUndefined();
  });

  it("accepts a JSON string spec", async () => {
    expect((await upsert({ slug: "str", spec: JSON.stringify(spec()) })).error).toBeUndefined();
  });

  it("defaults a new dashboard to the run's project; explicit ids win; updates keep the project", async () => {
    await upsert({ slug: "other", spec: spec(), projectId: SECOND_PROJECT });
    await upsert({ slug: "keep", spec: spec() });
    await upsert({ slug: "keep", spec: spec("again") }, { projectId: SECOND_PROJECT });
    const list = (await h.data("dashboards.list", { companyId: COMPANY })) as DashboardSummary[];
    const bySlug = Object.fromEntries(list.map((item) => [item.slug, item.projectId]));
    expect(bySlug).toEqual({ other: SECOND_PROJECT, keep: PROJECT });
    expect(list.find((item) => item.slug === "keep")).toMatchObject({ projectName: "Acme Web App", projectUrlKey: "acme-web-app", orphan: false });
    const filtered = (await h.data("dashboards.list", { companyId: COMPANY, projectId: SECOND_PROJECT })) as DashboardSummary[];
    expect(filtered.map((item) => item.slug)).toEqual(["other"]);
  });

  it("requires a project: no run project and no projectId is a tool error, null is rejected", async () => {
    const noProject = await upsert({ slug: "np", spec: spec() }, { projectId: "" });
    expect(noProject.error).toContain("project_required");
    expect(noProject.error).toContain("this run has no project");
    const withId = await upsert({ slug: "np", spec: spec(), projectId: SECOND_PROJECT }, { projectId: "" });
    expect(withId.error).toBeUndefined();
    const nulled = await upsert({ slug: "nn", spec: spec(), projectId: null });
    expect(nulled.error).toContain("project_required");
    expect(nulled.error).toContain("cannot be null");
    expect((await upsert({ slug: "nn", spec: spec(), projectId: 7 })).error).toContain("must be a project UUID string");
    expect(await rows(`SELECT slug FROM ${DATABASE_NAMESPACE}.dashboards`)).toEqual([{ slug: "np" }]);
  });

  it("keeps a projectless dashboard projectless when projectId is omitted, and moves it with a uuid", async () => {
    await upsert({ slug: "lost", spec: spec() });
    await h.db.exec(`DELETE FROM public.projects WHERE id = '${PROJECT}'`);
    const list = (await h.data("dashboards.list", { companyId: COMPANY })) as DashboardSummary[];
    expect(list[0]).toMatchObject({ projectId: null, projectName: null, projectUrlKey: null, orphan: true });
    // The run still has a project, but an existing orphan is not adopted silently.
    const stayed = await upsert({ slug: "lost", spec: spec("kept") });
    expect(stayed.error).toBeUndefined();
    expect(((await h.data("dashboard.get", { companyId: COMPANY, slug: "lost" })) as DashboardRecord).projectId).toBeNull();
    expect((await h.tool("update_dataset", { slug: "lost", datasetId: "d", rows: [{ name: "a", n: 5 }] })).error).toBeUndefined();
    const moved = await upsert({ slug: "lost", spec: spec("moved"), projectId: SECOND_PROJECT });
    expect(moved.error).toBeUndefined();
    expect(((await h.data("dashboard.get", { companyId: COMPANY, slug: "lost" })) as DashboardRecord)).toMatchObject({ projectId: SECOND_PROJECT, orphan: false });
  });

  it("rejects projects of another company and archived projects", async () => {
    const result = await upsert({ slug: "x", spec: spec(), projectId: OTHER_PROJECT });
    expect(result.error).toContain("project_not_found");
    const archived = await upsert({ slug: "x", spec: spec(), projectId: ARCHIVED_PROJECT });
    expect(archived.error).toContain("project_archived");
    expect(archived.error).toContain("Old Project");
    expect(await rows(`SELECT 1 FROM ${DATABASE_NAMESPACE}.dashboards`)).toHaveLength(0);
    // The run's own (archived) project cannot be used to create either.
    expect((await upsert({ slug: "y", spec: spec() }, { projectId: ARCHIVED_PROJECT })).error).toContain("project_archived");
  });

  it("validates slugs", async () => {
    for (const slug of ["Bad Slug", "UPPER", "", "a".repeat(65), "x/y"]) {
      const result = await upsert({ slug, spec: spec() });
      expect(result.error, slug).toContain("slug must be lowercase");
    }
  });

  it("returns path-precise validation errors", async () => {
    const bad = spec();
    bad.sections[0]!.blocks = [{ type: "table", dataset: "foo", rowKey: "id", columns: [{ field: "id", label: "ID" }] }];
    const result = await upsert({ slug: "bad", spec: bad });
    expect(result.error).toContain('sections[0].blocks[0].dataset: unknown dataset "foo"');
    const dry = await h.tool("validate_dashboard_spec", { spec: bad });
    expect(dry.error).toContain("sections[0].blocks[0].dataset");
    const ok = await h.tool("validate_dashboard_spec", { spec: spec() });
    expect(ok.content).toContain("Spec is valid");
    expect(await rows(`SELECT 1 FROM ${DATABASE_NAMESPACE}.dashboards`)).toHaveLength(0);
  });

  it("keeps slugs unique per company only", async () => {
    await upsert({ slug: "shared", spec: spec("A") });
    await upsert({ slug: "shared", spec: spec("A2") });
    await upsert({ slug: "shared", spec: spec("B") }, { companyId: OTHER_COMPANY, projectId: OTHER_PROJECT });
    expect(await rows(`SELECT slug FROM ${DATABASE_NAMESPACE}.dashboards WHERE slug = 'shared'`)).toHaveLength(2);
    await expect(
      h.db.query(
        `INSERT INTO ${DATABASE_NAMESPACE}.dashboards(id, company_id, slug, title, spec, revision, updated_by_kind) VALUES ('99999999-9999-4999-8999-999999999999', $1, 'shared', 't', '{}'::jsonb, 1, 'system')`,
        [COMPANY],
      ),
    ).rejects.toThrow();
  });

  it("serializes concurrent writes into consecutive revisions", async () => {
    await Promise.all([1, 2, 3, 4, 5].map((n) => upsert({ slug: "race", spec: spec("R", n) })));
    const record = (await h.data("dashboard.get", { companyId: COMPANY, slug: "race" })) as DashboardRecord;
    expect(record.revision).toBe(5);
    const revisions = await rows(`SELECT revision FROM ${DATABASE_NAMESPACE}.dashboard_revisions ORDER BY revision`);
    expect(revisions.map((r) => r.revision)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("limits from settings", () => {
  it("prunes to 20 revisions by default", async () => {
    for (let n = 1; n <= 25; n += 1) {
      await upsert({ slug: "many", spec: spec("M", n) });
    }
    const revisions = await rows(`SELECT revision FROM ${DATABASE_NAMESPACE}.dashboard_revisions ORDER BY revision`);
    expect(revisions).toHaveLength(20);
    expect(revisions[0]?.revision).toBe(6);
    expect(revisions[19]?.revision).toBe(25);
  });

  it("honors maxRevisions from company config", async () => {
    h.config[COMPANY] = { maxRevisions: 3 };
    for (let n = 1; n <= 6; n += 1) {
      await upsert({ slug: "few", spec: spec("F", n) });
    }
    const revisions = await rows(`SELECT revision FROM ${DATABASE_NAMESPACE}.dashboard_revisions ORDER BY revision`);
    expect(revisions.map((r) => r.revision)).toEqual([4, 5, 6]);
  });

  it("honors maxSpecBytes from company config and rejects clearly", async () => {
    const big = spec();
    big.datasets.d!.rows = Array.from({ length: 200 }, (_, i) => ({ name: `row-${i}`, n: i }));
    expect((await upsert({ slug: "big", spec: big })).error).toBeUndefined();
    h.config[COMPANY] = { maxSpecBytes: 2048 };
    const result = await upsert({ slug: "big2", spec: big });
    expect(result.error).toMatch(/spec is \d+ bytes, above the 2048 byte limit/);
    // Settings are per company.
    expect((await upsert({ slug: "big3", spec: big }, { companyId: OTHER_COMPANY, projectId: OTHER_PROJECT })).error).toBeUndefined();
  });

  it("exposes effective settings to the UI", async () => {
    h.config[COMPANY] = { locale: "pt-BR", currency: "brl", maxRevisions: 9999, navLabel: "Painéis" };
    const settings = (await h.data("settings.get", { companyId: COMPANY })) as Record<string, unknown>;
    expect(settings).toMatchObject({ locale: "pt-BR", currency: "BRL", maxRevisions: 200, navLabel: "Painéis", projectTabLabel: "Dashboard" });
    const defaults = (await h.data("settings.get", { companyId: OTHER_COMPANY })) as Record<string, unknown>;
    expect(defaults).toMatchObject({ locale: "en-US", currency: "USD", maxRevisions: 20, maxSpecBytes: 524288 });
  });
});

describe("update_dataset", () => {
  it("refreshes one dataset, stamps updatedAt and revalidates", async () => {
    await upsert({ slug: "ds", spec: spec("DS", 1) });
    const result = await h.tool("update_dataset", { slug: "ds", datasetId: "d", rows: [{ name: "a", n: 42 }], source: "nightly job" });
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("revision 2");
    const record = (await h.data("dashboard.get", { companyId: COMPANY, slug: "ds" })) as DashboardRecord;
    expect(record.spec?.datasets.d?.rows[0]?.n).toBe(42);
    expect(record.spec?.datasets.d?.source).toBe("nightly job");
    expect(Date.parse(record.spec?.datasets.d?.updatedAt ?? "")).toBeGreaterThan(Date.now() - 60_000);
    expect(record.spec?.sections).toEqual(spec().sections);
  });

  it("reports unknown datasets, missing dashboards and rows that break references", async () => {
    await upsert({ slug: "ds", spec: spec() });
    expect((await h.tool("update_dataset", { slug: "ds", datasetId: "zzz", rows: [] })).error).toContain('unknown dataset "zzz" (declared: d)');
    expect((await h.tool("update_dataset", { slug: "nope", datasetId: "d", rows: [] })).error).toBe('Dashboard "nope" not found');
    const broken = await h.tool("update_dataset", { slug: "ds", datasetId: "d", rows: [{ other: 1 }], columns: ["other"] });
    expect(broken.error).toContain("sections[0].blocks[0].items[0].value.field");
    const record = (await h.data("dashboard.get", { companyId: COMPANY, slug: "ds" })) as DashboardRecord;
    expect(record.revision).toBe(1);
  });
});

describe("company isolation", () => {
  it("never exposes or mutates another company's dashboards", async () => {
    await upsert({ slug: "secret", spec: spec("Secret") });
    const record = (await h.data("dashboard.get", { companyId: COMPANY, slug: "secret" })) as DashboardRecord;

    expect(await h.data("dashboard.get", { companyId: OTHER_COMPANY, slug: "secret" })).toBeNull();
    expect(await h.data("dashboard.get", { companyId: OTHER_COMPANY, id: record.id })).toBeNull();
    expect(await h.data("dashboards.list", { companyId: OTHER_COMPANY })).toEqual([]);
    expect(await h.data("dashboard.revisions", { companyId: OTHER_COMPANY, id: record.id })).toEqual([]);

    const other = { companyId: OTHER_COMPANY, projectId: OTHER_PROJECT };
    expect((await h.tool("get_dashboard", { slug: "secret" }, other)).error).toContain("not found");
    expect((await h.tool("update_dataset", { slug: "secret", datasetId: "d", rows: [] }, other)).error).toContain("not found");
    await expect(h.action("dashboard.delete", { id: record.id }, undefined, OTHER_COMPANY)).rejects.toThrow("Dashboard not found");
    await expect(h.action("dashboard.restoreRevision", { id: record.id, revision: 1 }, undefined, OTHER_COMPANY)).rejects.toThrow("Dashboard not found");
    // An upsert under the same slug in company B creates B's own row and leaves A untouched.
    await upsert({ slug: "secret", spec: spec("B copy") }, other);
    const untouched = (await h.data("dashboard.get", { companyId: COMPANY, slug: "secret" })) as DashboardRecord;
    expect(untouched.title).toBe("Secret");
    expect(untouched.revision).toBe(1);
  });

  it("takes the company from the tool run context, not from parameters", async () => {
    const result = await upsert({ slug: "spoof", spec: spec(), companyId: OTHER_COMPANY });
    expect(result.error).toBeUndefined();
    const rowsA = await rows(`SELECT company_id FROM ${DATABASE_NAMESPACE}.dashboards WHERE slug = 'spoof'`);
    expect(rowsA).toEqual([{ company_id: COMPANY }]);
  });
});

describe("board actions", () => {
  it("restores an earlier revision as a new revision with the board actor", async () => {
    await upsert({ slug: "hist", spec: spec("One", 1) });
    await upsert({ slug: "hist", spec: spec("Two", 2) });
    const record = (await h.data("dashboard.get", { companyId: COMPANY, slug: "hist" })) as DashboardRecord;
    const restored = (await h.action("dashboard.restoreRevision", { id: record.id, revision: 1 })) as DashboardRecord;
    expect(restored.revision).toBe(3);
    expect(restored.title).toBe("One");
    expect(restored.spec?.datasets.d?.rows[0]?.n).toBe(1);
    expect(restored.updatedBy).toEqual({ kind: "user", id: "user-1", name: null });
    expect(h.activity.at(-1)?.message).toBe('Restored dashboard "Two" from revision 1');
    await expect(h.action("dashboard.restoreRevision", { id: record.id, revision: 99 })).rejects.toThrow("Revision 99 is not available");
  });

  it("deletes a dashboard and its revisions", async () => {
    await upsert({ slug: "gone", spec: spec() });
    const record = (await h.data("dashboard.get", { companyId: COMPANY, slug: "gone" })) as DashboardRecord;
    await h.action("dashboard.delete", { id: record.id });
    expect(await h.data("dashboard.get", { companyId: COMPANY, slug: "gone" })).toBeNull();
    expect(await rows(`SELECT 1 FROM ${DATABASE_NAMESPACE}.dashboard_revisions`)).toHaveLength(0);
    expect(h.activity.at(-1)?.message).toBe('Deleted dashboard "Demo"');
  });

  it("keeps dashboards company-level when their project is deleted", async () => {
    await upsert({ slug: "orphan", spec: spec() });
    await h.db.exec(`DELETE FROM public.projects WHERE id = '${PROJECT}'`);
    const record = (await h.data("dashboard.get", { companyId: COMPANY, slug: "orphan" })) as DashboardRecord;
    expect(record.projectId).toBeNull();
    expect(record.projectName).toBeNull();
  });
});

describe("read tools", () => {
  it("get_dashboard and list_dashboards return short summaries plus data", async () => {
    await upsert({ slug: "r1", spec: spec("R1") });
    const got = await h.tool("get_dashboard", { slug: "r1" });
    expect(got.content).toBe('Dashboard "r1" revision 1: 1 dataset(s), 1 section(s).');
    const listed = await h.tool("list_dashboards", {});
    expect(listed.content).toContain("- r1 (revision 1, Acme Web App): R1");
    expect((await h.tool("list_dashboards", { projectId: SECOND_PROJECT })).content).toBe("No dashboards yet.");
  });
});

describe("atomic writes", () => {
  const failOn = async (event: "INSERT" | "DELETE") => {
    await h.db.exec(
      `CREATE FUNCTION public.fail_step() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'step failed'; END $$ LANGUAGE plpgsql;
       CREATE TRIGGER fail_step BEFORE ${event} ON ${DATABASE_NAMESPACE}.dashboard_revisions FOR EACH ROW EXECUTE FUNCTION public.fail_step();`,
    );
  };
  const clear = () => h.db.exec(`DROP TRIGGER fail_step ON ${DATABASE_NAMESPACE}.dashboard_revisions`);

  it("a failing revision insert leaves an existing dashboard untouched", async () => {
    await upsert({ slug: "atomic", spec: spec("One", 1) });
    await failOn("INSERT");
    await expect(upsert({ slug: "atomic", spec: spec("Two", 2) })).rejects.toThrow("step failed");
    const record = (await h.data("dashboard.get", { companyId: COMPANY, slug: "atomic" })) as DashboardRecord;
    expect(record.revision).toBe(1);
    expect(record.title).toBe("One");
    expect(record.spec?.datasets.d?.rows[0]?.n).toBe(1);
    expect(await rows(`SELECT revision FROM ${DATABASE_NAMESPACE}.dashboard_revisions`)).toEqual([{ revision: 1 }]);
    expect(h.activity).toHaveLength(1);
    await clear();
    expect((await upsert({ slug: "atomic", spec: spec("Two", 2) })).error).toBeUndefined();
    expect(((await h.data("dashboard.get", { companyId: COMPANY, slug: "atomic" })) as DashboardRecord).revision).toBe(2);
  });

  it("a failing revision insert does not create a dashboard", async () => {
    await failOn("INSERT");
    await expect(upsert({ slug: "fresh", spec: spec() })).rejects.toThrow("step failed");
    expect(await rows(`SELECT 1 FROM ${DATABASE_NAMESPACE}.dashboards`)).toHaveLength(0);
    expect(h.activity).toHaveLength(0);
  });

  it("a failing prune rolls back the dashboard update and the new revision", async () => {
    h.config[COMPANY] = { maxRevisions: 1 };
    await upsert({ slug: "prune", spec: spec("One", 1) });
    await failOn("DELETE");
    await expect(upsert({ slug: "prune", spec: spec("Two", 2) })).rejects.toThrow("step failed");
    const record = (await h.data("dashboard.get", { companyId: COMPANY, slug: "prune" })) as DashboardRecord;
    expect(record.revision).toBe(1);
    expect(await rows(`SELECT revision FROM ${DATABASE_NAMESPACE}.dashboard_revisions`)).toEqual([{ revision: 1 }]);
  });
});

describe("dashboard.setProject", () => {
  const create = async (slug = "mv") => {
    await upsert({ slug, spec: spec("Movable", 1) });
    return (await h.data("dashboard.get", { companyId: COMPANY, slug })) as DashboardRecord;
  };

  it("moves a dashboard, writing a new revision with an unchanged spec and logging activity", async () => {
    const before = await create();
    const moved = (await h.action("dashboard.setProject", { id: before.id, projectId: SECOND_PROJECT })) as DashboardRecord;
    expect(moved).toMatchObject({ projectId: SECOND_PROJECT, projectName: "Internal Tools", projectUrlKey: "internal-tools", orphan: false, revision: 2, title: "Movable" });
    expect(moved.spec).toEqual(before.spec);
    expect(moved.updatedBy).toEqual({ kind: "user", id: "user-1", name: null });
    const revisions = (await h.data("dashboard.revisions", { companyId: COMPANY, id: before.id })) as RevisionSummary[];
    expect(revisions.map((r) => r.revision)).toEqual([2, 1]);
    expect(h.activity.at(-1)?.message).toBe('Moved dashboard "Movable" to project "Internal Tools"');
  });

  it("moves projectless dashboards and is a no-op for the same project", async () => {
    const before = await create("orph");
    await h.db.exec(`DELETE FROM public.projects WHERE id = '${PROJECT}'`);
    const moved = (await h.action("dashboard.setProject", { id: before.id, projectId: SECOND_PROJECT })) as DashboardRecord;
    expect(moved).toMatchObject({ projectId: SECOND_PROJECT, revision: 2 });
    const again = (await h.action("dashboard.setProject", { id: before.id, projectId: SECOND_PROJECT })) as DashboardRecord;
    expect(again.revision).toBe(2);
  });

  it("validates the project and the dashboard and respects company isolation", async () => {
    const before = await create("iso");
    await expect(h.action("dashboard.setProject", { id: before.id, projectId: OTHER_PROJECT })).rejects.toThrow("project_not_found");
    await expect(h.action("dashboard.setProject", { id: before.id, projectId: ARCHIVED_PROJECT })).rejects.toThrow("project_archived");
    await expect(h.action("dashboard.setProject", { id: before.id, projectId: null })).rejects.toThrow("project_required");
    await expect(h.action("dashboard.setProject", { id: before.id, projectId: "nope" })).rejects.toThrow("projectId must be a UUID");
    await expect(h.action("dashboard.setProject", { id: "99999999-9999-4999-8999-999999999999", projectId: SECOND_PROJECT })).rejects.toThrow("Dashboard not found");
    await expect(h.action("dashboard.setProject", { id: before.id, projectId: OTHER_PROJECT }, undefined, OTHER_COMPANY)).rejects.toThrow("Dashboard not found");
    expect(((await h.data("dashboard.get", { companyId: COMPANY, id: before.id })) as DashboardRecord).revision).toBe(1);
  });
});
