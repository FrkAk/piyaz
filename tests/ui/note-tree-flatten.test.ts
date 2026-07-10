import { test, expect } from "bun:test";
import {
  type FlatTreeRow,
  flattenNoteTree,
  groupFoldersByParent,
} from "@/components/workspace/notes/note-meta";
import type { NoteTreeRow } from "@/lib/data/note";

/**
 * Pure unit tests for the tree-flatten helpers backing the virtualized
 * notes tree. No DB. Pins render order (child folders before notes, root
 * notes last), collapse pruning, indent math, key format, and direct-note
 * counts.
 */

/**
 * Minimal note row for flatten tests.
 *
 * @param id - Note id, also the flat-row key.
 * @param folder - Owning folder path (`""` = root).
 * @returns A {@link NoteTreeRow} with placeholder metadata.
 */
function note(id: string, folder: string): NoteTreeRow {
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
  const indent = new Map(rows.map((r) => [r.key, r.indent]));
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
