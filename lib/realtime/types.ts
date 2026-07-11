/**
 * Wire-format shared between the SSE producer (server) and the
 * `RealtimeBridge` consumer (client). This module has no runtime side
 * effects so it is safe to import from both environments — the
 * `server-only` boundary lives in `events.ts` (which uses these types) and
 * `broker.ts` (which holds connections in process memory).
 */

/** Discriminated payload shape sent on the SSE wire. */
export type RealtimeEvent =
  | { kind: "project"; projectId: string }
  | { kind: "task"; projectId: string; taskId: string }
  | {
      kind: "note";
      projectId: string;
      noteId: string;
      updatedAt?: string;
      version?: number;
      revisionCheckpointed?: boolean;
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
