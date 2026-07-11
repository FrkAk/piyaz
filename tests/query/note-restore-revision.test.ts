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
  | { ok: false; code: "invalid_input"; field: string; message: string };

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

const { runOptimisticNoteWrite, runRestoreRevisionWrite } = await import(
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
      code: "invalid_input",
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

describe("runOptimisticNoteWrite revisions cache maintenance", () => {
  test("a checkpointing success prepends the archived pre-image and bumps currentVersion", async () => {
    const qc = seededClient();
    qc.setQueryData(noteKeys.revisions(PROJECT, NOTE), {
      currentVersion: 2,
      revisions: [
        { version: 1, title: "Old", createdAt: "2026-07-01T09:00:00.000Z" },
      ],
    });
    const archivedAt = new Date("2026-07-02T09:30:00.000Z");

    await runOptimisticNoteWrite(
      qc,
      PROJECT,
      NOTE,
      { body: "new body" },
      async () => ({
        ok: true as const,
        data: {
          id: NOTE,
          slug: "slug-n1",
          sequenceNumber: 1,
          title: "New title",
          projectId: PROJECT,
          folder: "",
          version: 3,
          updatedAt: new Date("2026-07-02T10:00:00.000Z"),
          projectIdentifier: "PYZ",
          revisionCheckpoint: {
            version: 2,
            title: "Archived title",
            createdAt: archivedAt,
          },
        },
      }),
      false,
    );

    const cache = qc.getQueryData<{
      currentVersion: number;
      revisions: { version: number; title: string; createdAt: string | Date }[];
    }>(noteKeys.revisions(PROJECT, NOTE));
    expect(cache?.currentVersion).toBe(3);
    expect(cache?.revisions.map((r) => r.version)).toEqual([2, 1]);
    expect(cache?.revisions[0].title).toBe("Archived title");
    expect(cache?.revisions[0].createdAt).toBe(archivedAt);
  });

  test("a checkpoint-free body success bumps currentVersion without touching the rows", async () => {
    const qc = seededClient();
    const rows = [
      { version: 1, title: "Old", createdAt: "2026-07-01T09:00:00.000Z" },
    ];
    qc.setQueryData(noteKeys.revisions(PROJECT, NOTE), {
      currentVersion: 2,
      revisions: rows,
    });

    await runOptimisticNoteWrite(
      qc,
      PROJECT,
      NOTE,
      { body: "new body" },
      async () => ({
        ok: true as const,
        data: {
          id: NOTE,
          slug: "slug-n1",
          sequenceNumber: 1,
          title: "New title",
          projectId: PROJECT,
          folder: "",
          version: 3,
          updatedAt: new Date("2026-07-02T10:00:00.000Z"),
          projectIdentifier: "PYZ",
        },
      }),
      false,
    );

    const cache = qc.getQueryData<{
      currentVersion: number;
      revisions: unknown[];
    }>(noteKeys.revisions(PROJECT, NOTE));
    expect(cache?.currentVersion).toBe(3);
    expect(cache?.revisions).toEqual(rows);
  });

  test("a metadata-only success (version unchanged) leaves the revisions cache untouched", async () => {
    const qc = seededClient();
    const before = qc.getQueryData<{ currentVersion: number }>(
      noteKeys.revisions(PROJECT, NOTE),
    );

    await runOptimisticNoteWrite(
      qc,
      PROJECT,
      NOTE,
      { title: "Renamed" },
      async () => ({
        ok: true as const,
        data: {
          id: NOTE,
          slug: "slug-n1",
          sequenceNumber: 1,
          title: "Renamed",
          projectId: PROJECT,
          folder: "",
          version: 2,
          updatedAt: new Date("2026-07-02T10:00:00.000Z"),
          projectIdentifier: "PYZ",
        },
      }),
      false,
    );

    expect(
      qc.getQueryData<{ currentVersion: number }>(
        noteKeys.revisions(PROJECT, NOTE),
      ),
    ).toBe(before);
  });
});
