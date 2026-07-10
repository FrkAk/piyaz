import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  _resetPresenceForTests,
  applyPresence,
  getPresenceSnapshot,
  sweepExpiredPresence,
  PRESENCE_TIMEOUT_MS,
} from "@/lib/realtime/presence-store";

/**
 * Pins the client presence store: editing upsert, gone delete, timeout
 * sweep, and the referential stability `useSyncExternalStore` requires.
 */

const NOTE = "n1";

/**
 * Build a `note-presence` event payload.
 *
 * @param userId - Sender user id.
 * @param state - Presence state.
 * @returns Decoded presence event.
 */
function ev(userId: string, state: "editing" | "gone") {
  return {
    kind: "note-presence" as const,
    noteId: NOTE,
    userId,
    name: `User ${userId}`,
    image: null,
    state,
  };
}

afterEach(() => {
  _resetPresenceForTests();
  setSystemTime();
});

describe("presence store", () => {
  test("editing upserts, gone deletes", () => {
    applyPresence(ev("u1", "editing"));
    applyPresence(ev("u2", "editing"));
    expect(getPresenceSnapshot(NOTE).map((e) => e.userId)).toEqual([
      "u1",
      "u2",
    ]);

    applyPresence(ev("u1", "gone"));
    expect(getPresenceSnapshot(NOTE).map((e) => e.userId)).toEqual(["u2"]);
  });

  test("gone for an absent entry is a no-op snapshot-wise", () => {
    applyPresence(ev("u1", "editing"));
    const before = getPresenceSnapshot(NOTE);
    applyPresence(ev("u9", "gone"));
    expect(getPresenceSnapshot(NOTE)).toBe(before);
  });

  test("sweep drops entries older than the timeout and keeps fresh ones", () => {
    const now = new Date("2026-07-01T10:00:00.000Z").getTime();
    setSystemTime(new Date(now));
    applyPresence(ev("u1", "editing"));

    sweepExpiredPresence(now + PRESENCE_TIMEOUT_MS);
    expect(getPresenceSnapshot(NOTE).map((e) => e.userId)).toEqual(["u1"]);

    sweepExpiredPresence(now + PRESENCE_TIMEOUT_MS + 1_000);
    expect(getPresenceSnapshot(NOTE)).toEqual([]);
  });

  test("snapshots are referentially stable between store versions", () => {
    applyPresence(ev("u1", "editing"));
    const first = getPresenceSnapshot(NOTE);
    expect(getPresenceSnapshot(NOTE)).toBe(first);
    expect(getPresenceSnapshot("other")).toBe(getPresenceSnapshot("other"));

    applyPresence(ev("u2", "editing"));
    const second = getPresenceSnapshot(NOTE);
    expect(second).not.toBe(first);
    expect(second.map((e) => e.userId)).toEqual(["u1", "u2"]);
  });

  test("an editing refresh keeps the entry alive past the original deadline", () => {
    const t0 = new Date("2026-07-01T10:00:00.000Z").getTime();
    setSystemTime(new Date(t0));
    applyPresence(ev("u1", "editing"));
    setSystemTime(new Date(t0 + 30_000));
    applyPresence(ev("u1", "editing"));
    sweepExpiredPresence(t0 + PRESENCE_TIMEOUT_MS + 1);
    expect(getPresenceSnapshot(NOTE).map((e) => e.userId)).toEqual(["u1"]);
    sweepExpiredPresence(t0 + 30_000 + PRESENCE_TIMEOUT_MS + 1);
    expect(getPresenceSnapshot(NOTE)).toEqual([]);
  });

  test("reset wipes entries", () => {
    applyPresence(ev("u1", "editing"));
    _resetPresenceForTests();
    expect(getPresenceSnapshot(NOTE)).toEqual([]);
  });
});
