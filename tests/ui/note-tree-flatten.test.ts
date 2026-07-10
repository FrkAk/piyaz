import { test, expect } from "bun:test";
import {
  type FlatTreeRow,
  flattenNoteCategories,
  flattenNoteTree,
  groupFoldersByParent,
  groupNotesByCategory,
  sortNoteRows,
} from "@/components/workspace/notes/note-meta";
import type { NoteTreeRow } from "@/lib/data/note";
import type { NoteType } from "@/lib/types";
import { readNoteGroup, readNoteSort } from "@/lib/ui/note-order";

/**
 * Pure unit tests for the tree-flatten helpers backing the virtualized
 * notes tree. No DB. Pins render order (child folders before notes, root
 * notes last), collapse pruning, indent math, key format, direct-note
 * counts, sort comparators, category grouping, and URL sanitizers.
 */

/**
 * Minimal note row for flatten tests.
 *
 * @param id - Note id, also the flat-row key.
 * @param folder - Owning folder path (`""` = root).
 * @param extra - Optional field overrides (title, type, category, updatedAt).
 * @returns A {@link NoteTreeRow} with placeholder metadata.
 */
function note(
  id: string,
  folder: string,
  extra?: Partial<
    Pick<NoteTreeRow, "title" | "category" | "updatedAt"> & { type: NoteType }
  >,
): NoteTreeRow {
  return {
    id,
    slug: id,
    sequenceNumber: 0,
    title: id,
    type: "reference",
    folder,
    summary: "",
    visibility: "team",
    feedMode: "none",
    agentWritable: true,
    locked: false,
    updatedAt: new Date(0),
    ...extra,
  };
}

/**
 * Group notes by folder path, mirroring the pane's `notesByFolder` memo.
 *
 * @param notes - Note rows in list order.
 * @returns Map from folder path to its direct notes.
 */
function byFolder(notes: NoteTreeRow[]): Map<string, NoteTreeRow[]> {
  const map = new Map<string, NoteTreeRow[]>();
  for (const n of notes) {
    const bucket = map.get(n.folder);
    if (bucket) bucket.push(n);
    else map.set(n.folder, [n]);
  }
  return map;
}

const folders = ["a", "a/b", "a/b/c", "a/z", "root"];

test("groupFoldersByParent groups by parent with roots under the empty key", () => {
  const map = groupFoldersByParent(folders);
  expect(map.get("")).toEqual(["a", "root"]);
  expect(map.get("a")).toEqual(["a/b", "a/z"]);
  expect(map.get("a/b")).toEqual(["a/b/c"]);
  expect(map.get("a/b/c")).toBeUndefined();
});

test("flattenNoteTree emits child folders before notes and root notes last", () => {
  const notes = byFolder([
    note("n-root", ""),
    note("n-a", "a"),
    note("n-ab", "a/b"),
  ]);
  const rows = flattenNoteTree(groupFoldersByParent(folders), notes, new Set());
  expect(rows.map((r) => r.key)).toEqual([
    "folder:a",
    "folder:a/b",
    "folder:a/b/c",
    "n-ab",
    "folder:a/z",
    "n-a",
    "folder:root",
    "n-root",
  ]);
});

test("flattenNoteTree prunes a collapsed subtree to its folder row", () => {
  const notes = byFolder([note("n-a", "a"), note("n-ab", "a/b")]);
  const rows = flattenNoteTree(
    groupFoldersByParent(folders),
    notes,
    new Set(["a"]),
  );
  expect(rows.map((r) => r.key)).toEqual(["folder:a", "folder:root"]);
});

test("flattenNoteTree collapse of a nested folder keeps siblings visible", () => {
  const notes = byFolder([note("n-ab", "a/b"), note("n-az", "a/z")]);
  const rows = flattenNoteTree(
    groupFoldersByParent(folders),
    notes,
    new Set(["a/b"]),
  );
  expect(rows.map((r) => r.key)).toEqual([
    "folder:a",
    "folder:a/b",
    "folder:a/z",
    "n-az",
    "folder:root",
  ]);
});

test("flattenNoteTree indents folders by depth and notes at the parent indent", () => {
  const notes = byFolder([
    note("n-root", ""),
    note("n-ab", "a/b"),
    note("n-abc", "a/b/c"),
  ]);
  const rows = flattenNoteTree(groupFoldersByParent(folders), notes, new Set());
  const indent = new Map(
    rows
      .filter((r): r is Exclude<FlatTreeRow, { kind: "section" }> => {
        return r.kind !== "section";
      })
      .map((r) => [r.key, r.indent]),
  );
  expect(indent.get("folder:a")).toBe(8);
  expect(indent.get("folder:a/b")).toBe(20);
  expect(indent.get("folder:a/b/c")).toBe(32);
  expect(indent.get("n-ab")).toBe(20);
  expect(indent.get("n-abc")).toBe(32);
  expect(indent.get("n-root")).toBe(8);
});

test("flattenNoteTree counts direct notes only and renders empty folders", () => {
  const notes = byFolder([note("n-abc-1", "a/b/c"), note("n-abc-2", "a/b/c")]);
  const rows = flattenNoteTree(groupFoldersByParent(folders), notes, new Set());
  const counts = new Map(
    rows
      .filter((r): r is Extract<FlatTreeRow, { kind: "folder" }> => {
        return r.kind === "folder";
      })
      .map((r) => [r.path, r.noteCount]),
  );
  expect(counts.get("a")).toBe(0);
  expect(counts.get("a/b")).toBe(0);
  expect(counts.get("a/b/c")).toBe(2);
  expect(counts.get("root")).toBe(0);
  expect(counts.size).toBe(5);
});

test("flattenNoteTree keys are unique across folders and notes", () => {
  const notes = byFolder([note("n-1", ""), note("n-2", "a"), note("n-3", "a")]);
  const rows = flattenNoteTree(groupFoldersByParent(folders), notes, new Set());
  const keys = rows.map((r) => r.key);
  expect(new Set(keys).size).toBe(keys.length);
});

test("sortNoteRows title compare is numeric-aware with id tie-break", () => {
  const rows = [
    note("n-2", "", { title: "Note 10" }),
    note("n-3", "", { title: "same" }),
    note("n-1", "", { title: "Note 2" }),
    note("n-0", "", { title: "same" }),
  ];
  const sorted = sortNoteRows(rows, "title");
  expect(sorted.map((r) => r.id)).toEqual(["n-1", "n-2", "n-0", "n-3"]);
  expect(rows.map((r) => r.id)).toEqual(["n-2", "n-3", "n-1", "n-0"]);
});

test("sortNoteRows updated sorts newest first with title tie-break", () => {
  const rows = [
    note("n-old", "", { title: "a", updatedAt: new Date(1000) }),
    note("n-new", "", { title: "z", updatedAt: new Date(3000) }),
    note("n-tie-b", "", { title: "b", updatedAt: new Date(2000) }),
    note("n-tie-a", "", { title: "a", updatedAt: new Date(2000) }),
  ];
  const sorted = sortNoteRows(rows, "updated");
  expect(sorted.map((r) => r.id)).toEqual([
    "n-new",
    "n-tie-a",
    "n-tie-b",
    "n-old",
  ]);
});

test("sortNoteRows type ranks reference, guidance, knowledge with title tie-break", () => {
  const rows = [
    note("n-k", "", { type: "knowledge", title: "k" }),
    note("n-g", "", { type: "guidance", title: "g" }),
    note("n-r2", "", { type: "reference", title: "b" }),
    note("n-r1", "", { type: "reference", title: "a" }),
  ];
  const sorted = sortNoteRows(rows, "type");
  expect(sorted.map((r) => r.id)).toEqual(["n-r1", "n-r2", "n-g", "n-k"]);
});

test("groupNotesByCategory buckets null and undefined as uncategorized, preserving order", () => {
  const rows = [
    note("n-1", "", { category: "Ops" }),
    note("n-2", "", { category: null }),
    note("n-3", "", { category: "Ops" }),
    note("n-4", ""),
  ];
  const map = groupNotesByCategory(rows);
  expect(map.get("Ops")?.map((r) => r.id)).toEqual(["n-1", "n-3"]);
  expect(map.get("__uncategorized__")?.map((r) => r.id)).toEqual([
    "n-2",
    "n-4",
  ]);
});

test("flattenNoteCategories orders sections alphabetically with Uncategorized last", () => {
  const map = groupNotesByCategory([
    note("n-none", ""),
    note("n-z", "", { category: "Zeta" }),
    note("n-a", "", { category: "Alpha" }),
  ]);
  const rows = flattenNoteCategories(map);
  expect(
    rows.map((r) => (r.kind === "section" ? `${r.key}#${r.label}` : r.key)),
  ).toEqual([
    "section:Alpha#Alpha",
    "n-a",
    "section:Zeta#Zeta",
    "n-z",
    "section:__uncategorized__#Uncategorized",
    "n-none",
  ]);
  const sections = rows.filter(
    (r): r is Extract<FlatTreeRow, { kind: "section" }> => {
      return r.kind === "section";
    },
  );
  expect(sections.map((s) => s.noteCount)).toEqual([1, 1, 1]);
});

test("flattenNoteCategories keys stay disjoint from folder keys and note ids", () => {
  const map = groupNotesByCategory([
    note("n-1", "", { category: "Uncategorized" }),
    note("n-2", ""),
  ]);
  const rows = flattenNoteCategories(map);
  const keys = rows.map((r) => r.key);
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys.every((k) => !k.startsWith("folder:"))).toBe(true);
});

test("readNoteSort and readNoteGroup fall back to defaults on unknown tokens", () => {
  expect(readNoteSort("updated")).toBe("updated");
  expect(readNoteSort("type")).toBe("type");
  expect(readNoteSort("bogus")).toBe("title");
  expect(readNoteSort(null)).toBe("title");
  expect(readNoteGroup("category")).toBe("category");
  expect(readNoteGroup("bogus")).toBe("folder");
  expect(readNoteGroup(null)).toBe("folder");
});
