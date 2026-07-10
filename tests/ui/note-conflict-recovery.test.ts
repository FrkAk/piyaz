import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  conflictFields,
  mergeConflictStash,
  resolveNoteConflictDrop,
  resolveNoteConflictReapply,
  type NoteConflictState,
  type NotePendingPatch,
} from "@/components/workspace/notes/note-conflict";
import type { NoteFullResult, NoteTreeRow } from "@/lib/data/note";
import { noteKeys } from "@/lib/query/keys";
import {
  cachedCasToken,
  clearNoteDirty,
  hasUnsavedNoteEdits,
  markNoteDirty,
  notePlaceholderFromRow,
} from "@/lib/query/note-cache";

/**
 * Pins the conflict recovery core `useNoteAutosave` wires to its React
 * state: the stale_write stash accumulation, the drop path (buffer and
 * dirty gate cleared, remote truth refetched), and the re-apply path
 * (fresh CAS baseline installed, exactly the stashed fields re-buffered,
 * a raced second stale_write re-surfacing losslessly).
 */

const PROJECT = "p1";
const NOTE = "n1";
const t0 = new Date("2026-07-01T10:00:00.000Z");
const t1 = new Date("2026-07-01T11:00:00.000Z");

/**
 * Build the fixture tree row.
 * @returns A complete `NoteTreeRow`.
 */
function row(): NoteTreeRow {
  return {
    id: NOTE,
    slug: "slug-n1",
    sequenceNumber: 1,
    title: "Title",
    type: "reference",
    folder: "",
    feedMode: "none",
    summary: "",
    visibility: "team",
    agentWritable: true,
    locked: false,
    updatedAt: t0,
  };
}

/**
 * Seed a QueryClient with the note list and detail caches at `t0`.
 * @returns The seeded client.
 */
function seededClient(): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData(noteKeys.list(PROJECT), [row()]);
  qc.setQueryData(
    noteKeys.detail(PROJECT, NOTE),
    notePlaceholderFromRow(PROJECT, row()),
  );
  return qc;
}

/**
 * Build a conflict state for the fixture note.
 * @param patch - Stashed failed patch.
 * @returns Conflict at version 2 with `t1` as the fresh baseline.
 */
function conflictWith(patch: NotePendingPatch): NoteConflictState {
  return {
    noteId: NOTE,
    currentUpdatedAt: t1.toISOString(),
    currentVersion: 2,
    patch,
  };
}

afterEach(() => {
  clearNoteDirty(NOTE);
});

describe("mergeConflictStash", () => {
  test("accumulates patches across consecutive stale flushes for the same note", () => {
    const first = mergeConflictStash(null, conflictWith({ title: "Local" }));
    const second = mergeConflictStash(first, {
      ...conflictWith({ body: "local body" }),
      currentVersion: 3,
    });
    expect(second.patch).toEqual({ title: "Local", body: "local body" });
    expect(second.currentVersion).toBe(3);
  });

  test("newer stashed fields win over older ones", () => {
    const first = mergeConflictStash(null, conflictWith({ body: "old" }));
    const second = mergeConflictStash(first, conflictWith({ body: "new" }));
    expect(second.patch).toEqual({ body: "new" });
  });

  test("a conflict for a different note replaces the previous stash", () => {
    const first = mergeConflictStash(null, conflictWith({ body: "mine" }));
    const other: NoteConflictState = {
      ...conflictWith({ title: "Other" }),
      noteId: "n2",
    };
    expect(mergeConflictStash(first, other)).toBe(other);
  });
});

describe("conflictFields", () => {
  test("names the stashed fields in render order", () => {
    expect(conflictFields({ title: "t" })).toEqual(["title"]);
    expect(conflictFields({ body: "b" })).toEqual(["body"]);
    expect(conflictFields({ title: "t", body: "b" })).toEqual([
      "title",
      "body",
    ]);
  });
});

describe("resolveNoteConflictDrop", () => {
  test("clears the buffer and dirty gate and invalidates detail and list", () => {
    const qc = seededClient();
    const buffers = new Map<string, NotePendingPatch>([
      [NOTE, { body: "post-conflict commit" }],
    ]);
    markNoteDirty(NOTE);

    resolveNoteConflictDrop(qc, PROJECT, NOTE, buffers);

    expect(buffers.has(NOTE)).toBe(false);
    expect(hasUnsavedNoteEdits(NOTE)).toBe(false);
    expect(
      qc.getQueryState(noteKeys.detail(PROJECT, NOTE))?.isInvalidated,
    ).toBe(true);
    expect(qc.getQueryState(noteKeys.list(PROJECT))?.isInvalidated).toBe(true);
  });
});

describe("resolveNoteConflictReapply", () => {
  test("installs the fresh CAS baseline and re-buffers exactly the stashed fields", () => {
    const qc = seededClient();
    const buffers = new Map<string, NotePendingPatch>();

    resolveNoteConflictReapply(
      qc,
      PROJECT,
      conflictWith({ title: "Local title" }),
      buffers,
    );

    expect(cachedCasToken(qc, PROJECT, NOTE)).toBe(t1.toISOString());
    const detail = qc.getQueryData<NoteFullResult>(
      noteKeys.detail(PROJECT, NOTE),
    );
    expect(detail?.note.version).toBe(2);
    expect(buffers.get(NOTE)).toEqual({ title: "Local title" });
    expect(buffers.get(NOTE)?.body).toBeUndefined();
    expect(hasUnsavedNoteEdits(NOTE)).toBe(true);
  });

  test("newer buffered fields win over the stash", () => {
    const qc = seededClient();
    const buffers = new Map<string, NotePendingPatch>([
      [NOTE, { body: "newer commit" }],
    ]);

    resolveNoteConflictReapply(
      qc,
      PROJECT,
      conflictWith({ body: "stashed body", title: "Stashed title" }),
      buffers,
    );

    expect(buffers.get(NOTE)).toEqual({
      body: "newer commit",
      title: "Stashed title",
    });
  });

  test("a raced second stale_write re-surfaces the conflict with the stash intact", () => {
    const qc = seededClient();
    const buffers = new Map<string, NotePendingPatch>();
    const first = conflictWith({ body: "local body" });

    resolveNoteConflictReapply(qc, PROJECT, first, buffers);
    const reflushed = buffers.get(NOTE);
    expect(reflushed).toEqual({ body: "local body" });

    const raced = mergeConflictStash(null, {
      noteId: NOTE,
      currentUpdatedAt: "2026-07-01T12:00:00.000Z",
      currentVersion: 3,
      patch: reflushed!,
    });
    expect(raced.patch).toEqual({ body: "local body" });
    expect(raced.currentVersion).toBe(3);
  });
});
