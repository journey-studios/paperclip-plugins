// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  overviewRefresh: vi.fn(),
  detailRefresh: vi.fn(),
  actions: {} as Record<string, ReturnType<typeof vi.fn>>,
  detailData: null as Record<string, unknown> | null,
}));

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  useHostLocation: () => ({ pathname: "/evolution", search: "?change=source" }),
  useHostNavigation: () => ({ navigate: mocks.navigate }),
  usePluginAction: (name: string) => mocks.actions[name] ?? vi.fn(async () => ({})),
  usePluginData: (name: string) => {
    if (name === "changes-overview") {
      return {
        data: { changeSets: [], counts: {} },
        loading: false,
        error: null,
        refresh: mocks.overviewRefresh,
      };
    }
    return {
      data: mocks.detailData ?? {
        changeSet: {
          id: "source",
          title: "Source set",
          status: "applied",
          causalityLevel: "observed",
          appliedAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
          itemCount: 4,
          evidenceCount: 0,
          metricCount: 0,
          createdAt: "2026-10-01T00:00:00.000Z",
        },
        items: [
          {
            id: "item-agent",
            entityType: "agent",
            entityId: "agent-1",
            entityName: "Reviewer",
            changeKind: "agent.updated",
            changedKeys: ["model"],
            sourceType: "agent_config_revision",
            occurredAt: "2026-10-01T00:30:00.000Z",
          },
          {
            id: "item-skill",
            entityType: "skill",
            entityId: "skill-1",
            entityName: "Research",
            changeKind: "company.skill_version_created",
            changedKeys: ["files"],
            sourceType: "company_skill_version",
            occurredAt: "2026-10-01T00:45:00.000Z",
          },
          {
            id: "item-skill-audit",
            entityType: "skill",
            entityId: "skill-1",
            entityName: "Research",
            changeKind: "company.skills_synced",
            changedKeys: ["revisionNumber"],
            sourceType: "activity",
            sourceActivityId: "audit-1",
            occurredAt: "2026-10-01T00:45:01.000Z",
          },
          {
            id: "item-plugin-event",
            entityType: "agent",
            entityId: "agent-2",
            entityName: "Agent lifecycle",
            changeKind: "agent.created",
            changedKeys: [],
            sourceType: "plugin_event",
            occurredAt: "2026-10-01T00:45:02.000Z",
          },
        ],
        evidence: [],
        metrics: [],
        conclusions: [],
        links: [],
        suggestedRuns: [{
          id: "run-1",
          agentId: "agent-1",
          agentName: "Reviewer",
          status: "succeeded",
          startedAt: "2026-10-01T01:00:00.000Z",
          finishedAt: "2026-10-01T01:01:00.000Z",
        }],
      },
      loading: false,
      error: null,
      refresh: mocks.detailRefresh,
    };
  },
}));

import { EvolutionPage } from "./page.js";

let root: Root;

async function renderPage() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<EvolutionPage context={{ companyId: "company-1" } as never} />);
  });
  return container;
}

function clickButton(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Button not found: ${label}`);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.overviewRefresh.mockReset().mockResolvedValue(undefined);
  mocks.detailRefresh.mockReset().mockResolvedValue(undefined);
  mocks.detailData = null;
  mocks.actions = {
    "merge-change-set": vi.fn(async () => ({})),
    "move-selected-change-items": vi.fn(async () => ({ ok: true, movedCount: 1, alreadyTargetCount: 0 })),
    "add-evidence": vi.fn(async () => ({})),
    "create-change-set": vi.fn(async () => ({ id: "created-set" })),
  };
  vi.spyOn(window, "prompt").mockReturnValue("target-set");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("Evolution detail actions", () => {
  it("waits for overview refresh before navigating after a merge", async () => {
    let resolveRefresh!: () => void;
    mocks.overviewRefresh.mockImplementation(() => new Promise<void>((resolve) => { resolveRefresh = resolve; }));
    const container = await renderPage();

    await act(async () => {
      clickButton(container, "Merge into");
      await Promise.resolve();
    });

    expect(mocks.overviewRefresh).toHaveBeenCalledOnce();
    expect(mocks.navigate).not.toHaveBeenCalled();

    await act(async () => {
      resolveRefresh();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.navigate).toHaveBeenCalledWith("/evolution?change=target-set");
  });

  it("navigates after merge even when overview refresh rejects", async () => {
    mocks.overviewRefresh.mockRejectedValue(new Error("refresh unavailable"));
    const container = await renderPage();

    await act(async () => {
      clickButton(container, "Merge into");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.navigate).toHaveBeenCalledWith("/evolution?change=target-set");
    expect(container.textContent).toContain("Merged successfully, but the overview could not refresh");
  });

  it("does not create evidence when attaching a candidate run is cancelled", async () => {
    vi.spyOn(window, "prompt").mockReturnValueOnce(null);
    const container = await renderPage();

    await act(async () => clickButton(container, "Attach"));
    expect(mocks.actions["add-evidence"]).not.toHaveBeenCalled();
  });

  it("labels each timeline record by source, including a separate version and Audit activity", async () => {
    const container = await renderPage();
    expect(container.textContent).toContain("Native Agent revision");
    expect(container.textContent).toContain("Native Skill version");
    expect(container.textContent).toContain("Audit activity");
    expect(container.textContent).toContain("Plugin event");
    expect(container.textContent).toContain("One edit can appear as a native version and a separate Audit activity");
    expect(container.textContent).toContain("Rows count captured Change Items, not distinct edits.");
    expect(container.textContent).toContain("Audit audit-1");
  });

  it("routes only selected timeline item IDs to the move action and opens the target after refresh", async () => {
    const container = await renderPage();

    await act(async () => {
      container.querySelector<HTMLInputElement>('input[aria-label="Select change Reviewer"]')?.click();
    });
    await act(async () => {
      clickButton(container, "Move selected items");
    });
    expect(container.textContent).toContain("1 selected");

    await act(async () => {
      const target = container.querySelector<HTMLInputElement>('input[aria-label="Target Change Set ID"]');
      if (!target) throw new Error("Target Change Set ID input not found");
      setInputValue(target, "target-set");
      const form = target.closest("form");
      if (!form) throw new Error("Move form not found");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.actions["move-selected-change-items"]).toHaveBeenCalledWith({
      companyId: "company-1",
      sourceChangeSetId: "source",
      targetChangeSetId: "target-set",
      changeItemIds: ["item-agent"],
    });
    expect(mocks.detailRefresh).toHaveBeenCalledOnce();
    expect(mocks.overviewRefresh).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledWith("/evolution?change=target-set");
  });

  it("cancels selected-item move without mutating", async () => {
    const container = await renderPage();
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[aria-label="Select change Reviewer"]')?.click();
    });
    await act(async () => {
      clickButton(container, "Move selected items");
    });
    await act(async () => {
      clickButton(container, "Cancel");
    });

    expect(mocks.actions["move-selected-change-items"]).not.toHaveBeenCalled();
    expect(container.textContent).toContain("1 selected");
  });

  it("clears the selection and navigates when a moved source view cannot refresh", async () => {
    mocks.detailRefresh.mockRejectedValue(new Error("source Change Set no longer exists"));
    const container = await renderPage();
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Select change Reviewer"]')?.click());
    await act(async () => clickButton(container, "Move selected items"));
    await act(async () => {
      const target = container.querySelector<HTMLInputElement>('input[aria-label="Target Change Set ID"]');
      if (!target) throw new Error("Target Change Set ID input not found");
      setInputValue(target, "target-set");
      const form = target.closest("form");
      if (!form) throw new Error("Move form not found");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.navigate).toHaveBeenCalledWith("/evolution?change=target-set");
    expect(container.textContent).not.toContain("1 selected");
    expect(container.textContent).toContain("Items moved successfully, but the view could not refresh");
  });

  it("creates a Change Set from the inline form and navigates to it", async () => {
    const container = await renderPage();
    await act(async () => clickButton(container, "New Change Set"));
    await act(async () => {
      const title = container.querySelector<HTMLInputElement>('input[aria-label="Change Set title"]');
      if (!title) throw new Error("Change Set title input not found");
      setInputValue(title, "Improve research quality");
      const hypothesis = container.querySelector<HTMLInputElement>('input[aria-label="Expected improvement hypothesis"]');
      if (!hypothesis) throw new Error("Hypothesis input not found");
      setInputValue(hypothesis, "More relevant evidence per run");
      const form = title.closest("form");
      if (!form) throw new Error("Create form not found");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.actions["create-change-set"]).toHaveBeenCalledWith({
      companyId: "company-1",
      title: "Improve research quality",
      hypothesis: "More relevant evidence per run",
      status: "draft",
      causalityLevel: "observed",
    });
    expect(mocks.navigate).toHaveBeenCalledWith("/evolution?change=created-set");
  });
});
