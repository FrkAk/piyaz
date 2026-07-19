/**
 * Wire-format shared between the SSE producer (server) and the
 * `RealtimeBridge` consumer (client). This module has no runtime side
 * effects so it is safe to import from both environments — the
 * `server-only` boundary lives in `events.ts` (which uses these types) and
 * `broker.ts` (which holds connections in process memory).
 */

/** Discriminated payload shape sent on the SSE wire. */
export type RealtimeEvent =
  | {
      kind: "project";
      projectId: string;
      /** False when the originating task/edge write cannot change the slim
       *  graph payload (plan/record/decision/link writes, edge note-only
       *  edits); consumers skip the graph and my-tasks refetches. Absent
       *  means unknown; treat as changed. */
      metaChanged?: boolean;
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
