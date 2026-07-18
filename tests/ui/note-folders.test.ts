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

test("normalizeFolderPath returns NFC for NFD input", () => {
  expect(normalizeFolderPath("cafe\u0301")).toBe("caf\u00e9");
  expect(normalizeFolderPath("specs/cafe\u0301/api")).toBe(
    "specs/caf\u00e9/api",
  );
  expect(normalizeFolderPath("cafe\u0301")).toBe(
    normalizeFolderPath("caf\u00e9"),
  );
});

test("folderTree keys NFC and NFD spellings of one folder to a single node", () => {
  const tree = folderTree(
    [normalizeFolderPath("cafe\u0301/menu")],
    [normalizeFolderPath("caf\u00e9")],
  );
  expect(tree).toEqual(["caf\u00e9", "caf\u00e9/menu"]);
});
