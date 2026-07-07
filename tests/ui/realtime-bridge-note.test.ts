import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { applyRealtimeEvent } from "@/components/providers/RealtimeBridge";
import type { NoteTreeRow } from "@/lib/data/note";
import { noteKeys } from "@/lib/query/keys";
import {
  clearNoteDirty,
  enqueueNoteWrite,
  markNoteDirty,
  notePlaceholderFromRow,
} from "@/lib/query/note-cache";

/**
 * Pins the guarded `note` invalidation contract: the actor's own write
 * (cached `updatedAt` equals the event's) skips the list refetch, an open
 * detail refetches only when stale, and a dirty note is never refetched.
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
    title: "Title",
    type: "reference",
    folder: "",
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
function noteEvent(updatedAt?: Date): string {
  return JSON.stringify({
    kind: "note",
    projectId: PROJECT,
    noteId: NOTE,
    ...(updatedAt ? { updatedAt: updatedAt.toISOString() } : {}),
  });
}

afterEach(() => {
  clearNoteDirty(NOTE);
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
});
