"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import { myTasksKeys, projectKeys, taskKeys } from "@/lib/query/keys";
import type { RealtimeEvent } from "@/lib/realtime/types";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Realtime is disabled on the Cloudflare Workers deploy target.
 *
 * The self-host SSE broker (`lib/realtime/_broker.node.ts`) is in-memory and
 * single-process — what a long-lived `EventSource` needs. On Workers an SSE
 * connection bills the wall-clock as compute time and isolates do not share
 * broker state, so `/api/events` short-circuits to 204. The browser
 * `EventSource` API closes on 204 and this component's `onerror` handler
 * would reconnect with exponential backoff, producing a steady reconnect
 * storm. Gating the provider here keeps the network panel clean until the
 * Workers path moves to the Durable-Object-backed broker over the WebSocket
 * Hibernation API. Data freshness on Workers comes from React Query's
 * `staleTime` + focus-refetch.
 */
const IS_CLOUDFLARE = process.env.NEXT_PUBLIC_DEPLOY_TARGET === "cloudflare";

/**
 * Mounts a single `EventSource('/api/events')` for the authenticated user
 * and dispatches incoming events into the shared TanStack Query cache.
 *
 * - `project` events invalidate `projectKeys.graph(projectId)` (slim graph
 *   refetch on workspace tabs viewing that project).
 * - `task` events invalidate the task body and the task context bundle but
 *   intentionally NOT the slim graph: every `task` dispatch in
 *   `lib/realtime/events.ts` is paired with a `project` dispatch that
 *   already invalidates the graph. Firing both produces a redundant
 *   in-flight fetch per mutation that Query then aborts. If
 *   `emitTaskEvent` ever stops emitting the paired project event, the
 *   `task` case here must restore the graph invalidation.
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
    if (IS_CLOUDFLARE) return;
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
          qc.invalidateQueries({ queryKey: myTasksKeys.list() });
          break;
        case "task":
          qc.invalidateQueries({
            queryKey: taskKeys.detail(ev.projectId, ev.taskId),
          });
          qc.invalidateQueries({
            queryKey: taskKeys.contextAll(ev.projectId, ev.taskId),
          });
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
        const isReconnect = backoff !== INITIAL_BACKOFF_MS;
        backoff = INITIAL_BACKOFF_MS;
        if (isReconnect) {
          qc.invalidateQueries();
        }
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
