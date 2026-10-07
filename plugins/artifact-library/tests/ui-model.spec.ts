import { describe, expect, it } from "vitest";
import {
  folderLabel,
  libraryPath,
  readLocation,
  safeLink,
} from "../src/ui/model.js";

describe("shareable Library navigation", () => {
  it("restores an unfiled saved view with search, tags, favorites and list layout", () => {
    const filters = {
      q: "Sample & campaign",
      folderId: null,
      tagId: "tag-a",
      starred: true,
      taskId: "issue-a",
      kind: "image" as const,
    };
    const location = libraryPath(filters, "list", "view-a");
    expect(readLocation(location.slice(location.indexOf("?")))).toEqual({
      filters,
      layout: "list",
      viewId: "view-a",
    });
    expect(readLocation("").filters).not.toHaveProperty("folderId");
  });
  it("ignores unsupported types and does not mistake false favorites for true", () => {
    expect(readLocation("?kind=exe&starred=false&layout=invalid")).toEqual({
      filters: {},
      layout: "grid",
      viewId: undefined,
    });
    expect(libraryPath({ q: undefined, starred: false, kind: "all" })).toBe(
      "/library",
    );
  });
  it("shows the folder hierarchy without looping through corrupt parents", () => {
    expect(
      folderLabel("child", [
        { id: "root", parentId: null, name: "Sample" },
        { id: "child", parentId: "root", name: "Instagram" },
      ]),
    ).toBe("Sample / Instagram");
    expect(
      folderLabel("a", [
        { id: "a", parentId: "b", name: "A" },
        { id: "b", parentId: "a", name: "B" },
      ]),
    ).toBe("B / A");
  });
});

describe("artifact links", () => {
  it("retains authenticated core paths and ordinary external references", () => {
    expect(safeLink("/api/attachments/a/content")).toBe(
      "/api/attachments/a/content",
    );
    expect(safeLink("https://example.org/asset")).toBe(
      "https://example.org/asset",
    );
  });
  it("rejects script links, protocol-relative links and Windows separators", () => {
    for (const link of [
      "javascript:alert(1)",
      "data:text/html,<script>",
      "//evil.example",
      "/\\evil.example",
      "file:///private/file",
    ])
      expect(safeLink(link)).toBeUndefined();
  });
});
