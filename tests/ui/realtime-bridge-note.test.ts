import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  _setNoteEventsQuietMsForTests,
  applyRealtimeEvent,
} from "@/components/providers/RealtimeBridge";
import type { NoteTreeRow } from "@/lib/data/note";
import { noteKeys } from "@/lib/query/keys";
import {
  beginNoteEditSession,
  clearNoteDirty,
  clearNoteDirtyUnlessEditing,
  clearNoteTrashed,
  endNoteEditSession,
  enqueueNoteWrite,
  hasUnsavedNoteEdits,
  isNoteTrashed,
  markNoteDirty,
  markNoteTrashed,
  notePlaceholderFromRow,
} from "@/lib/query/note-cache";
import {
  _resetPresenceForTests,
  getPresenceSnapshot,
} from "@/lib/realtime/presence-store";
import {
  mergeConflictStash,
  type NoteConflictState,
} from "@/components/workspace/notes/note-conflict";
import { runOptimisticNoteWrite } from "@/components/workspace/notes/useNoteMutations";
import { cachedCasToken } from "@/lib/query/note-cache";

/**
 * Pins the guarded `note` invalidation contract: the actor's own write
 * (cached `updatedAt` equals the event's) skips the list refetch, an open
 * detail refetches only when stale, a dirty note is never refetched, a
 * strictly-newer event clears a trashed mark (cross-client restore) while
 * an older-or-equal one never does, and `note-presence` events write the
 * presence store without touching the query cache.
 */

const when = new Date("2026-07-01T10:00:00.000Z");
const PROJECT = "p1";
const NOTE = "n1";

/**
 * Build a tree row for the fixture note.
 * @param updatedAt - Row timestamp.
 * @returns A complete `NoteTreeRow`.
 */
function row(updatedAt: Date): NoteTreeRow {
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
    updatedAt,
  };
}

/**
 * Seed a QueryClient with the note list and detail caches.
 * @param updatedAt - Timestamp both caches carry.
 * @returns The seeded client.
 */
function seededClient(updatedAt: Date): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData(noteKeys.list(PROJECT), [row(updatedAt)]);
  qc.setQueryData(
    noteKeys.detail(PROJECT, NOTE),
    notePlaceholderFromRow(PROJECT, row(updatedAt)),
  );
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

/**
 * Encode a note event payload.
 * @param updatedAt - Optional event timestamp.
 * @returns JSON payload string.
 */
function noteEvent(
  updatedAt?: Date,
  version?: number,
  revisionCheckpointed?: boolean,
): string {
  return JSON.stringify({
    kind: "note",
    projectId: PROJECT,
    noteId: NOTE,
    ...(updatedAt ? { updatedAt: updatedAt.toISOString() } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(revisionCheckpointed !== undefined ? { revisionCheckpointed } : {}),
  });
}

/**
 * Await until the debounced events invalidation could have fired.
 * @param ms - Milliseconds to wait.
 * @returns Promise resolving after the wait.
 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  _setNoteEventsQuietMsForTests(2_000);
  endNoteEditSession(NOTE);
  clearNoteDirty(NOTE);
  clearNoteTrashed(NOTE);
  _resetPresenceForTests();
});

describe("applyRealtimeEvent note case", () => {
  test("own write (matching updatedAt) invalidates nothing", async () => {
    const qc = seededClient(when);
    await applyRealtimeEvent(qc, noteEvent(when));
    expect(invalidated(qc, noteKeys.list(PROJECT))).toBe(false);
    expect(invalidated(qc, noteKeys.detail(PROJECT, NOTE))).toBe(false);
  });

  test("remote write (newer updatedAt) invalidates list and clean detail", async () => {
    const qc = seededClient(when);
    await applyRealtimeEvent(
      qc,
      noteEvent(new Date("2026-07-01T11:00:00.000Z")),
    );
    expect(invalidated(qc, noteKeys.list(PROJECT))).toBe(true);
    expect(invalidated(qc, noteKeys.detail(PROJECT, NOTE))).toBe(true);
  });

  test("a dirty note never refetches its detail", async () => {
    const qc = seededClient(when);
    markNoteDirty(NOTE);
    await applyRealtimeEvent(
      qc,
      noteEvent(new Date("2026-07-01T11:00:00.000Z")),
    );
    expect(invalidated(qc, noteKeys.list(PROJECT))).toBe(true);
    expect(invalidated(qc, noteKeys.detail(PROJECT, NOTE))).toBe(false);
  });

  test("an event without updatedAt (delete) invalidates the list and detail", async () => {
    const qc = seededClient(when);
    await applyRealtimeEvent(qc, noteEvent());
    expect(invalidated(qc, noteKeys.list(PROJECT))).toBe(true);
    expect(invalidated(qc, noteKeys.detail(PROJECT, NOTE))).toBe(true);
  });

  test("waits for an in-flight write to merge before judging freshness", async () => {
    const qc = seededClient(when);
    const later = new Date("2026-07-01T11:00:00.000Z");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = enqueueNoteWrite(NOTE, async () => {
      await gate;
      qc.setQueryData(noteKeys.list(PROJECT), [row(later)]);
      qc.setQueryData(
        noteKeys.detail(PROJECT, NOTE),
        notePlaceholderFromRow(PROJECT, row(later)),
      );
    });

    const applied = applyRealtimeEvent(qc, noteEvent(later));
    release?.();
    await write;
    await applied;

    expect(invalidated(qc, noteKeys.list(PROJECT))).toBe(false);
    expect(invalidated(qc, noteKeys.detail(PROJECT, NOTE))).toBe(false);
  });

  test("a strictly newer event clears the trashed mark (cross-client restore)", async () => {
    const qc = seededClient(when);
    markNoteTrashed(NOTE, when);
    await applyRealtimeEvent(
      qc,
      noteEvent(new Date("2026-07-01T11:00:00.000Z")),
    );
    expect(isNoteTrashed(NOTE)).toBe(false);
  });

  test("an equal-or-older event never clears the trashed mark (own pre-delete autosave)", async () => {
    const qc = seededClient(when);
    markNoteTrashed(NOTE, when);
    await applyRealtimeEvent(qc, noteEvent(when));
    expect(isNoteTrashed(NOTE)).toBe(true);
    await applyRealtimeEvent(
      qc,
      noteEvent(new Date("2026-07-01T09:00:00.000Z")),
    );
    expect(isNoteTrashed(NOTE)).toBe(true);
  });

  test("a delete event (no updatedAt) never clears the trashed mark", async () => {
    const qc = seededClient(when);
    markNoteTrashed(NOTE, when);
    await applyRealtimeEvent(qc, noteEvent());
    expect(isNoteTrashed(NOTE)).toBe(true);
  });

  test("a save release during an open edit session keeps suppressing the detail refetch", async () => {
    const qc = seededClient(when);
    const newer = new Date("2026-07-01T11:00:00.000Z");

    beginNoteEditSession(NOTE);
    clearNoteDirtyUnlessEditing(NOTE);
    await applyRealtimeEvent(qc, noteEvent(newer));
    expect(invalidated(qc, noteKeys.detail(PROJECT, NOTE))).toBe(false);

    endNoteEditSession(NOTE);
    clearNoteDirtyUnlessEditing(NOTE);
    await applyRealtimeEvent(qc, noteEvent(newer));
    expect(invalidated(qc, noteKeys.detail(PROJECT, NOTE))).toBe(true);
  });

  test("a note-presence event mutates the store and issues zero invalidations", async () => {
    const qc = seededClient(when);
    await applyRealtimeEvent(
      qc,
      JSON.stringify({
        kind: "note-presence",
        noteId: NOTE,
        userId: "u2",
        name: "Remote User",
        image: null,
        state: "editing",
      }),
    );
    expect(getPresenceSnapshot(NOTE).map((e) => e.userId)).toEqual(["u2"]);
    expect(invalidated(qc, noteKeys.list(PROJECT))).toBe(false);
    expect(invalidated(qc, noteKeys.detail(PROJECT, NOTE))).toBe(false);
  });

  test("open-draft remote update resolves through the conflict path with both sides intact", async () => {
    const t0 = when;
    const t1 = new Date("2026-07-01T11:00:00.000Z");
    const qc = seededClient(t0);

    markNoteDirty(NOTE);
    await applyRealtimeEvent(qc, noteEvent(t1));
    expect(invalidated(qc, noteKeys.detail(PROJECT, NOTE))).toBe(false);
    expect(hasUnsavedNoteEdits(NOTE)).toBe(true);
    expect(cachedCasToken(qc, PROJECT, NOTE)).toBe(t0.toISOString());

    const patch = { body: "local draft body" };
    let sentToken: string | undefined;
    let conflict: NoteConflictState | null = null;
    const result = await runOptimisticNoteWrite(
      qc,
      PROJECT,
      NOTE,
      patch,
      async () => {
        sentToken = cachedCasToken(qc, PROJECT, NOTE);
        return {
          ok: false as const,
          code: "stale_write" as const,
          message: "stale",
          currentUpdatedAt: t1.toISOString(),
          currentVersion: 2,
        };
      },
      false,
    );

    expect(sentToken).toBe(t0.toISOString());
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "stale_write") {
      conflict = mergeConflictStash(null, {
        noteId: NOTE,
        currentUpdatedAt: result.currentUpdatedAt,
        currentVersion: result.currentVersion,
        patch,
      });
    }
    expect(conflict?.patch).toEqual(patch);
    expect(conflict?.currentVersion).toBe(2);

    const detail = qc.getQueryData<{ note: { body: string } }>(
      noteKeys.detail(PROJECT, NOTE),
    );
    expect(detail?.note.body).toBe("local draft body");
    expect(hasUnsavedNoteEdits(NOTE)).toBe(true);
  });

  test("a checkpointed note event invalidates revisions and debounces events, even while dirty", async () => {
    _setNoteEventsQuietMsForTests(5);
    const qc = seededClient(when);
    qc.setQueryData(noteKeys.events(PROJECT, NOTE), {
      pages: [{ events: [], nextCursor: null }],
      pageParams: [null],
    });
    qc.setQueryData(noteKeys.revisions(PROJECT, NOTE), {
      currentVersion: 1,
      revisions: [],
    });
    markNoteDirty(NOTE);

    await applyRealtimeEvent(qc, noteEvent(when, 2, true));

    expect(invalidated(qc, noteKeys.revisions(PROJECT, NOTE))).toBe(true);
    expect(invalidated(qc, noteKeys.events(PROJECT, NOTE))).toBe(false);
    await wait(20);
    expect(invalidated(qc, noteKeys.events(PROJECT, NOTE))).toBe(true);
    expect(invalidated(qc, noteKeys.detail(PROJECT, NOTE))).toBe(false);
  });

  test("a checkpoint-free body event bumps cached currentVersion in place, no refetch", async () => {
    _setNoteEventsQuietMsForTests(5);
    const qc = seededClient(when);
    const rows = [{ version: 1, title: "Old", createdAt: "2026-07-01" }];
    qc.setQueryData(noteKeys.revisions(PROJECT, NOTE), {
      currentVersion: 2,
      revisions: rows,
    });

    await applyRealtimeEvent(qc, noteEvent(when, 3, false));

    expect(invalidated(qc, noteKeys.revisions(PROJECT, NOTE))).toBe(false);
    const cache = qc.getQueryData<{
      currentVersion: number;
      revisions: unknown[];
    }>(noteKeys.revisions(PROJECT, NOTE));
    expect(cache?.currentVersion).toBe(3);
    expect(cache?.revisions).toEqual(rows);
  });

  test("a note event whose version the revisions cache already covers skips that refetch", async () => {
    _setNoteEventsQuietMsForTests(5);
    const qc = seededClient(when);
    qc.setQueryData(noteKeys.revisions(PROJECT, NOTE), {
      currentVersion: 3,
      revisions: [],
    });

    await applyRealtimeEvent(qc, noteEvent(when, 3, true));
    expect(invalidated(qc, noteKeys.revisions(PROJECT, NOTE))).toBe(false);

    await applyRealtimeEvent(qc, noteEvent(when, 4, true));
    expect(invalidated(qc, noteKeys.revisions(PROJECT, NOTE))).toBe(true);
  });

  test("a version-less note event always invalidates revisions", async () => {
    _setNoteEventsQuietMsForTests(5);
    const qc = seededClient(when);
    qc.setQueryData(noteKeys.revisions(PROJECT, NOTE), {
      currentVersion: 3,
      revisions: [],
    });

    await applyRealtimeEvent(qc, noteEvent(when));
    expect(invalidated(qc, noteKeys.revisions(PROJECT, NOTE))).toBe(true);
  });

  test("burst note events coalesce into one events invalidation and trim to the first page", async () => {
    _setNoteEventsQuietMsForTests(15);
    const qc = seededClient(when);
    const firstPage = { events: [{ id: "e1" }], nextCursor: "c1" };
    qc.setQueryData(noteKeys.events(PROJECT, NOTE), {
      pages: [firstPage, { events: [{ id: "e2" }], nextCursor: null }],
      pageParams: [null, "c1"],
    });

    await applyRealtimeEvent(qc, noteEvent(when, 2));
    await applyRealtimeEvent(qc, noteEvent(when, 3));
    expect(invalidated(qc, noteKeys.events(PROJECT, NOTE))).toBe(false);

    await wait(40);
    expect(invalidated(qc, noteKeys.events(PROJECT, NOTE))).toBe(true);
    const trimmed = qc.getQueryData<{
      pages: unknown[];
      pageParams: unknown[];
    }>(noteKeys.events(PROJECT, NOTE));
    expect(trimmed?.pages).toEqual([firstPage]);
    expect(trimmed?.pageParams).toEqual([null]);
  });

  test("note-folders event invalidates the folders query and nothing else", async () => {
    const qc = seededClient(when);
    qc.setQueryData(noteKeys.folders(PROJECT), []);

    await applyRealtimeEvent(
      qc,
      JSON.stringify({ kind: "note-folders", projectId: PROJECT }),
    );

    expect(invalidated(qc, noteKeys.folders(PROJECT))).toBe(true);
    expect(invalidated(qc, noteKeys.list(PROJECT))).toBe(false);
    expect(invalidated(qc, noteKeys.detail(PROJECT, NOTE))).toBe(false);
  });
});
