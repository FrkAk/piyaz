import { test, expect } from "bun:test";
import { summarizeFolderDelete } from "@/components/workspace/notes/note-meta";

/**
 * Pure unit tests for the bulk folder-delete partitioner. No DB. Pins
 * the deleted/survivor split, the survivor message format with title
 * truncation, and the all-fail outcome the tree pane's undo push gates
 * on.
 */

const titles: Record<string, string> = {
  n1: "Alpha",
  n2: "Beta",
  n3: "Gamma",
  n4: "Delta",
  n5: "Epsilon",
  n6: "",
};

const titleOf = (id: string) => titles[id] || "Untitled";

const ok = (updatedAt: string) => ({ ok: true as const, data: { updatedAt } });

const fail = { ok: false as const, message: "boom" };

test("all deletes succeeding yields no failure message", () => {
  const summary = summarizeFolderDelete(
    ["n1", "n2"],
    [ok("2026-01-01"), ok("2026-01-02")],
    titleOf,
  );
  expect(summary.failureMessage).toBeNull();
  expect(summary.deleted).toEqual([
    { id: "n1", updatedAt: "2026-01-01" },
    { id: "n2", updatedAt: "2026-01-02" },
  ]);
});

test("mixed results name the survivors and exclude them from deleted", () => {
  const summary = summarizeFolderDelete(
    ["n1", "n2", "n3", "n4"],
    [ok("2026-01-01"), fail, ok("2026-01-03"), fail],
    titleOf,
  );
  expect(summary.failureMessage).toBe(
    "2 of 4 notes could not be deleted: Beta, Delta",
  );
  expect(summary.deleted).toEqual([
    { id: "n1", updatedAt: "2026-01-01" },
    { id: "n3", updatedAt: "2026-01-03" },
  ]);
});

test("a thrown delete (null result) counts as a survivor", () => {
  const summary = summarizeFolderDelete(
    ["n1", "n2"],
    [null, ok("2026-01-02")],
    titleOf,
  );
  expect(summary.failureMessage).toBe(
    "1 of 2 notes could not be deleted: Alpha",
  );
  expect(summary.deleted).toEqual([{ id: "n2", updatedAt: "2026-01-02" }]);
});

test("all deletes failing yields an empty deleted list", () => {
  const summary = summarizeFolderDelete(
    ["n1", "n2", "n3"],
    [fail, null, fail],
    titleOf,
  );
  expect(summary.deleted).toEqual([]);
  expect(summary.failureMessage).toBe(
    "3 of 3 notes could not be deleted: Alpha, Beta, Gamma",
  );
});

test("more than three survivors truncate to the first three titles", () => {
  const summary = summarizeFolderDelete(
    ["n1", "n2", "n3", "n4", "n5"],
    [fail, fail, fail, fail, fail],
    titleOf,
  );
  expect(summary.failureMessage).toBe(
    "5 of 5 notes could not be deleted: Alpha, Beta, Gamma, +2 more",
  );
});

test("an empty title reads as Untitled in the message", () => {
  const summary = summarizeFolderDelete(["n6"], [fail], titleOf);
  expect(summary.failureMessage).toBe(
    "1 of 1 notes could not be deleted: Untitled",
  );
});
