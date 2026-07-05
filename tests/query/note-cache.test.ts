import { describe, expect, test } from "bun:test";
import type { NoteSummary, NoteTreeRow } from "@/lib/data/note";
import {
  mergeSummaryIntoDetail,
  notePlaceholderFromRow,
  patchNoteInTree,
  removeNoteFromTree,
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
    title: `Title ${id}`,
    type: "reference",
    folder: "",
    summary: "",
    visibility: "private",
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
    title: "Renamed",
    projectId: "p1",
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
