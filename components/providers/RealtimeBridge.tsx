"use client";

import { useEffect } from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import { myTasksKeys, projectKeys, taskKeys } from "@/lib/query/keys";
import type { RealtimeEvent } from "@/lib/realtime/types";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Realtime transport differs by deploy target. Self-host uses a long-lived
 * `EventSource` against the in-memory SSE broker (`_broker.node.ts`). On
 * Cloudflare Workers a long-lived SSE connection bills the wall-clock as
 * compute and isolates do not share broker state, so the client instead opens
 * a WebSocket to the hibernating `PiyazBroker` Durable Object (zero compute
 * while idle). Both transports feed the same invalidation switch
 * ({@link applyRealtimeEvent}); the DO sends SSE-framed payloads over the
 * socket so the wire shape matches the EventSource path.
 */
const IS_CLOUDFLARE = process.env.NEXT_PUBLIC_DEPLOY_TARGET === "cloudflare";

/**
 * Apply one realtime event to the shared TanStack Query cache.
 *
 * - `project` events invalidate `projectKeys.graph(projectId)` (slim graph
 *   refetch on workspace tabs viewing that project) plus the my-tasks list.
 * - `task` events invalidate the task body and context bundle but
 *   intentionally NOT the slim graph: every `task` dispatch in
 *   `lib/realtime/events.ts` is paired with a `project` dispatch that already
 *   invalidates the graph. If `emitTaskEvent` ever stops emitting the paired
 *   project event, restore the graph invalidation here.
 * - `project-list` events invalidate the home grid.
 * - `project-deleted` events invalidate the home grid and drop the
 *   workspace's slim-graph cache entry.
 *
 * @param qc - The active QueryClient.
 * @param raw - JSON-encoded {@link RealtimeEvent} payload.
 */
function applyRealtimeEvent(qc: QueryClient, raw: string): void {
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
      qc.invalidateQueries({
        queryKey: taskKeys.activity(ev.projectId, ev.taskId),
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
}

/**
 * Extract the JSON payload from a DO WebSocket frame. The broker encodes each
 * event as an SSE `data: <json>\n\n` frame (`broker-do.ts`), matching the
 * EventSource wire format. Collects every `data:` line per the SSE spec,
 * stripping one optional leading space and a trailing `\r` from each and
 * joining multi-line payloads with `\n`; comment / heartbeat frames
 * (`: ...`) yield `null`.
 *
 * @param frame - Raw WebSocket message text.
 * @returns The joined `data:` payload, or `null` when the frame carries none.
 */
export function parseSseFrame(frame: string): string | null {
  const datas = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, "").replace(/\r$/, ""));
  return datas.length > 0 ? datas.join("\n") : null;
}

/**
 * Mounts the realtime transport for the authenticated user and feeds incoming
 * events into the shared TanStack Query cache. Self-host uses `EventSource`;
 * Cloudflare uses a WebSocket to the broker Durable Object. Both reconnect on
 * drop with capped exponential backoff (30 s) and run one full
 * `invalidateQueries()` on every open — the first open reconciles mutations
 * that landed in the connect-to-subscribe window, reconnects catch up on
 * anything missed while disconnected. Strict-Mode-safe: cleanup closes the
 * transport and clears any pending reconnect timer.
 *
 * @returns null — provider mounts side-effects only.
 */
export function RealtimeBridge() {
  const qc = useQueryClient();
  const session = useSession();

  useEffect(() => {
    if (!session.data) return;

    let backoff = INITIAL_BACKOFF_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let es: EventSource | null = null;
    let ws: WebSocket | null = null;

    const onOpen = () => {
      backoff = INITIAL_BACKOFF_MS;
      qc.invalidateQueries();
    };

    const scheduleReconnect = (reopen: () => void) => {
      if (cancelled) return;
      const wait = Math.min(backoff, MAX_BACKOFF_MS);
      reconnectTimer = setTimeout(reopen, wait);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };

    const openEventSource = () => {
      if (cancelled) return;
      es = new EventSource("/api/events");
      es.onmessage = (msg) => applyRealtimeEvent(qc, msg.data);
      es.onopen = onOpen;
      es.onerror = () => {
        es?.close();
        es = null;
        scheduleReconnect(openEventSource);
      };
    };

    const openWebSocket = () => {
      if (cancelled) return;
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${scheme}//${window.location.host}/api/events`);
      ws.onmessage = (msg) => {
        if (typeof msg.data !== "string") return;
        const data = parseSseFrame(msg.data);
        if (data) applyRealtimeEvent(qc, data);
      };
      ws.onopen = onOpen;
      ws.onclose = () => {
        ws = null;
        scheduleReconnect(openWebSocket);
      };
      ws.onerror = () => ws?.close();
    };

    if (IS_CLOUDFLARE) openWebSocket();
    else openEventSource();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
      ws?.close();
    };
  }, [session.data, qc]);

  return null;
}
