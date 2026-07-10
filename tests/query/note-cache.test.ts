import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type {
  NoteLinksRefresh,
  NoteSummary,
  NoteTreeRow,
} from "@/lib/data/note";
import { noteKeys } from "@/lib/query/keys";
import {
  cachedCasToken,
  clearNoteDirty,
  clearNoteTrashed,
  hasUnsavedNoteEdits,
  isNoteTrashed,
  markNoteDirty,
  markNoteTrashed,
  mergeLinksIntoDetail,
  mergeSummaryIntoDetail,
  moveFolderInTree,
  notePlaceholderFromRow,
  patchNoteInTree,
  removeNoteFromTree,
  revertPatchInTree,
  revertPatchOnDetail,
  upsertNoteInTree,
} from "@/lib/query/note-cache";

/**
 * Pure unit tests for the note cache transforms. No DB. Pins the
 * same-reference-when-unchanged contracts the optimistic mutation hooks
 * rely on, the placeholder fabrication invariants, and the CAS-token
 * refresh in `mergeSummaryIntoDetail`.
 */

const when = new Date("2026-07-01T10:00:00.000Z");

/**
 * Build a tree row with overridable fields.
 * @param id - Row id.
 * @param overrides - Fields to overwrite on the base row.
 * @returns A complete `NoteTreeRow`.
 */
function row(id: string, overrides: Partial<NoteTreeRow> = {}): NoteTreeRow {
  return {
    id,
    slug: `slug-${id}`,
    sequenceNumber: 1,
    title: `Title ${id}`,
    type: "reference",
    folder: "",
    summary: "",
    visibility: "private",
    feedMode: "none",
    agentWritable: false,
    locked: false,
    updatedAt: when,
    ...overrides,
  };
}

describe("notePlaceholderFromRow", () => {
  test("copies tree fields and fabricates empty body and link context", () => {
    const source = row("n1", {
      folder: "specs",
      summary: "a summary",
      visibility: "team",
      agentWritable: true,
      locked: true,
    });
    const out = notePlaceholderFromRow("p1", source);

    expect(out.note.id).toBe("n1");
    expect(out.note.projectId).toBe("p1");
    expect(out.note.slug).toBe("slug-n1");
    expect(out.note.title).toBe("Title n1");
    expect(out.note.folder).toBe("specs");
    expect(out.note.summary).toBe("a summary");
    expect(out.note.visibility).toBe("team");
    expect(out.note.agentWritable).toBe(true);
    expect(out.note.locked).toBe(true);
    expect(out.note.updatedAt).toBe(when);

    expect(out.note.body).toBe("");
    expect(out.note.tags).toEqual([]);
    expect(out.note.category).toBeNull();
    expect(out.note.shareRequestedBy).toBeNull();
    expect(out.note.deletedAt).toBeNull();
    expect(out.mentions).toEqual([]);
    expect(out.linksOut).toEqual([]);
    expect(out.linksIn).toEqual([]);
  });
});

describe("upsertNoteInTree", () => {
  test("appends a new row", () => {
    const rows = [row("a")];
    const out = upsertNoteInTree(rows, row("b"));
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows).toHaveLength(1);
  });

  test("replaces an existing row in place", () => {
    const rows = [row("a"), row("b")];
    const out = upsertNoteInTree(rows, row("a", { title: "Renamed" }));
    expect(out[0]?.title).toBe("Renamed");
    expect(out[1]).toBe(rows[1]!);
    expect(out).not.toBe(rows);
  });

  test("returns the same reference when the row is field-equal", () => {
    const rows = [row("a")];
    expect(upsertNoteInTree(rows, row("a"))).toBe(rows);
  });

  test("starts a list when the cache is empty", () => {
    expect(upsertNoteInTree(undefined, row("a")).map((r) => r.id)).toEqual([
      "a",
    ]);
  });
});

describe("patchNoteInTree", () => {
  test("applies defined patch fields to the matching row", () => {
    const rows = [row("a"), row("b")];
    const out = patchNoteInTree(rows, "b", { folder: "moved", locked: true });
    expect(out?.[1]?.folder).toBe("moved");
    expect(out?.[1]?.locked).toBe(true);
    expect(out?.[1]?.title).toBe("Title b");
    expect(out?.[0]).toBe(rows[0]!);
  });

  test("returns the same reference when the row is absent", () => {
    const rows = [row("a")];
    expect(patchNoteInTree(rows, "zzz", { folder: "x" })).toBe(rows);
  });

  test("returns the same reference when every patched value is equal", () => {
    const rows = [row("a", { folder: "specs" })];
    expect(patchNoteInTree(rows, "a", { folder: "specs" })).toBe(rows);
  });

  test("skips undefined patch values", () => {
    const rows = [row("a")];
    expect(patchNoteInTree(rows, "a", { folder: undefined })).toBe(rows);
  });

  test("keeps existing fields when a mixed patch carries undefined values", () => {
    const rows = [row("a", { type: "guidance", locked: true })];
    const out = patchNoteInTree(rows, "a", {
      title: "Renamed",
      type: undefined,
      locked: undefined,
    });
    expect(out?.[0]?.title).toBe("Renamed");
    expect(out?.[0]?.type).toBe("guidance");
    expect(out?.[0]?.locked).toBe(true);
  });

  test("passes undefined through", () => {
    expect(patchNoteInTree(undefined, "a", { folder: "x" })).toBeUndefined();
  });
});

describe("removeNoteFromTree", () => {
  test("drops the matching row", () => {
    const rows = [row("a"), row("b")];
    expect(removeNoteFromTree(rows, "a")?.map((r) => r.id)).toEqual(["b"]);
  });

  test("returns the same reference when absent", () => {
    const rows = [row("a")];
    expect(removeNoteFromTree(rows, "zzz")).toBe(rows);
  });

  test("passes undefined through", () => {
    expect(removeNoteFromTree(undefined, "a")).toBeUndefined();
  });
});

describe("mergeSummaryIntoDetail", () => {
  const summary: NoteSummary = {
    id: "n1",
    slug: "slug-n1-2",
    sequenceNumber: 1,
    title: "Renamed",
    projectId: "p1",
    projectIdentifier: "P1",
    folder: "specs",
    version: 3,
    updatedAt: new Date("2026-07-01T11:00:00.000Z"),
  };

  test("folds the write result so the next CAS token is fresh", () => {
    const detail = notePlaceholderFromRow("p1", row("n1"));
    const out = mergeSummaryIntoDetail(detail, summary);
    expect(out?.note.slug).toBe("slug-n1-2");
    expect(out?.note.title).toBe("Renamed");
    expect(out?.note.folder).toBe("specs");
    expect(out?.note.version).toBe(3);
    expect(out?.note.updatedAt).toBe(summary.updatedAt);
    expect(out?.note.body).toBe(detail.note.body);
    expect(out?.mentions).toBe(detail.mentions);
  });

  test("returns the same reference when every summary field is equal", () => {
    const detail = mergeSummaryIntoDetail(
      notePlaceholderFromRow("p1", row("n1")),
      summary,
    );
    expect(mergeSummaryIntoDetail(detail, summary)).toBe(detail!);
  });

  test("ignores a summary for a different note", () => {
    const detail = notePlaceholderFromRow("p1", row("other"));
    expect(mergeSummaryIntoDetail(detail, summary)).toBe(detail);
  });

  test("passes undefined through", () => {
    expect(mergeSummaryIntoDetail(undefined, summary)).toBeUndefined();
  });
});

describe("mergeLinksIntoDetail", () => {
  const links: NoteLinksRefresh = {
    mentions: [
      {
        taskId: "t1",
        kind: "mention",
        taskRef: "PRJ-1",
        status: "planned",
        title: "Task one",
      },
    ],
    linksOut: [
      {
        id: "n2",
        slug: "slug-n2",
        sequenceNumber: 2,
        title: "Other note",
        type: "reference",
        folder: "",
        updatedAt: when,
      },
    ],
  };

  test("folds mentions and linksOut, leaves linksIn untouched", () => {
    const detail = notePlaceholderFromRow("p1", row("n1"));
    const out = mergeLinksIntoDetail(detail, links);
    expect(out?.mentions).toBe(links.mentions);
    expect(out?.linksOut).toBe(links.linksOut);
    expect(out?.linksIn).toBe(detail.linksIn);
  });

  test("returns the same reference when the lists already match", () => {
    const detail = mergeLinksIntoDetail(
      notePlaceholderFromRow("p1", row("n1")),
      links,
    );
    const again: NoteLinksRefresh = {
      mentions: [{ ...links.mentions[0]! }],
      linksOut: [{ ...links.linksOut[0]! }],
    };
    expect(mergeLinksIntoDetail(detail, again)).toBe(detail!);
  });

  test("passes undefined links and detail through", () => {
    const detail = notePlaceholderFromRow("p1", row("n1"));
    expect(mergeLinksIntoDetail(detail, undefined)).toBe(detail);
    expect(mergeLinksIntoDetail(undefined, links)).toBeUndefined();
  });
});

describe("revertPatchOnDetail", () => {
  test("restores a field still holding the optimistic value", () => {
    const detail = notePlaceholderFromRow("p1", row("n1"));
    const optimistic = { ...detail, note: { ...detail.note, category: "ui" } };
    const out = revertPatchOnDetail(
      optimistic,
      { category: "ui" },
      { category: null },
    );
    expect(out?.note.category).toBeNull();
  });

  test("never clobbers a newer optimistic value on the same field", () => {
    const detail = notePlaceholderFromRow("p1", row("n1"));
    const newer = { ...detail, note: { ...detail.note, category: "newer" } };
    const out = revertPatchOnDetail(
      newer,
      { category: "older" },
      { category: null },
    );
    expect(out).toBe(newer);
  });

  test("compares arrays by reference", () => {
    const tags = ["a", "b"];
    const detail = notePlaceholderFromRow("p1", row("n1"));
    const optimistic = { ...detail, note: { ...detail.note, tags } };
    const prevTags = detail.note.tags;
    const out = revertPatchOnDetail(optimistic, { tags }, { tags: prevTags });
    expect(out?.note.tags).toBe(prevTags);
  });

  test("passes undefined through", () => {
    expect(
      revertPatchOnDetail(undefined, { category: "x" }, { category: null }),
    ).toBeUndefined();
  });

  test("skips fields with no captured previous value", () => {
    const detail = notePlaceholderFromRow("p1", row("n1"));
    const optimistic = { ...detail, note: { ...detail.note, category: "ui" } };
    expect(revertPatchOnDetail(optimistic, { category: "ui" }, {})).toBe(
      optimistic,
    );
  });
});

describe("revertPatchInTree", () => {
  test("restores a row field still holding the optimistic value", () => {
    const rows = [row("n1", { visibility: "team" })];
    const out = revertPatchInTree(
      rows,
      "n1",
      { visibility: "team" },
      { visibility: "private" },
    );
    expect(out?.[0]?.visibility).toBe("private");
  });

  test("skips a field overwritten by a newer optimistic value", () => {
    const rows = [row("n1", { title: "newest" })];
    const out = revertPatchInTree(
      rows,
      "n1",
      { title: "older-optimistic" },
      { title: "original" },
    );
    expect(out).toBe(rows);
  });

  test("returns the same reference when the row is absent", () => {
    const rows = [row("n1")];
    expect(
      revertPatchInTree(rows, "missing", { title: "x" }, { title: "y" }),
    ).toBe(rows);
  });

  test("skips fields with no captured previous value", () => {
    const rows = [row("n1", { title: "optimistic" })];
    expect(revertPatchInTree(rows, "n1", { title: "optimistic" }, {})).toBe(
      rows,
    );
  });
});

describe("dirty note registry", () => {
  test("marks, reports, and clears unsaved-content ids", () => {
    expect(hasUnsavedNoteEdits("d1")).toBe(false);
    markNoteDirty("d1");
    expect(hasUnsavedNoteEdits("d1")).toBe(true);
    expect(hasUnsavedNoteEdits("d2")).toBe(false);
    clearNoteDirty("d1");
    expect(hasUnsavedNoteEdits("d1")).toBe(false);
  });
});

describe("trashed note registry", () => {
  test("marks, reports, and clears trashed ids independently", () => {
    expect(isNoteTrashed("t1")).toBe(false);
    markNoteTrashed("t1");
    expect(isNoteTrashed("t1")).toBe(true);
    expect(isNoteTrashed("t2")).toBe(false);
    clearNoteTrashed("t1");
    expect(isNoteTrashed("t1")).toBe(false);
  });
});

describe("cachedCasToken", () => {
  const detailAt = new Date("2026-07-02T09:00:00.000Z");
  const treeAt = new Date("2026-07-02T08:00:00.000Z");

  test("prefers the cached detail entry's updatedAt", () => {
    const qc = new QueryClient();
    const detail = notePlaceholderFromRow("p1", row("n1"));
    qc.setQueryData(noteKeys.detail("p1", "n1"), {
      ...detail,
      note: { ...detail.note, updatedAt: detailAt },
    });
    qc.setQueryData(noteKeys.list("p1"), [row("n1", { updatedAt: treeAt })]);
    expect(cachedCasToken(qc, "p1", "n1")).toBe(detailAt.toISOString());
  });

  test("falls back to the cached tree row when the detail entry is absent", () => {
    const qc = new QueryClient();
    qc.setQueryData(noteKeys.list("p1"), [row("n1", { updatedAt: treeAt })]);
    expect(cachedCasToken(qc, "p1", "n1")).toBe(treeAt.toISOString());
  });

  test("returns undefined only when neither cache holds the note", () => {
    const qc = new QueryClient();
    qc.setQueryData(noteKeys.list("p1"), [row("other")]);
    expect(cachedCasToken(qc, "p1", "n1")).toBeUndefined();
  });
});

describe("field-scoped list rollback (F7)", () => {
  test("move rollback via revertPatchInTree keeps a concurrent sibling patch", () => {
    const seeded = [row("a", { folder: "src" }), row("b")];
    const optimisticA = patchNoteInTree(seeded, "a", { folder: "dest" });
    const siblingB = patchNoteInTree(optimisticA, "b", { title: "B edited" });
    const rolledBack = revertPatchInTree(
      siblingB,
      "a",
      { folder: "dest" },
      { folder: "src" },
    );
    expect(rolledBack?.find((r) => r.id === "a")?.folder).toBe("src");
    expect(rolledBack?.find((r) => r.id === "b")?.title).toBe("B edited");
  });

  test("delete rollback re-inserts only its own captured row", () => {
    const prevRowA = row("a", { title: "A original" });
    const seeded = [prevRowA, row("b")];
    const removed = removeNoteFromTree(seeded, "a");
    const siblingB = patchNoteInTree(removed, "b", { title: "B edited" });
    const rolledBack = upsertNoteInTree(siblingB, prevRowA);
    expect(rolledBack.find((r) => r.id === "a")?.title).toBe("A original");
    expect(rolledBack.find((r) => r.id === "b")?.title).toBe("B edited");
  });

  test("create rollback removes only its temp row", () => {
    const seeded = [row("b")];
    const withTemp = upsertNoteInTree(seeded, row("temp-1"));
    const siblingB = patchNoteInTree(withTemp, "b", { title: "B edited" });
    const rolledBack = removeNoteFromTree(siblingB, "temp-1");
    expect(rolledBack?.some((r) => r.id === "temp-1")).toBe(false);
    expect(rolledBack?.find((r) => r.id === "b")?.title).toBe("B edited");
  });
});

describe("field-scoped revert never resurrects unpersisted values (F3)", () => {
  test("tree revert skips a field a newer optimistic write replaced", () => {
    const seeded = [row("a", { folder: "src" })];
    const olderOptimistic = patchNoteInTree(seeded, "a", { folder: "older" });
    const newerOptimistic = patchNoteInTree(olderOptimistic, "a", {
      folder: "newer",
    });
    const out = revertPatchInTree(
      newerOptimistic,
      "a",
      { folder: "older" },
      { folder: "src" },
    );
    expect(out?.find((r) => r.id === "a")?.folder).toBe("newer");
  });

  test("detail revert skips a field a newer optimistic write replaced", () => {
    const detail = notePlaceholderFromRow("p1", row("n1"));
    const newer = { ...detail, note: { ...detail.note, folder: "newer" } };
    const out = revertPatchOnDetail(newer, { folder: "older" }, { folder: "" });
    expect(out?.note.folder).toBe("newer");
  });
});

describe("moveFolderInTree", () => {
  test("rewrites the folder and every descendant path", () => {
    const rows = [
      row("n1", { folder: "a" }),
      row("n2", { folder: "a/b" }),
      row("n3", { folder: "other" }),
    ];
    const next = moveFolderInTree(rows, "a", "x/a");
    expect(next?.map((r) => r.folder)).toEqual(["x/a", "x/a/b", "other"]);
  });

  test("never rewrites a sibling sharing the prefix", () => {
    const rows = [row("n1", { folder: "a" }), row("n2", { folder: "ab" })];
    const next = moveFolderInTree(rows, "a", "x");
    expect(next?.map((r) => r.folder)).toEqual(["x", "ab"]);
  });

  test("returns the same reference when no row is under the source", () => {
    const rows = [row("n1", { folder: "other" })];
    expect(moveFolderInTree(rows, "a", "x")).toBe(rows);
  });

  test("passes undefined through when the list is not cached", () => {
    expect(moveFolderInTree(undefined, "a", "x")).toBeUndefined();
  });

  test("keeps untouched rows reference-equal", () => {
    const rows = [row("n1", { folder: "a" }), row("n2", { folder: "other" })];
    const next = moveFolderInTree(rows, "a", "x");
    expect(next?.[1]).toBe(rows[1]);
  });
});
