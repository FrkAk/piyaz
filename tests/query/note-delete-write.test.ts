import { describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { NoteFullResult, NoteTreeRow } from "@/lib/data/note";
import { noteKeys } from "@/lib/query/keys";
import {
  clearNoteTrashed,
  enqueueNoteWrite,
  notePlaceholderFromRow,
} from "@/lib/query/note-cache";

/**
 * Cache-level coverage for the delete write flow (`runDeleteNoteWrite`):
 * the CAS token sent to the server and the failure rollback's cache
 * footprint. `@/lib/actions/note` is mocked process-wide: it is a
 * `"use server"` module whose import graph pulls the DB driver and auth
 * stack, and these tests pin client-cache behavior only. The mock records
 * each delete call's `ifUpdatedAt` and returns a scripted result.
 */

let deleteCalls: { noteId: string; ifUpdatedAt?: string }[] = [];
let nextDeleteResult:
  | {
      ok: true;
      data: { id: string; deletedAt: Date; updatedAt: Date };
    }
  | { ok: false; code: "unknown"; message: string };

/**
 * Stub for an action this suite never calls.
 * @returns Never; always throws.
 */
function unexpectedActionCall(): never {
  throw new Error("unexpected action call in note-delete-write tests");
}

mock.module("@/lib/actions/note", () => ({
  approveShareRequestAction: unexpectedActionCall,
  createFolderAction: unexpectedActionCall,
  createNoteAction: unexpectedActionCall,
  declineShareRequestAction: unexpectedActionCall,
  deleteFolderAction: unexpectedActionCall,
  deleteNoteAction: async (noteId: string, ifUpdatedAt?: string) => {
    deleteCalls.push({ noteId, ifUpdatedAt });
    return nextDeleteResult;
  },
  moveFolderAction: unexpectedActionCall,
  moveNoteAction: unexpectedActionCall,
  restoreNoteAction: unexpectedActionCall,
  updateNoteAction: unexpectedActionCall,
}));

const { runDeleteNoteWrite } = await import(
  "@/components/workspace/notes/useNoteMutations"
);

const treeAt = new Date("2026-07-02T08:00:00.000Z");
const freshAt = new Date("2026-07-02T09:00:00.000Z");
const deletedAt = new Date("2026-07-02T10:00:00.000Z");

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
    updatedAt: treeAt,
    ...overrides,
  };
}

/**
 * Build a detail entry whose note carries the given `updatedAt`.
 * @param noteId - Note id.
 * @param updatedAt - The entry's `updatedAt`.
 * @returns A complete `NoteFullResult`.
 */
function detailAt(noteId: string, updatedAt: Date): NoteFullResult {
  const base = notePlaceholderFromRow("p1", row(noteId));
  return { ...base, note: { ...base.note, updatedAt } };
}

describe("runDeleteNoteWrite", () => {
  test("sends the enqueue-time tree-row token when the detail entry is uncached", async () => {
    deleteCalls = [];
    const qc = new QueryClient();
    qc.setQueryData(noteKeys.list("p1"), [row("n1")]);
    nextDeleteResult = {
      ok: true,
      data: { id: "n1", deletedAt, updatedAt: deletedAt },
    };

    const result = await runDeleteNoteWrite(qc, "p1", "n1");

    expect(result.ok).toBe(true);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.ifUpdatedAt).toBe(treeAt.toISOString());
    clearNoteTrashed("n1");
  });

  test("reads the detail token at send time, after a chained-ahead merge", async () => {
    deleteCalls = [];
    const qc = new QueryClient();
    qc.setQueryData(noteKeys.list("p1"), [row("n2")]);
    qc.setQueryData(noteKeys.detail("p1", "n2"), detailAt("n2", treeAt));
    nextDeleteResult = {
      ok: true,
      data: { id: "n2", deletedAt, updatedAt: deletedAt },
    };

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    void enqueueNoteWrite("n2", () => gate);
    const pending = runDeleteNoteWrite(qc, "p1", "n2");
    qc.setQueryData(noteKeys.detail("p1", "n2"), detailAt("n2", freshAt));
    release();

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(deleteCalls[0]?.ifUpdatedAt).toBe(freshAt.toISOString());
    clearNoteTrashed("n2");
  });

  test("a failed delete leaves a concurrently merged detail entry untouched and re-inserts its row", async () => {
    deleteCalls = [];
    const qc = new QueryClient();
    qc.setQueryData(noteKeys.list("p1"), [row("n3")]);
    qc.setQueryData(noteKeys.detail("p1", "n3"), detailAt("n3", treeAt));
    nextDeleteResult = { ok: false, code: "unknown", message: "boom" };

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    void enqueueNoteWrite("n3", () => gate);
    const pending = runDeleteNoteWrite(qc, "p1", "n3");
    const merged = detailAt("n3", freshAt);
    qc.setQueryData(noteKeys.detail("p1", "n3"), merged);
    release();

    const result = await pending;
    expect(result.ok).toBe(false);
    const detail = qc.getQueryData<NoteFullResult>(noteKeys.detail("p1", "n3"));
    expect(detail?.note.updatedAt).toBe(freshAt);
    const rows = qc.getQueryData<NoteTreeRow[]>(noteKeys.list("p1"));
    expect(rows?.some((r) => r.id === "n3")).toBe(true);
  });
});
