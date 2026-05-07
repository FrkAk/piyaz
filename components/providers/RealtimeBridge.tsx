"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import { projectKeys, taskKeys } from "@/lib/query/keys";
import type { RealtimeEvent } from "@/lib/realtime/types";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Mounts a single `EventSource('/api/events')` for the authenticated user
 * and dispatches incoming events into the shared TanStack Query cache.
 *
 * - `project` events invalidate `projectKeys.graph(projectId)` (slim graph
 *   refetch on workspace tabs viewing that project).
 * - `task` events invalidate the task body and the task context bundle.
 * - `project-list` events invalidate the home grid.
 * - `project-deleted` events invalidate the home grid and remove the
 *   workspace's slim-graph cache entry.
 *
 * Reconnects on error with exponential backoff (capped at 30 s). Strict-
 * Mode-safe: cleanup closes the EventSource and clears any pending
 * reconnect timer.
 *
 * @returns null — provider mounts side-effects only.
 */
export function RealtimeBridge() {
  const qc = useQueryClient();
  const session = useSession();

  useEffect(() => {
    if (!session.data) return;

    let es: EventSource | null = null;
    let backoff = INITIAL_BACKOFF_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const handle = (raw: string) => {
      let ev: RealtimeEvent;
      try {
        ev = JSON.parse(raw) as RealtimeEvent;
      } catch (err) {
        console.warn("[realtime] parse failed:", err);
        return;
      }

      switch (ev.kind) {
        case "project":
          qc.invalidateQueries({ queryKey: projectKeys.graph(ev.projectId) });
          break;
        case "task":
          qc.invalidateQueries({
            queryKey: taskKeys.detail(ev.projectId, ev.taskId),
          });
          qc.invalidateQueries({
            queryKey: taskKeys.context(ev.projectId, ev.taskId),
          });
          qc.invalidateQueries({ queryKey: projectKeys.graph(ev.projectId) });
          break;
        case "project-list":
          qc.invalidateQueries({ queryKey: projectKeys.list() });
          break;
        case "project-deleted":
          qc.invalidateQueries({ queryKey: projectKeys.list() });
          qc.removeQueries({ queryKey: projectKeys.graph(ev.projectId) });
          break;
      }
    };

    const open = () => {
      if (cancelled) return;
      es = new EventSource("/api/events");
      es.onmessage = (msg) => handle(msg.data);
      es.onopen = () => {
        backoff = INITIAL_BACKOFF_MS;
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (cancelled) return;
        const wait = Math.min(backoff, MAX_BACKOFF_MS);
        reconnectTimer = setTimeout(open, wait);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      };
    };

    open();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [session.data, qc]);

  return null;
}
