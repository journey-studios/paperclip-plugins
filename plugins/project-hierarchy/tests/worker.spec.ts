import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectHierarchy, ProjectTree } from "../src/contracts.js";
import { AGENT, COMPANY, OTHER_COMPANY, P, createHarness, type Harness } from "./harness.js";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

const tree = async (companyId = COMPANY) => (await h.data("tree", { companyId })) as ProjectTree;
const hierarchy = async (projectId: string) => (await h.data("project", { companyId: COMPANY, projectId })) as ProjectHierarchy;
const setParent = (projectId: string, parentProjectId: string | null) => h.action("setParent", { projectId, parentProjectId });

describe("setParent action", () => {
  it("nests a project and reports ancestors and children", async () => {
    await setParent(P.api, P.platform);
    await setParent(P.billing, P.api);

    const billing = await hierarchy(P.billing);
    expect(billing.parent?.id).toBe(P.api);
    expect(billing.ancestors.map((node) => node.id)).toEqual([P.platform, P.api]);

    const platform = await hierarchy(P.platform);
    expect(platform.parent).toBeNull();
    expect(platform.children.map((node) => node.id)).toEqual([P.api]);
    expect(platform.descendantCount).toBe(2);
  });

  it("moves a sub-project to another parent and back to top level", async () => {
    await setParent(P.api, P.platform);
    await setParent(P.api, P.growth);
    expect((await hierarchy(P.api)).parent?.id).toBe(P.growth);

    await setParent(P.api, null);
    expect((await hierarchy(P.api)).parent).toBeNull();
    expect((await hierarchy(P.growth)).children).toEqual([]);
  });

  it("rejects a project as its own parent", async () => {
    await expect(setParent(P.api, P.api)).rejects.toMatchObject({ code: "self_parent" });
  });

  it("rejects moving a project under one of its own sub-projects", async () => {
    await setParent(P.api, P.platform);
    await setParent(P.billing, P.api);
    await expect(setParent(P.platform, P.billing)).rejects.toMatchObject({ code: "cycle" });
    expect((await hierarchy(P.platform)).parent).toBeNull();
  });

  it("rejects a parent from another company and an unknown parent", async () => {
    await expect(setParent(P.api, P.foreign)).rejects.toMatchObject({ code: "parent_not_found" });
    await expect(setParent(P.api, "c0000000-0000-4000-8000-000000000009")).rejects.toMatchObject({ code: "parent_not_found" });
  });

  it("rejects an archived parent", async () => {
    await expect(setParent(P.api, P.archived)).rejects.toMatchObject({ code: "parent_archived" });
  });

  it("ignores a companyId in the payload and uses the host-authorized company", async () => {
    await expect(
      h.action("setParent", { companyId: OTHER_COMPANY, projectId: P.api, parentProjectId: P.platform }),
    ).resolves.toMatchObject({ companyId: COMPANY });
    await expect(
      h.action("setParent", { projectId: P.api, parentProjectId: P.platform }, undefined, OTHER_COMPANY),
    ).rejects.toMatchObject({ code: "project_not_found" });
  });

  it("requires an explicit parent value", async () => {
    await expect(h.action("setParent", { projectId: P.api })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("records who moved the project in the activity log", async () => {
    await setParent(P.api, P.platform);
    await setParent(P.api, null);
    expect(h.activity.map((entry) => entry.message)).toEqual([
      'Moved project "Platform API" under "Platform"',
      'Made project "Platform API" top-level',
    ]);
    expect(h.activity[0]).toMatchObject({ companyId: COMPANY, entityId: P.api });
  });

  it("does not log when detaching a project that had no parent", async () => {
    await setParent(P.api, null);
    expect(h.activity).toEqual([]);
  });

  it("serializes concurrent moves so two of them cannot close a cycle together", async () => {
    const results = await Promise.allSettled([setParent(P.api, P.platform), setParent(P.platform, P.api)]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  });
});

describe("tree data", () => {
  it("lists every project of the company with its parent, sorted by name", async () => {
    await setParent(P.api, P.platform);
    const result = await tree();
    expect(result.projects.map((node) => node.name)).toEqual(["Billing", "Growth", "Old Site", "Platform", "Platform API"]);
    expect(result.projects.find((node) => node.id === P.api)?.parentId).toBe(P.platform);
    expect(result.projects.find((node) => node.id === P.archived)?.archived).toBe(true);
  });

  it("never shows another company's projects or links", async () => {
    await setParent(P.api, P.platform);
    expect((await tree(OTHER_COMPANY)).projects.map((node) => node.id)).toEqual([P.foreign]);
  });

  it("promotes sub-projects to top level when their parent is deleted", async () => {
    await setParent(P.api, P.platform);
    await setParent(P.billing, P.api);
    await h.deleteProject(P.api);
    const result = await tree();
    expect(result.projects.find((node) => node.id === P.billing)?.parentId).toBeNull();
    const rows = await h.db.query("SELECT count(*)::int AS n FROM plugin_project_hierarchy_f21f3d006f.project_parents");
    expect(rows.rows).toEqual([{ n: 0 }]);
  });
});

describe("agent tools", () => {
  it("sets a parent and describes the tree", async () => {
    const moved = await h.tool("set_project_parent", { projectId: P.api, parentProjectId: P.platform });
    expect(moved.content).toBe('Project "Platform API" is now under "Platform".');

    const listed = await h.tool("list_project_tree", {});
    expect(listed.content).toContain("- Platform (");
    expect(listed.content).toContain("  - Platform API (");

    const read = await h.tool("get_project_hierarchy", {}, { projectId: P.api });
    expect(read.content).toContain("Platform / Platform API");
  });

  it("returns user-correctable failures as tool errors", async () => {
    const result = await h.tool("set_project_parent", { projectId: P.api, parentProjectId: P.api });
    expect(result.error).toMatch(/^self_parent:/);
  });

  it("attributes tool moves to the agent", async () => {
    await h.tool("set_project_parent", { projectId: P.api, parentProjectId: P.platform });
    const rows = await h.db.query<{ updated_by_kind: string; updated_by_id: string }>(
      "SELECT updated_by_kind, updated_by_id FROM plugin_project_hierarchy_f21f3d006f.project_parents",
    );
    expect(rows.rows).toEqual([{ updated_by_kind: "agent", updated_by_id: AGENT }]);
  });
});

describe("REST routes", () => {
  it("serves the tree and a project's hierarchy with the company echoed", async () => {
    const treeResponse = await h.api("tree");
    expect(treeResponse.status).toBe(200);
    expect(treeResponse.body).toMatchObject({ companyId: COMPANY });

    const projectResponse = await h.api("project-get", { params: { projectId: P.api } });
    expect(projectResponse.body).toMatchObject({ companyId: COMPANY, project: { id: P.api } });
  });

  it("sets and clears a parent", async () => {
    const set = await h.api("project-set-parent", { params: { projectId: P.api }, body: { parentProjectId: P.platform } });
    expect(set).toMatchObject({ status: 200, body: { parent: { id: P.platform } } });

    const cleared = await h.api("project-set-parent", { params: { projectId: P.api }, body: { parentProjectId: null } });
    expect(cleared).toMatchObject({ status: 200, body: { parent: null } });
  });

  it("maps validation failures to client errors", async () => {
    await h.api("project-set-parent", { params: { projectId: P.api }, body: { parentProjectId: P.platform } });
    const cycle = await h.api("project-set-parent", { params: { projectId: P.platform }, body: { parentProjectId: P.api } });
    expect(cycle).toMatchObject({ status: 422, body: { companyId: COMPANY, error: "cycle" } });

    const missing = await h.api("project-get", { params: { projectId: P.foreign } });
    expect(missing).toMatchObject({ status: 404, body: { error: "project_not_found" } });

    const noBody = await h.api("project-set-parent", { params: { projectId: P.api }, body: {} });
    expect(noBody).toMatchObject({ status: 400, body: { error: "invalid_input" } });
  });

  it("attributes REST moves by agents to the agent", async () => {
    await h.api("project-set-parent", {
      params: { projectId: P.api },
      body: { parentProjectId: P.platform },
      actor: { actorType: "agent", actorId: AGENT, agentId: AGENT },
    });
    const rows = await h.db.query<{ updated_by_kind: string }>(
      "SELECT updated_by_kind FROM plugin_project_hierarchy_f21f3d006f.project_parents",
    );
    expect(rows.rows).toEqual([{ updated_by_kind: "agent" }]);
  });
});
