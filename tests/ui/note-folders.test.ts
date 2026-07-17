import { test, expect } from "bun:test";
import { folderTree, normalizeFolderPath } from "@/lib/ui/note-folders";

test("normalizeFolderPath trims segments and drops empties", () => {
  expect(normalizeFolderPath("  a / b ")).toBe("a/b");
  expect(normalizeFolderPath("/a//b/")).toBe("a/b");
  expect(normalizeFolderPath("")).toBe("");
  expect(normalizeFolderPath("   ")).toBe("");
});

test("folderTree synthesizes ancestors and sorts, excluding root", () => {
  expect(folderTree(["a/b/c"], [])).toEqual(["a", "a/b", "a/b/c"]);
  expect(folderTree([""], [])).toEqual([]);
});

test("folderTree unions note paths with markers and synthesizes both", () => {
  expect(folderTree(["specs/api"], ["drafts/wip"])).toEqual([
    "drafts",
    "drafts/wip",
    "specs",
    "specs/api",
  ]);
});

test("folderTree dedupes overlapping ancestors", () => {
  expect(folderTree(["a/b", "a/c"], ["a"])).toEqual(["a", "a/b", "a/c"]);
});
