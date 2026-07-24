/**
 * Wire-format shared between the SSE producer (server) and the
 * `RealtimeBridge` consumer (client). This module has no runtime side
 * effects so it is safe to import from both environments — the
 * `server-only` boundary lives in `events.ts` (which uses these types) and
 * `broker.ts` (which holds connections in process memory).
 */

import type { Estimate, Priority } from "@/lib/types";

/**
 * Post-write snapshot of a task's state-neutral slim fields. None of
 * these feed the derived task state, so consumers merge the snapshot
 * into cached graph and my-tasks rows and skip the refetch. Always a
 * full snapshot of these fields (never a diff) so an applied patch
 * fully syncs them.
 */
export type TaskSlimPatch = {
  title?: string;
  category?: string | null;
  tags?: string[];
  priority?: Priority | null;
  estimate?: Estimate | null;
  order?: number;
  hasExecutionRecord?: boolean;
  assigneeUserIds?: string[];
  assigneeCount?: number;
};

/** Discriminated payload shape sent on the SSE wire. */
export type RealtimeEvent =
  | {
      kind: "project";
      projectId: string;
      /** Set on the paired event emitted per task write: the task whose
       *  write produced this project event. Rides the project channel
       *  (the one every member holds) so list surfaces can patch cached
       *  rows in place when the refetch is skipped. */
      taskId?: string;
      /** The task's post-mutation content `updatedAt`; rides beside
       *  `taskId` for the in-place patch. */
      updatedAt?: string;
      /** False when the originating task/edge write cannot change the slim
       *  graph payload (plan/record/decision/link writes, edge note-only
       *  edits); consumers skip the graph and my-tasks refetches. Absent
       *  means unknown; treat as changed. */
      metaChanged?: boolean;
      /** Present when the write's slim changes are state-neutral:
       *  consumers merge it into cached rows instead of refetching.
       *  Absent on state-affecting writes (status, presence flips,
       *  create/delete, edges), which must invalidate. */
      patch?: TaskSlimPatch;
    }
  | {
      kind: "task";
      projectId: string;
      taskId: string;
      /** The task's post-mutation content `updatedAt`; lets consumers
       *  patch cached list rows in place when the refetch is skipped. */
      updatedAt?: string;
      /** False when the write cannot change the slim graph payload;
       *  mirrors the paired project event's flag. Absent means unknown;
       *  treat as changed. */
      metaChanged?: boolean;
      /** Mirrors the paired project event's patch snapshot. */
      patch?: TaskSlimPatch;
    }
  | {
      kind: "note";
      projectId: string;
      noteId: string;
      updatedAt?: string;
      version?: number;
      revisionCheckpointed?: boolean;
      /** False when the write cannot change the slim graph payload
       *  (body-only edits with an unchanged link set, share markers);
       *  consumers skip the graph refetch. Folder moves emit true — they
       *  bump the metadata clock. Absent means unknown; treat as
       *  changed. */
      metaChanged?: boolean;
    }
  | {
      kind: "note-presence";
      noteId: string;
      userId: string;
      name: string;
      image: string | null;
      state: "editing" | "gone";
    }
  | { kind: "note-folders"; projectId: string }
  | { kind: "project-list"; orgId: string }
  | { kind: "project-deleted"; projectId: string };
