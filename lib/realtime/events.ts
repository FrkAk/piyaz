import "server-only";
import { findOrgMemberUserIdsAsAdmin } from "@/lib/data/membership";
import { broker } from "@/lib/realtime/broker";
import type { RealtimeEvent, TaskSlimPatch } from "@/lib/realtime/types";
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
 * Emit a task-affecting event. Always paired with the project event, which
 * owns the graph and my-tasks invalidations; the paired payload carries
 * the task id and content clock because `project:<id>` is the channel
 * every member holds (task channels are fetch-implicit), so the my-tasks
 * in-place patch must ride it to reliably reach list viewers. Batched via
 * `dispatchMany` so the Workers backend costs one DO sub-request instead
 * of two.
 *
 * @param projectId - Owning project id.
 * @param taskId - Task that changed.
 * @param opts - `metaChanged`: whether the write changed anything the
 *   slim graph payload renders (rides both payloads; `false` marks
 *   plan/record/decision/link writes so consumers skip the slim-graph and
 *   my-tasks refetches; omit when unknown). `updatedAt`: the post-mutation
 *   content clock so consumers can patch cached list rows in place when
 *   the refetch is skipped. `patch`: post-write snapshot of the task's
 *   state-neutral slim fields; pass it when the write's slim changes
 *   cannot alter any derived task state so consumers merge it in place
 *   instead of refetching the graph.
 */
export function emitTaskEvent(
  projectId: string,
  taskId: string,
  opts?: { metaChanged?: boolean; updatedAt?: Date; patch?: TaskSlimPatch },
): void {
  const metaChanged = opts?.metaChanged;
  const updatedAt =
    opts?.updatedAt !== undefined
      ? { updatedAt: opts.updatedAt.toISOString() }
      : {};
  const flag = metaChanged !== undefined ? { metaChanged } : {};
  const patch = opts?.patch !== undefined ? { patch: opts.patch } : {};
  broker.dispatchMany([
    {
      key: `task:${taskId}`,
      payload: {
        kind: "task",
        projectId,
        taskId,
        ...updatedAt,
        ...flag,
        ...patch,
      } satisfies RealtimeEvent,
    },
    {
      key: `project:${projectId}`,
      payload: {
        kind: "project",
        projectId,
        taskId,
        ...updatedAt,
        ...flag,
        ...patch,
      } satisfies RealtimeEvent,
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
 *   still subscribed from before a private flip receives the flip event
 *   itself (its refetch 404s the now-inaccessible note, the correct
 *   heal) and is then dropped from the channel by
 *   {@link purgeNoteChannel}, so no later private-note or presence
 *   events reach former viewers.
 *
 * `updatedAt` lets the consumer skip refetches its caches already reflect
 * (the actor's own write, merged from the mutation response); `version`
 * and `revisionCheckpointed` let it maintain the revisions query without a
 * refetch: the version bumps on every body change, but the stored revision
 * list only changes when a write archived a pre-image checkpoint.
 *
 * @param projectId - Owning project id.
 * @param noteId - Note that changed.
 * @param visibility - The note's post-mutation visibility.
 * @param updatedAt - The note's post-mutation `updatedAt`; omit when the
 *   note no longer has one (delete).
 * @param version - The note's post-mutation `version`; omit when unknown
 *   (delete).
 * @param revisionCheckpointed - Whether the write archived a revision
 *   checkpoint (the stored revision list changed).
 * @param metaChanged - Whether the write moved the note's graph-visible
 *   metadata or link set (`notes.meta_updated_at`). Pass `false` on
 *   graph-inert writes so consumers skip the slim-graph refetch; omit
 *   when unknown or always graph-visible.
 */
export function emitNoteEvent(
  projectId: string,
  noteId: string,
  visibility: Visibility,
  updatedAt?: Date,
  version?: number,
  revisionCheckpointed?: boolean,
  metaChanged?: boolean,
): void {
  const payload = {
    kind: "note",
    projectId,
    noteId,
    ...(updatedAt !== undefined ? { updatedAt: updatedAt.toISOString() } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(revisionCheckpointed !== undefined ? { revisionCheckpointed } : {}),
    ...(metaChanged !== undefined ? { metaChanged } : {}),
  } satisfies RealtimeEvent;
  broker.dispatch(
    visibility === "team" ? `project:${projectId}` : `note:${noteId}`,
    payload,
  );
}

/**
 * Emit one note event per moved row of a subtree folder move, batched into
 * a single broker call (`dispatchMany` costs one DO sub-request on
 * Workers). Channel selection per row follows {@link emitNoteEvent}: team
 * rows ride `project:<projectId>`, private rows ride `note:<noteId>`.
 * Every event carries `metaChanged: true` (the move bumped
 * `meta_updated_at`) and the post-move `updatedAt`/`version`, so open
 * remote editors refresh their cached detail — and with it the CAS
 * token — instead of hitting a spurious stale-write conflict on their
 * next autosave.
 *
 * @param projectId - Owning project id.
 * @param notes - Post-move rows: id, visibility, `updatedAt`, `version`.
 */
export function emitNoteEventsBatch(
  projectId: string,
  notes: Array<{
    id: string;
    visibility: Visibility;
    updatedAt: Date;
    version: number;
  }>,
): void {
  if (notes.length === 0) return;
  broker.dispatchMany(
    notes.map((note) => ({
      key:
        note.visibility === "team"
          ? (`project:${projectId}` as const)
          : (`note:${note.id}` as const),
      payload: {
        kind: "note",
        projectId,
        noteId: note.id,
        updatedAt: note.updatedAt.toISOString(),
        version: note.version,
        metaChanged: true,
      } satisfies RealtimeEvent,
    })),
  );
}

/**
 * Drop every subscription on a note's fetch-implicit channel except the
 * creator's. Called after a team-to-private flip: former viewers
 * registered `note:<id>` while the note was shared and would otherwise
 * keep receiving edit-timing, version, and presence events until their
 * 10-minute TTL lapsed. Callers dispatch the flip's own note event before
 * purging so still-subscribed sessions receive the final heal event
 * (best-effort on Workers, where the two DO sub-requests may land out of
 * order).
 *
 * @param noteId - Note whose channel to purge.
 * @param keepUserId - The creator; their sessions stay subscribed.
 */
export function purgeNoteChannel(noteId: string, keepUserId: string): void {
  broker.purgeKeySubs(`note:${noteId}`, keepUserId);
}

/**
 * Emit an editing-presence event for a note. Rides `note:<noteId>` only:
 * the viewers are exactly the fetch-implicit subscribers the note detail
 * route registered, and on a private note that channel's membership is
 * RLS-confined to the creator's own sessions. Presence never invalidates
 * queries, so no `projectId` travels with it.
 *
 * @param noteId - Note being viewed.
 * @param actor - Session-derived sender identity; never client-supplied.
 * @param state - `editing` upserts the sender, `gone` removes it.
 */
export function emitNotePresence(
  noteId: string,
  actor: { userId: string; name: string; image: string | null },
  state: "editing" | "gone",
): void {
  broker.dispatch(`note:${noteId}`, {
    kind: "note-presence",
    noteId,
    userId: actor.userId,
    name: actor.name,
    image: actor.image,
    state,
  } satisfies RealtimeEvent);
}

/**
 * Emit an explicit-note-folders change event. Rides `project:<projectId>`:
 * folder marker rows are team-visible structural metadata, so every member's
 * cached folder list refreshes. Callers dispatch only when marker rows
 * actually changed — an idempotent duplicate create or a zero-row delete
 * stays silent.
 *
 * @param projectId - Project whose explicit folder set changed.
 */
export function emitNoteFoldersEvent(projectId: string): void {
  broker.dispatch(`project:${projectId}`, {
    kind: "note-folders",
    projectId,
  } satisfies RealtimeEvent);
}

/**
 * Emit project + both endpoint task events for an edge mutation. Avoids the
 * double project dispatch that two `emitTaskEvent` calls would produce.
 * Batched into one Workers sub-request.
 *
 * @param projectId - Owning project id.
 * @param sourceTaskId - Edge source.
 * @param targetTaskId - Edge target.
 * @param metaChanged - Whether the write moved `task_edges.meta_updated_at`
 *   (create/remove/type change yes, note-only annotation edits no). Rides
 *   all three payloads; `false` lets consumers skip the slim-graph and
 *   my-tasks refetches. Omit when unknown.
 */
export function emitEdgeMutation(
  projectId: string,
  sourceTaskId: string,
  targetTaskId: string,
  metaChanged?: boolean,
): void {
  const flag = metaChanged !== undefined ? { metaChanged } : {};
  broker.dispatchMany([
    {
      key: `task:${sourceTaskId}`,
      payload: {
        kind: "task",
        projectId,
        taskId: sourceTaskId,
        ...flag,
      } satisfies RealtimeEvent,
    },
    {
      key: `task:${targetTaskId}`,
      payload: {
        kind: "task",
        projectId,
        taskId: targetTaskId,
        ...flag,
      } satisfies RealtimeEvent,
    },
    {
      key: `project:${projectId}`,
      payload: { kind: "project", projectId, ...flag } satisfies RealtimeEvent,
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
