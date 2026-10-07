// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  overviewRefresh: vi.fn(),
  detailRefresh: vi.fn(),
  actions: {} as Record<string, ReturnType<typeof vi.fn>>,
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
      data: {
        changeSet: {
          id: "source",
          title: "Source set",
          status: "applied",
          causalityLevel: "observed",
          appliedAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
          itemCount: 0,
          evidenceCount: 0,
          metricCount: 0,
          createdAt: "2026-10-01T00:00:00.000Z",
        },
        items: [],
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

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.overviewRefresh.mockReset().mockResolvedValue(undefined);
  mocks.detailRefresh.mockReset().mockResolvedValue(undefined);
  mocks.actions = {
    "merge-change-set": vi.fn(async () => ({})),
    "add-evidence": vi.fn(async () => ({})),
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
});
