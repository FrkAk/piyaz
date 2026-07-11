"use client";

import { useEffect } from "react";
import { PRESENCE_HEARTBEAT_MS } from "@/lib/realtime/presence-store";

/**
 * Broadcast editing presence for an open team note: POST an `editing`
 * heartbeat immediately and every {@link PRESENCE_HEARTBEAT_MS} while the
 * tab is visible, and a best-effort `gone` (with `keepalive` so it
 * survives navigation) on unmount, note switch, or `enabled` turning
 * false. A hidden tab pauses silently instead of beating or sending
 * `gone`: remote viewers drop the avatar via the client-side expiry, a
 * quick tab switch never flaps it, and an idle background tab costs zero
 * requests; returning to the tab resumes with an immediate beat.
 * Failures, including 429, are swallowed; the next beat retries, so
 * presence degrades to a longer refresh and never surfaces an error; at
 * most one warning is logged per note session. Reconnects need no
 * special handling: the next beat re-establishes presence and
 * re-registers the `note:<id>` subscription within one interval.
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
    let timer: ReturnType<typeof setInterval> | null = null;

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

    const start = () => {
      send("editing");
      timer = setInterval(() => send("editing"), PRESENCE_HEARTBEAT_MS);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        if (timer === null) start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
      send("gone");
    };
  }, [noteId, enabled]);
}
