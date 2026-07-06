import { test, expect } from "bun:test";
import {
  planFolderMove,
  planFolderRename,
} from "@/components/workspace/notes/note-meta";

/**
 * Pure unit tests for the folder mutation planners. No DB. Pins the
 * no-op, sibling-collision, and move outcomes the tree pane's rename
 * commit and folder drag-and-drop dispatch on.
 */

const folders = ["a", "a/b", "a/b/c", "a/sibling", "root"];

test("planFolderRename no-ops on empty, whitespace, and unchanged names", () => {
  expect(planFolderRename("a/b", "", folders)).toEqual({ kind: "noop" });
  expect(planFolderRename("a/b", "   ", folders)).toEqual({ kind: "noop" });
  expect(planFolderRename("a/b", " / ", folders)).toEqual({ kind: "noop" });
  expect(planFolderRename("a/b", "b", folders)).toEqual({ kind: "noop" });
  expect(planFolderRename("a/b", "  b  ", folders)).toEqual({ kind: "noop" });
});

test("planFolderRename rejects a sibling collision", () => {
  expect(planFolderRename("a/b", "sibling", folders)).toEqual({
    kind: "collision",
    dest: "a/sibling",
  });
  expect(planFolderRename("a", "root", folders)).toEqual({
    kind: "collision",
    dest: "root",
  });
});

test("planFolderRename plans the move with normalized leaf", () => {
  expect(planFolderRename("a/b", "renamed", folders)).toEqual({
    kind: "move",
    destParent: "a",
    leaf: "renamed",
    dest: "a/renamed",
  });
  expect(planFolderRename("root", " Fresh Name ", folders)).toEqual({
    kind: "move",
    destParent: "",
    leaf: "Fresh Name",
    dest: "Fresh Name",
  });
  expect(planFolderRename("root", "x / y", folders)).toEqual({
    kind: "move",
    destParent: "",
    leaf: "x/y",
    dest: "x/y",
  });
});

test("planFolderMove no-ops on self, descendant, and same-parent drops", () => {
  expect(planFolderMove("a/b", "a/b", folders)).toEqual({ kind: "noop" });
  expect(planFolderMove("a/b", "a/b/c", folders)).toEqual({ kind: "noop" });
  expect(planFolderMove("a/b", "a", folders)).toEqual({ kind: "noop" });
  expect(planFolderMove("root", "", folders)).toEqual({ kind: "noop" });
});

test("planFolderMove rejects a move that would merge same-named folders", () => {
  expect(planFolderMove("a/b", "", [...folders, "b"])).toEqual({
    kind: "collision",
    dest: "b",
  });
  expect(planFolderMove("root", "a", ["a", "a/root", "root"])).toEqual({
    kind: "collision",
    dest: "a/root",
  });
});

test("planFolderMove plans the re-parent", () => {
  expect(planFolderMove("a/b", "root", folders)).toEqual({
    kind: "move",
    destParent: "root",
    leaf: "b",
    dest: "root/b",
  });
  expect(planFolderMove("a/sibling", "", folders)).toEqual({
    kind: "move",
    destParent: "",
    leaf: "sibling",
    dest: "sibling",
  });
});
