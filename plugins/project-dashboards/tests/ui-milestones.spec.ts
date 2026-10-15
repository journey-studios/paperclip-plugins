// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import type { MilestoneRecord } from "../src/contracts.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { ProjectMilestonesTab } from "../src/ui/index.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID = "88888888-8888-4888-8888-888888888888";

const host = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: [] as { name: string; args: Record<string, unknown> }[],
  refresh: [] as string[],
  actions: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginData: (name: string, args: Record<string, unknown>) => {
    host.calls.push({ name, args });
    return {
      data: host.data.get(name) ?? null,
      loading: false,
      error: null,
      refresh: () => { host.refresh.push(name); },
    };
  },
  usePluginAction: (name: string) => {
    if (!host.actions.has(name)) host.actions.set(name, vi.fn().mockResolvedValue({}));
    return host.actions.get(name);
  },
}));
const props: PluginDetailTabProps = {
  context: { companyId: COMPANY, entityId: PROJECT, entityType: "project", companyPrefix: "ACME", projectId: PROJECT, userId: null },
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  host.data = new Map();
  host.calls = [];
  host.refresh = [];
  host.actions = new Map();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  host.data.set("settings.get", { ...DEFAULT_SETTINGS, locale: "pt-BR", refreshIntervalSeconds: 0 });
  host.data.set("milestones.projectIssues", []);
  host.data.set("milestones.list", []);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = () => act(() => root.render(createElement(ProjectMilestonesTab, props)));
const text = () => container.textContent ?? "";
const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(name))!;

function milestone(patch: Partial<MilestoneRecord> = {}): MilestoneRecord {
  return {
    id: UUID, companyId: COMPANY, projectId: PROJECT, projectName: "ACME",
    title: "Alpha no iPad", description: "Controle touchscreen", targetDate: "2026-11-20",
    status: "in_progress", criteria: [{ text: "Build no iPad", checked: false }],
    issueIds: [], issues: [], evidence: [], completedAt: null, revision: 3,
    progress: 0, doneIssues: 0, verifiedCriteria: 0, readyToComplete: false,
    blockers: ["Criterion pending"], createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    createdBy: { kind: "user", id: "u1" }, updatedBy: { kind: "user", id: "u1" },
    ...patch,
  };
}

describe("native Milestones project tab", () => {
  it("uses native project-scoped data hooks and renders an empty state", () => {
    render();
    expect(text()).toContain("Marcos do projeto");
    expect(text()).toContain("Ainda não há marcos neste projeto.");
    const requested = host.calls.find((x) => x.name === "milestones.list");
    expect(requested?.args).toEqual({ companyId: COMPANY, projectId: PROJECT });
    expect(host.calls.some((x) => x.name === "milestones.projectIssues")).toBe(true);
  });

  it("shows progress, date, gates and disables completion when not ready", () => {
    host.data.set("milestones.list", [milestone()]);
    render();
    expect(text()).toContain("Alpha no iPad");
    expect(text()).toContain("2026-11-20");
    expect(text()).toContain("Build no iPad");
    expect(text()).toContain("Pendências para concluir");
    expect(button("Concluir marco").disabled).toBe(true);
    expect(container.querySelector("progress")?.getAttribute("value")).toBe("0");
  });

  it("accepts explicit completion only when server reports gates satisfied, with revision", async () => {
    host.data.set("milestones.list", [milestone({
      criteria: [{ text: "Build no iPad", checked: true }],
      evidence: [{ label: "CI", url: "https://example.com/build" }],
      progress: 100, readyToComplete: true, blockers: [],
    })]);
    render();
    await act(async () => { button("Concluir marco").click(); });
    expect(host.actions.get("milestone.update")).toHaveBeenCalledWith({
      companyId: COMPANY, milestoneId: UUID, revision: 3, status: "completed",
    });
    expect(host.refresh).toContain("milestones.list");
  });

  it("escapes unsafe evidence links and preserves readable labels", () => {
    host.data.set("milestones.list", [milestone({
      evidence: [{ label: "Unsafe", url: "javascript:alert(1)" }],
    })]);
    render();
    expect(text()).toContain("Unsafe");
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("renders reopen and historical completion without an edit button", () => {
    host.data.set("milestones.list", [milestone({
      status: "completed", completedAt: "2026-11-20T12:00:00Z", progress: 100,
      criteria: [{ text: "Build no iPad", checked: true }],
      evidence: [{ label: "release", url: "https://example.com" }],
    })]);
    render();
    expect(text()).toContain("Conclusão registrada no Changelog");
    expect(button("Reabrir")).toBeDefined();
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Editar")).toBe(false);
  });
});
