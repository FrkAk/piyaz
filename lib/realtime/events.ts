import "server-only";
import { findOrgMemberUserIdsAsAdmin } from "@/lib/data/membership";
import { broker } from "@/lib/realtime/broker";
import type { RealtimeEvent } from "@/lib/realtime/types";
import type { Visibility } from "@/lib/types";

export type { RealtimeEvent };

/**
 * Emit a slim-graph-affecting event for a project.
 *
 * @param projectId - Project that changed (chrome, tasks, edges).
 */
export function emitProjectEvent(projectId: string): void {
  broker.dispatch(`project:${projectId}`, {
    kind: "project",
    projectId,
  } satisfies RealtimeEvent);
}

/**
 * Emit a task-body-affecting event. Always paired with the project event
 * since the slim graph carries title/status/tags/category/order — a body
 * change is also a slim graph change. Batched via `dispatchMany` so the
 * Workers backend costs one DO sub-request instead of two.
 *
 * @param projectId - Owning project id.
 * @param taskId - Task that changed.
 */
export function emitTaskEvent(projectId: string, taskId: string): void {
  broker.dispatchMany([
    {
      key: `task:${taskId}`,
      payload: { kind: "task", projectId, taskId } satisfies RealtimeEvent,
    },
    {
      key: `project:${projectId}`,
      payload: { kind: "project", projectId } satisfies RealtimeEvent,
    },
  ]);
}

/**
 * Emit a note-affecting event. Channel selection follows visibility:
 *
 * - A team note rides `project:<projectId>`, the channel every project
 *   member subscribes to on connect, so tree-list and task-backlink
 *   changes fan out to every member.
 * - A private note rides `note:<noteId>`, the fetch-implicit channel the
 *   note detail route registers (mirroring `task:<id>`). RLS confines
 *   private-note fetches to the creator, so only the creator's own
 *   sessions receive it: their other tabs stay CAS-fresh without leaking
 *   a project-wide timing signal of private activity. A team session
 *   still subscribed from before a private flip receives one event whose
 *   refetch 404s the now-inaccessible note, which is the correct heal.
 *
 * `updatedAt` lets the consumer skip refetches its caches already reflect
 * (the actor's own write, merged from the mutation response).
 *
 * @param projectId - Owning project id.
 * @param noteId - Note that changed.
 * @param visibility - The note's post-mutation visibility.
 * @param updatedAt - The note's post-mutation `updatedAt`; omit when the
 *   note no longer has one (delete).
 */
export function emitNoteEvent(
  projectId: string,
  noteId: string,
  visibility: Visibility,
  updatedAt?: Date,
): void {
  const payload = {
    kind: "note",
    projectId,
    noteId,
    ...(updatedAt !== undefined ? { updatedAt: updatedAt.toISOString() } : {}),
  } satisfies RealtimeEvent;
  broker.dispatch(
    visibility === "team" ? `project:${projectId}` : `note:${noteId}`,
    payload,
  );
}

/**
 * Emit project + both endpoint task events for an edge mutation. Avoids the
 * double project dispatch that two `emitTaskEvent` calls would produce.
 * Batched into one Workers sub-request.
 *
 * @param projectId - Owning project id.
 * @param sourceTaskId - Edge source.
 * @param targetTaskId - Edge target.
 */
export function emitEdgeMutation(
  projectId: string,
  sourceTaskId: string,
  targetTaskId: string,
): void {
  broker.dispatchMany([
    {
      key: `task:${sourceTaskId}`,
      payload: {
        kind: "task",
        projectId,
        taskId: sourceTaskId,
      } satisfies RealtimeEvent,
    },
    {
      key: `task:${targetTaskId}`,
      payload: {
        kind: "task",
        projectId,
        taskId: targetTaskId,
      } satisfies RealtimeEvent,
    },
    {
      key: `project:${projectId}`,
      payload: { kind: "project", projectId } satisfies RealtimeEvent,
    },
  ]);
}

/**
 * Dispatch a `project-list` event to a single user. Used by the
 * membership-change helpers in `lib/realtime/access.ts` so a kicked / added
 * user's home grid refreshes without waiting for focus refetch.
 *
 * @param userId - Recipient user id.
 * @param orgId - Organization that triggered the list change.
 */
export function emitProjectListForUser(userId: string, orgId: string): void {
  broker.dispatch(`project-list:${userId}`, {
    kind: "project-list",
    orgId,
  } satisfies RealtimeEvent);
}

/**
 * Emit a project-list event to every member of an organization. Used for
 * project create/delete so home grids update without a full refetch loop.
 * Realtime delivery failures (e.g. transient DB blip on member lookup) are
 * logged and swallowed — emit is a non-essential side effect of the API
 * mutation that already committed.
 *
 * Uses `dispatchMany` so an org with M members costs one DO sub-request on
 * Cloudflare rather than M (the Workers sub-request ceiling is 1000). On
 * self-host the call degenerates to a `dispatch` loop.
 *
 * @param orgId - Organization id.
 */
export async function emitProjectListEvent(orgId: string): Promise<void> {
  try {
    const userIds = await findOrgMemberUserIdsAsAdmin(orgId);
    if (userIds.length === 0) return;
    broker.dispatchMany(
      userIds.map((userId) => ({
        key: `project-list:${userId}` as const,
        payload: {
          kind: "project-list",
          orgId,
        } satisfies RealtimeEvent,
      })),
    );
  } catch (err) {
    console.error("[realtime] emitProjectListEvent failed:", err);
  }
}

/**
 * Emit a `project-deleted` event so workspace tabs viewing the project can
 * redirect, plus a project-list event to refresh every member's home grid.
 * Failures are logged and swallowed for the same reason as
 * {@link emitProjectListEvent} — the project deletion already committed.
 *
 * @param projectId - Project that was deleted.
 * @param orgId - Owning organization id.
 */
export async function emitProjectDeleted(
  projectId: string,
  orgId: string,
): Promise<void> {
  try {
    broker.dispatch(`project:${projectId}`, {
      kind: "project-deleted",
      projectId,
    } satisfies RealtimeEvent);
    await emitProjectListEvent(orgId);
  } catch (err) {
    console.error("[realtime] emitProjectDeleted failed:", err);
  }
}
