import { describe, expect, it } from "vitest";
import { ancestorIds, descendantIds, flattenTree, wouldCycle } from "../src/tree.js";

const node = (id: string, parentId: string | null = null) => ({ id, parentId });
const shape = (rows: ReturnType<typeof flattenTree>) => rows.map((row) => `${"-".repeat(row.depth)}${row.node.id}:${row.childCount}`);

describe("flattenTree", () => {
  it("nests children under their parent and keeps sibling order", () => {
    const rows = flattenTree([node("a"), node("a2", "a"), node("b"), node("a1", "a"), node("x", "a1")]);
    expect(shape(rows)).toEqual(["a:2", "-a2:0", "-a1:1", "--x:0", "b:0"]);
  });

  it("treats a node whose parent is filtered out as a root", () => {
    expect(shape(flattenTree([node("child", "hidden"), node("other")]))).toEqual(["child:0", "other:0"]);
  });

  it("hides the descendants of collapsed nodes", () => {
    expect(shape(flattenTree([node("a"), node("a1", "a"), node("x", "a1")], new Set(["a"])))).toEqual(["a:1"]);
  });

  it("surfaces nodes caught in a stored cycle", () => {
    const ids = flattenTree([node("x", "y"), node("y", "x"), node("z")]).map((row) => row.node.id).sort();
    expect(ids).toEqual(["x", "y", "z"]);
  });
});

describe("ancestry", () => {
  const parentOf = new Map([
    ["leaf", "mid"],
    ["mid", "root"],
  ]);

  it("lists ancestors from the top down", () => {
    expect(ancestorIds("leaf", parentOf)).toEqual(["root", "mid"]);
    expect(ancestorIds("root", parentOf)).toEqual([]);
  });

  it("detects cycles before they are stored", () => {
    expect(wouldCycle("root", "leaf", parentOf)).toBe(true);
    expect(wouldCycle("root", "root", parentOf)).toBe(true);
    expect(wouldCycle("leaf", "root", parentOf)).toBe(false);
  });

  it("stops on a stored cycle", () => {
    expect(ancestorIds("x", new Map([["x", "y"], ["y", "x"]]))).toEqual(["y"]);
  });

  it("collects descendants at any depth", () => {
    expect([...descendantIds("a", [node("a"), node("a1", "a"), node("x", "a1"), node("b")])].sort()).toEqual(["a1", "x"]);
  });
});
