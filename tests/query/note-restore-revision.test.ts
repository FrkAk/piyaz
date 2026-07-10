import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { NoteTreeRow } from "@/lib/data/note";
import { noteKeys } from "@/lib/query/keys";
import { notePlaceholderFromRow } from "@/lib/query/note-cache";

/**
 * Cache-level coverage for the revision-restore write flow
 * (`runRestoreRevisionWrite`): the send-time CAS token and the
 * invalidation footprint per outcome. `@/lib/actions/note` is mocked
 * process-wide for the same reason as the delete-write suite: it is a
 * `"use server"` module whose import graph pulls the DB driver and auth
 * stack, and these tests pin client-cache behavior only.
 */

let restoreCalls: { noteId: string; version: number; ifUpdatedAt?: string }[] =
  [];
let nextRestoreResult:
  | { ok: true; data: Record<string, unknown> }
  | {
      ok: false;
      code: "stale_write";
      message: string;
      currentUpdatedAt: string;
      currentVersion: number;
    }
  | { ok: false; code: "validation"; field: string; message: string };

/**
 * Stub for an action this suite never calls.
 * @returns Never; always throws.
 */
function unexpectedActionCall(): never {
  throw new Error("unexpected action call in note-restore-revision tests");
}

mock.module("@/lib/actions/note", () => ({
  approveShareRequestAction: unexpectedActionCall,
  createFolderAction: unexpectedActionCall,
  createNoteAction: unexpectedActionCall,
  declineShareRequestAction: unexpectedActionCall,
  deleteFolderAction: unexpectedActionCall,
  deleteNoteAction: unexpectedActionCall,
  moveFolderAction: unexpectedActionCall,
  moveNoteAction: unexpectedActionCall,
  restoreNoteAction: unexpectedActionCall,
  restoreRevisionAction: async (
    noteId: string,
    version: number,
    ifUpdatedAt?: string,
  ) => {
    restoreCalls.push({ noteId, version, ifUpdatedAt });
    return nextRestoreResult;
  },
  updateNoteAction: unexpectedActionCall,
}));

const { runRestoreRevisionWrite } = await import(
  "@/components/workspace/notes/useNoteMutations"
);

const PROJECT = "p1";
const NOTE = "n1";
const treeAt = new Date("2026-07-02T08:00:00.000Z");

/**
 * Build a tree row for the fixture note.
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
    updatedAt: treeAt,
  };
}

/**
 * Seed a QueryClient with detail, list, events, and revisions caches.
 * @returns The seeded client.
 */
function seededClient(): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData(noteKeys.list(PROJECT), [row()]);
  qc.setQueryData(
    noteKeys.detail(PROJECT, NOTE),
    notePlaceholderFromRow(PROJECT, row()),
  );
  qc.setQueryData(noteKeys.events(PROJECT, NOTE), {
    events: [],
    nextCursor: null,
  });
  qc.setQueryData(noteKeys.revisions(PROJECT, NOTE), {
    currentVersion: 2,
    revisions: [],
  });
  return qc;
}

/**
 * Read a query's invalidation flag.
 * @param qc - Seeded client.
 * @param key - Query key.
 * @returns True when the query was invalidated.
 */
function invalidated(qc: QueryClient, key: readonly unknown[]): boolean {
  return qc.getQueryState(key)?.isInvalidated === true;
}

beforeEach(() => {
  restoreCalls = [];
});

describe("runRestoreRevisionWrite", () => {
  test("sends the cached CAS token and invalidates detail/list/events/revisions on success", async () => {
    const qc = seededClient();
    nextRestoreResult = { ok: true, data: {} };

    const result = await runRestoreRevisionWrite(qc, PROJECT, NOTE, 1);

    expect(result.ok).toBe(true);
    expect(restoreCalls).toEqual([
      { noteId: NOTE, version: 1, ifUpdatedAt: treeAt.toISOString() },
    ]);
    expect(invalidated(qc, noteKeys.detail(PROJECT, NOTE))).toBe(true);
    expect(invalidated(qc, noteKeys.list(PROJECT))).toBe(true);
    expect(invalidated(qc, noteKeys.events(PROJECT, NOTE))).toBe(true);
    expect(invalidated(qc, noteKeys.revisions(PROJECT, NOTE))).toBe(true);
  });

  test("a stale_write failure surfaces the typed result and still invalidates", async () => {
    const qc = seededClient();
    nextRestoreResult = {
      ok: false,
      code: "stale_write",
      message: "stale",
      currentUpdatedAt: new Date("2026-07-02T09:00:00.000Z").toISOString(),
      currentVersion: 3,
    };

    const result = await runRestoreRevisionWrite(qc, PROJECT, NOTE, 1);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("stale_write");
    expect(invalidated(qc, noteKeys.detail(PROJECT, NOTE))).toBe(true);
    expect(invalidated(qc, noteKeys.revisions(PROJECT, NOTE))).toBe(true);
  });

  test("a validation failure invalidates nothing (the server applied no write)", async () => {
    const qc = seededClient();
    nextRestoreResult = {
      ok: false,
      code: "validation",
      field: "version",
      message: "version 9 not found",
    };

    const result = await runRestoreRevisionWrite(qc, PROJECT, NOTE, 9);

    expect(result.ok).toBe(false);
    expect(invalidated(qc, noteKeys.detail(PROJECT, NOTE))).toBe(false);
    expect(invalidated(qc, noteKeys.list(PROJECT))).toBe(false);
    expect(invalidated(qc, noteKeys.events(PROJECT, NOTE))).toBe(false);
    expect(invalidated(qc, noteKeys.revisions(PROJECT, NOTE))).toBe(false);
  });
});
