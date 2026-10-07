// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import type { LibraryArtifact } from "../src/contracts.js";
import { LibraryPage } from "../src/ui/index.js";

const host = vi.hoisted(() => ({
  companyId: "11111111-1111-4111-8111-111111111111",
  search: "",
  pages: new Map<string, { artifacts: LibraryArtifact[]; nextCursor: string | null }>(),
  actions: new Map<string, ReturnType<typeof vi.fn>>(),
  refresh: vi.fn(),
}));
vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  useHostLocation: () => ({ search: host.search }),
  useHostNavigation: () => ({ navigate: vi.fn() }),
  usePluginAction: (key: string) => {
    if (!host.actions.has(key)) host.actions.set(key, vi.fn().mockResolvedValue({ ok: true }));
    return host.actions.get(key);
  },
  usePluginData: (_key: string, params: Record<string, unknown>) => ({
    data: {
      companyId: params.companyId,
      queryKey: params.queryKey,
      folders: [{ id: "folder-a", name: "Visuals", parentId: null }],
      tags: [{ id: "tag-a", name: "Campaign", color: "slate" }],
      views: [{ id: "view-a", name: "All saved", filters: {}, layout: "grid" }],
      projects: [],
      agents: [],
      ...host.pages.get(String(params.cursor ?? "")),
    },
    loading: false,
    error: null,
    refresh: host.refresh,
  }),
}));

let root: Root;
let container: HTMLDivElement;
function artifact(id: string, title: string): LibraryArtifact {
  return {
    id, title, source: "document", mediaKind: "document", previewText: null,
    contentType: null, contentPath: null, openPath: null, downloadPath: null,
    issue: { id: "33333333-3333-4333-8333-333333333333", identifier: "ACME-23", title: "Example" },
    project: null, createdByAgent: null, updatedAt: "2026-10-07T12:00:00.000Z", href: "/ACME/issues/ACME-23",
    metadata: { folderId: null, tagIds: [], starred: false },
  };
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label,
  );
  expect(button, `Missing button: ${label}`).toBeTruthy();
  await act(async () => { button!.click(); });
}
async function organize(title: string) {
  const card = [...container.querySelectorAll("article.card")].find(
    (item) => item.querySelector(".card-title")?.textContent === title,
  );
  const button = card?.querySelector(".card-footer button") as HTMLButtonElement;
  expect(button).toBeTruthy();
  await act(async () => { button.click(); });
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host.search = "";
  host.companyId = "11111111-1111-4111-8111-111111111111";
  host.actions.clear();
  host.refresh.mockClear();
  host.pages = new Map([
    ["", { artifacts: [artifact("document:earlier", "Earlier")], nextCursor: "page-2" }],
    ["page-2", { artifacts: [artifact("document:later", "Later")], nextCursor: null }],
  ]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});
async function render() {
  await act(async () => {
    root.render(createElement(LibraryPage, {
      context: { companyId: host.companyId },
    } as PluginPageProps));
  });
}

it("keeps loaded pages and the later artifact inspector after a metadata change", async () => {
  await render();
  await click("Load more artifacts");
  await organize("Later");
  await click("Favorite Later");
  expect(container.querySelectorAll("article.card")).toHaveLength(2);
  expect(container.querySelector('aside[aria-label="Organize Later"]')).toBeTruthy();
  expect(host.actions.get("artifact-update")).toHaveBeenCalledWith({
    artifactId: "document:later", issueId: "33333333-3333-4333-8333-333333333333",
    companyId: host.companyId, starred: true,
  });
  expect(host.refresh).toHaveBeenCalled();

  await organize("Earlier");
  await click("Favorite Earlier");
  expect(container.querySelector('button[aria-label="Unfavorite Earlier"]')).toBeTruthy();
  const folder = container.querySelector("aside select") as HTMLSelectElement;
  await act(async () => {
    folder.value = "folder-a";
    folder.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(folder.value).toBe("folder-a");
  await act(async () => {
    folder.value = "";
    folder.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(folder.value).toBe("");
  const tag = container.querySelector('aside .check:last-of-type input') as HTMLInputElement;
  await act(async () => { tag.click(); });
  expect(tag.checked).toBe(true);
  await act(async () => { tag.click(); });
  expect(tag.checked).toBe(false);
  expect(container.querySelectorAll("article.card")).toHaveLength(2);
  expect(container.querySelector('aside[aria-label="Organize Earlier"]')).toBeTruthy();
  expect(host.pages.get("")!.artifacts[0].metadata).toEqual({ folderId: null, tagIds: [], starred: false });
});

it("keeps the loaded pages when a metadata action fails", async () => {
  await render();
  await click("Load more artifacts");
  await organize("Later");
  host.actions.get("artifact-update")!.mockRejectedValueOnce(new Error("Artifact not found"));
  await click("Favorite Later");
  expect(container.querySelectorAll("article.card")).toHaveLength(2);
  expect(container.querySelector('aside[aria-label="Organize Later"]')).toBeTruthy();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Artifact not found");
  expect(host.refresh).not.toHaveBeenCalled();
});

it("resets pagination after a saved-view mutation", async () => {
  host.search = "?viewId=view-a";
  await render();
  await click("Load more artifacts");
  await organize("Later");
  await click("Update saved view");
  await click("Save");
  expect(host.actions.get("view-save")).toHaveBeenCalled();
  expect(container.querySelectorAll("article.card")).toHaveLength(1);
  expect(container.querySelector('aside[aria-label="Organize Later"]')).toBeNull();
});

it("removes a cached artifact that leaves the active Favorites filter", async () => {
  host.search = "?starred=true";
  host.pages.get("")!.artifacts[0].metadata.starred = true;
  host.pages.get("page-2")!.artifacts[0].metadata.starred = true;
  await render();
  await click("Load more artifacts");
  await organize("Earlier");
  await click("Unfavorite Earlier");
  expect(container.querySelectorAll("article.card")).toHaveLength(1);
  expect(container.querySelector(".card-title")?.textContent).toBe("Later");
});

it.each([
  { search: "?folderId=folder-a", change: "folder" },
  { search: "?tagId=tag-a", change: "tag" },
])("removes cached rows that leave the active $change filter", async ({ search, change }) => {
  host.search = search;
  for (const page of host.pages.values()) {
    for (const item of page.artifacts) {
      item.metadata.folderId = "folder-a";
      item.metadata.tagIds = ["tag-a"];
    }
  }
  await render();
  await click("Load more artifacts");
  await organize("Earlier");
  await act(async () => {
    if (change === "folder") {
      const folder = container.querySelector("aside select") as HTMLSelectElement;
      folder.value = "";
      folder.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      (container.querySelector("aside .check:last-of-type input") as HTMLInputElement).click();
    }
  });
  expect(container.querySelectorAll("article.card")).toHaveLength(1);
  expect(container.querySelector(".card-title")?.textContent).toBe("Later");
});

it.each(["success", "failure"])("ignores an old company's action %s after switching company", async (result) => {
  host.search = "?viewId=view-a";
  await render();
  await click("Update saved view");
  let complete!: () => void;
  host.actions.get("view-save")!.mockImplementationOnce(() => new Promise((resolve, reject) => {
    complete = result === "success"
      ? () => resolve({ ok: true })
      : () => reject(new Error("Previous company's action failed"));
  }));
  await click("Save");
  host.companyId = "22222222-2222-4222-8222-222222222222";
  await render();
  await click("New folder");
  await act(async () => { complete(); });
  expect(container.querySelector('form[aria-label="Create folder"]')).toBeTruthy();
  expect(container.querySelector('[role="status"]')?.textContent).not.toContain("Saved.");
  expect(host.refresh).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("invites continued searching on an empty scan with a continuation cursor", async () => {
  host.pages.set("", { artifacts: [], nextCursor: "page-2" });
  await render();
  expect(container.querySelector("h2")?.textContent).toBe("No matches in recent artifacts");
  expect(container.textContent).toContain("Older artifacts have not been searched yet.");
  expect(container.textContent).not.toContain("No artifacts here yet");
  await click("Load more artifacts");
  expect(container.querySelectorAll("article.card")).toHaveLength(1);
  expect(container.textContent).toContain("Later");
});

it("shows a final empty state only when the scan is exhausted", async () => {
  host.pages.set("", { artifacts: [], nextCursor: null });
  await render();
  expect(container.querySelector("h2")?.textContent).toBe("No artifacts here yet");
  expect(container.textContent).not.toContain("Load more artifacts");
});
