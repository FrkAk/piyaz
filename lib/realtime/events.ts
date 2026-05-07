import "server-only";
import { findOrgMemberUserIds } from "@/lib/data/membership";
import { broker } from "@/lib/realtime/broker";
import type { RealtimeEvent } from "@/lib/realtime/types";

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
 * change is also a slim graph change.
 *
 * @param projectId - Owning project id.
 * @param taskId - Task that changed.
 */
export function emitTaskEvent(projectId: string, taskId: string): void {
  broker.dispatch(`task:${taskId}`, {
    kind: "task",
    projectId,
    taskId,
  } satisfies RealtimeEvent);
  broker.dispatch(`project:${projectId}`, {
    kind: "project",
    projectId,
  } satisfies RealtimeEvent);
}

/**
 * Emit project + both endpoint task events for an edge mutation. Avoids the
 * double project dispatch that two `emitTaskEvent` calls would produce.
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
  broker.dispatch(`task:${sourceTaskId}`, {
    kind: "task",
    projectId,
    taskId: sourceTaskId,
  } satisfies RealtimeEvent);
  broker.dispatch(`task:${targetTaskId}`, {
    kind: "task",
    projectId,
    taskId: targetTaskId,
  } satisfies RealtimeEvent);
  broker.dispatch(`project:${projectId}`, {
    kind: "project",
    projectId,
  } satisfies RealtimeEvent);
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
 * @param orgId - Organization id.
 */
export async function emitProjectListEvent(orgId: string): Promise<void> {
  try {
    const userIds = await findOrgMemberUserIds(orgId);
    for (const userId of userIds) {
      broker.dispatch(`project-list:${userId}`, {
        kind: "project-list",
        orgId,
      } satisfies RealtimeEvent);
    }
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
