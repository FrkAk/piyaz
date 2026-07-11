"use client";

import { useEffect } from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import type { NoteFullResult, NoteTreeRow } from "@/lib/data/note";
import { myTasksKeys, noteKeys, projectKeys, taskKeys } from "@/lib/query/keys";
import {
  clearNoteTrashedIfRestoredRemotely,
  hasUnsavedNoteEdits,
  whenNoteWritesSettle,
} from "@/lib/query/note-cache";
import { applyPresence } from "@/lib/realtime/presence-store";
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
 * - `note` events ride the `project:<projectId>` subscription for team notes
 *   and the `note:<noteId>` subscription for private notes (see
 *   `lib/realtime/events.ts`), and are judged by {@link handleNoteEvent}
 *   after any in-flight local write for that note settles, so the actor's
 *   own event, which can outrun the mutation response, never triggers a
 *   redundant refetch.
 * - `note-presence` events write the shared presence store only: no
 *   settle await, no query invalidation, no refetch.
 * - `note-folders` events invalidate the explicit-folders list so another
 *   member's empty-folder create/rename/delete reaches every open tree.
 * - `project-list` events invalidate the home grid.
 * - `project-deleted` events invalidate the home grid and drop the
 *   workspace's slim-graph cache entry.
 *
 * Exported for tests.
 *
 * @param qc - The active QueryClient.
 * @param raw - JSON-encoded {@link RealtimeEvent} payload.
 * @returns Promise settling once the event is fully applied.
 */
export async function applyRealtimeEvent(
  qc: QueryClient,
  raw: string,
): Promise<void> {
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
    case "note":
      await handleNoteEvent(qc, ev);
      break;
    case "note-presence":
      applyPresence(ev);
      break;
    case "note-folders":
      qc.invalidateQueries({ queryKey: noteKeys.folders(ev.projectId) });
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
 * Milliseconds for a cached `updatedAt`, which is a `Date` after a
 * mutation merge and an ISO string after a route fetch.
 *
 * @param value - Cached `updatedAt`.
 * @returns Epoch milliseconds.
 */
function updatedAtMs(value: Date | string): number {
  return typeof value === "string" ? Date.parse(value) : value.getTime();
}

/** Quiet window that coalesces per-note history refetches across an autosave burst. */
let noteEventsInvalidateQuietMs = 2_000;

/**
 * Test-only override of the events-invalidation quiet window.
 *
 * @param ms - Replacement window in milliseconds.
 */
export function _setNoteEventsQuietMsForTests(ms: number): void {
  noteEventsInvalidateQuietMs = ms;
}

/** Pending per-note history invalidation timers, keyed by note id. */
const noteEventsInvalidateTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

/**
 * Invalidate a note's events query after a quiet window, coalescing
 * autosave bursts into one refetch. Before invalidating, the cached
 * infinite data is trimmed to its first page so the refetch fetches one
 * keyset page instead of every page the viewer had expanded.
 *
 * @param qc - The active QueryClient.
 * @param projectId - Owning project id.
 * @param noteId - Note whose events query to invalidate.
 */
function scheduleNoteEventsInvalidation(
  qc: QueryClient,
  projectId: string,
  noteId: string,
): void {
  const existing = noteEventsInvalidateTimers.get(noteId);
  if (existing !== undefined) clearTimeout(existing);
  noteEventsInvalidateTimers.set(
    noteId,
    setTimeout(() => {
      noteEventsInvalidateTimers.delete(noteId);
      const key = noteKeys.events(projectId, noteId);
      qc.setQueryData<{ pages: unknown[]; pageParams: unknown[] }>(
        key,
        (data) =>
          data !== undefined && data.pages.length > 1
            ? {
                pages: data.pages.slice(0, 1),
                pageParams: data.pageParams.slice(0, 1),
              }
            : data,
      );
      qc.invalidateQueries({ queryKey: key });
    }, noteEventsInvalidateQuietMs),
  );
}

/**
 * Judge a `note` event against the cache and invalidate what is actually
 * stale. Waits for the note's in-flight local writes to settle first, so
 * the caches already hold the merged response when the actor's own event
 * arrives. A cache entry at or past the event's `updatedAt` skips its
 * refetch; an event without `updatedAt` (delete) always invalidates the
 * list. An event strictly newer than a note's stored delete baseline
 * clears its trashed mark (a cross-client restore; the actor's own
 * pre-delete autosave event is older-or-equal and never qualifies). The
 * open note's detail additionally never refetches while the note holds
 * unsaved editor content: a refetch must not clobber the optimistic
 * autosave buffer or kept-optimistic conflict content. The note's events
 * query invalidates through {@link scheduleNoteEventsInvalidation}, which
 * coalesces autosave bursts. The revisions query refetches only when the
 * write archived a checkpoint (`revisionCheckpointed`): a checkpoint-free
 * body save moves `currentVersion` alone, patched into the cache in place,
 * and the actor's own writes land from the mutation response so the
 * version gate skips them entirely. Neither touches the editor buffer, so
 * no dirty gating applies.
 *
 * @param qc - The active QueryClient.
 * @param ev - Decoded note event.
 * @returns Promise settling once invalidations are issued.
 */
async function handleNoteEvent(
  qc: QueryClient,
  ev: {
    projectId: string;
    noteId: string;
    updatedAt?: string;
    version?: number;
    revisionCheckpointed?: boolean;
  },
): Promise<void> {
  await whenNoteWritesSettle(ev.noteId);
  scheduleNoteEventsInvalidation(qc, ev.projectId, ev.noteId);
  const revisionsKey = noteKeys.revisions(ev.projectId, ev.noteId);
  const revisions = qc.getQueryData<{
    currentVersion: number;
    revisions: unknown[];
  }>(revisionsKey);
  const revisionsCurrent =
    ev.version !== undefined &&
    revisions !== undefined &&
    revisions.currentVersion >= ev.version;
  if (!revisionsCurrent) {
    if (
      ev.version !== undefined &&
      revisions !== undefined &&
      ev.revisionCheckpointed !== true
    ) {
      const version = ev.version;
      qc.setQueryData<{ currentVersion: number; revisions: unknown[] }>(
        revisionsKey,
        (data) =>
          data === undefined ? data : { ...data, currentVersion: version },
      );
    } else {
      qc.invalidateQueries({ queryKey: revisionsKey });
    }
  }
  const evMs = ev.updatedAt === undefined ? Infinity : Date.parse(ev.updatedAt);
  if (ev.updatedAt !== undefined) {
    clearNoteTrashedIfRestoredRemotely(ev.noteId, evMs);
  }
  const rows = qc.getQueryData<NoteTreeRow[]>(noteKeys.list(ev.projectId));
  const row = rows?.find((r) => r.id === ev.noteId);
  const listCurrent = row !== undefined && updatedAtMs(row.updatedAt) >= evMs;
  if (!listCurrent) {
    qc.invalidateQueries({ queryKey: noteKeys.list(ev.projectId) });
    qc.invalidateQueries({ queryKey: noteKeys.backlinksAll(ev.projectId) });
  }
  if (!hasUnsavedNoteEdits(ev.noteId)) {
    const detail = qc.getQueryData<NoteFullResult>(
      noteKeys.detail(ev.projectId, ev.noteId),
    );
    const detailCurrent =
      detail !== undefined && updatedAtMs(detail.note.updatedAt) >= evMs;
    if (!detailCurrent) {
      qc.invalidateQueries({
        queryKey: noteKeys.detail(ev.projectId, ev.noteId),
      });
    }
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
 * `invalidateQueries()` on every open: the first open reconciles mutations
 * that landed in the connect-to-subscribe window, reconnects catch up on
 * anything missed while disconnected. Strict-Mode-safe: cleanup closes the
 * transport and clears any pending reconnect timer.
 *
 * @returns null; provider mounts side-effects only.
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
      es.onmessage = (msg) => void applyRealtimeEvent(qc, msg.data);
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
        if (data) void applyRealtimeEvent(qc, data);
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
