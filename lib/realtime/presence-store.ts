"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { RealtimeEvent } from "@/lib/realtime/types";

/** Interval between client presence heartbeats while a team note is open. */
export const PRESENCE_HEARTBEAT_MS = 20_000;

/**
 * Client-side expiry for a remote editor's presence: two-plus missed
 * heartbeats. Independent of the 10-minute `note:<id>` subscription TTL.
 */
export const PRESENCE_TIMEOUT_MS = 45_000;

/** Sweep cadence for expiring stale presence entries. */
const SWEEP_INTERVAL_MS = 10_000;

/** One remote editor as rendered in the note header. */
export type NotePresenceEntry = {
  userId: string;
  name: string;
  image: string | null;
};

type StoredEntry = NotePresenceEntry & { lastSeen: number };

/** `note-presence` payload narrowed out of the realtime event union. */
type NotePresenceEvent = Extract<RealtimeEvent, { kind: "note-presence" }>;

const presenceByNote = new Map<string, Map<string, StoredEntry>>();
const listeners = new Set<() => void>();
let version = 0;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

const EMPTY_PRESENCE: ReadonlyArray<NotePresenceEntry> = [];

/** Memoized per-note snapshots, invalidated on every store version bump. */
let snapshotVersion = -1;
let snapshotByNote = new Map<string, ReadonlyArray<NotePresenceEntry>>();

/**
 * Bump the store version and notify subscribers.
 */
function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * Apply one `note-presence` event to the store: `editing` upserts the
 * sender with a fresh `lastSeen`, `gone` deletes it. Notifies only on an
 * actual change (a `gone` for an absent entry is a no-op; an `editing`
 * refresh always notifies since `lastSeen` advanced).
 *
 * @param ev - Decoded presence event.
 */
export function applyPresence(ev: NotePresenceEvent): void {
  const entries = presenceByNote.get(ev.noteId);
  if (ev.state === "gone") {
    if (!entries?.delete(ev.userId)) return;
    if (entries.size === 0) presenceByNote.delete(ev.noteId);
    notify();
    return;
  }
  const next = entries ?? new Map<string, StoredEntry>();
  if (!entries) presenceByNote.set(ev.noteId, next);
  next.set(ev.userId, {
    userId: ev.userId,
    name: ev.name,
    image: ev.image,
    lastSeen: Date.now(),
  });
  notify();
}

/**
 * Drop every entry whose `lastSeen` is older than
 * {@link PRESENCE_TIMEOUT_MS}. Notifies only when something dropped.
 * Called by the shared sweep interval; exported for tests.
 *
 * @param now - Clock reading, defaulting to `Date.now()`.
 */
export function sweepExpiredPresence(now: number = Date.now()): void {
  let dropped = false;
  for (const [noteId, entries] of presenceByNote) {
    for (const [userId, entry] of entries) {
      if (now - entry.lastSeen > PRESENCE_TIMEOUT_MS) {
        entries.delete(userId);
        dropped = true;
      }
    }
    if (entries.size === 0) presenceByNote.delete(noteId);
  }
  if (dropped) notify();
}

/**
 * Subscribe to store changes, running the shared sweep interval while at
 * least one listener is attached.
 *
 * @param onStoreChange - Notification callback from `useSyncExternalStore`.
 * @returns Unsubscribe function.
 */
function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (sweepTimer === null) {
    sweepTimer = setInterval(() => sweepExpiredPresence(), SWEEP_INTERVAL_MS);
  }
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0 && sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  };
}

/**
 * Read the current editor list for a note. Referentially stable between
 * store versions (memoized per note) so `useSyncExternalStore` never
 * loops. Exported for tests.
 *
 * @param noteId - Note id.
 * @returns Stable array of live editors; empty when none.
 */
export function getPresenceSnapshot(
  noteId: string,
): ReadonlyArray<NotePresenceEntry> {
  if (snapshotVersion !== version) {
    snapshotByNote = new Map();
    snapshotVersion = version;
  }
  const cached = snapshotByNote.get(noteId);
  if (cached) return cached;
  const entries = presenceByNote.get(noteId);
  const snapshot: ReadonlyArray<NotePresenceEntry> = entries
    ? [...entries.values()].map(({ userId, name, image }) => ({
        userId,
        name,
        image,
      }))
    : EMPTY_PRESENCE;
  snapshotByNote.set(noteId, snapshot);
  return snapshot;
}

/**
 * Live editor list for a note, fed by `note-presence` events and expired
 * by the shared sweep. Server snapshot is always empty (presence is a
 * client-runtime signal).
 *
 * @param noteId - Note id.
 * @returns Stable array of live editors; empty when none.
 */
export function useNotePresence(
  noteId: string,
): ReadonlyArray<NotePresenceEntry> {
  const getSnapshot = useCallback(() => getPresenceSnapshot(noteId), [noteId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_PRESENCE);
}

/** Test-only: wipes entries, snapshots, and the version counter. */
export function _resetPresenceForTests(): void {
  presenceByNote.clear();
  snapshotByNote = new Map();
  version = 0;
  snapshotVersion = -1;
}
