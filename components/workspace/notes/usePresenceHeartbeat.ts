"use client";

import { useEffect } from "react";
import { PRESENCE_HEARTBEAT_MS } from "@/lib/realtime/presence-store";

/**
 * Broadcast editing presence for an open team note: POST an `editing`
 * heartbeat immediately and every {@link PRESENCE_HEARTBEAT_MS}, and a
 * best-effort `gone` (with `keepalive` so it survives navigation) on
 * unmount, note switch, or `enabled` turning false. Failures, including
 * 429, are swallowed; the next beat retries, so presence degrades to a
 * longer refresh and never surfaces an error; at most one warning is
 * logged per note session. Reconnects need no special handling: the next
 * beat re-establishes presence and re-registers the `note:<id>`
 * subscription within one interval.
 *
 * @param noteId - Note being viewed.
 * @param enabled - Beat only while true (loaded, non-placeholder, team).
 */
export function useNotePresenceHeartbeat(
  noteId: string,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;
    const url = `/api/note/${noteId}/presence`;
    let warned = false;

    const send = (state: "editing" | "gone") => {
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state }),
        ...(state === "gone" ? { keepalive: true } : {}),
      }).catch((err: unknown) => {
        if (warned) return;
        warned = true;
        console.warn("[realtime] presence heartbeat failed", err);
      });
    };

    send("editing");
    const timer = setInterval(() => send("editing"), PRESENCE_HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      send("gone");
    };
  }, [noteId, enabled]);
}
