"use server";

import {
  noteFailureFrom,
  type NoteActionResult,
} from "@/lib/actions/note-errors";
import {
  authorizeWrite,
  type ActionRateLimitConfig,
} from "@/lib/actions/rate-limit-action";
import {
  approveShareRequest as coreApproveShareRequest,
  createNote as coreCreateNote,
  createNoteFolder as coreCreateNoteFolder,
  declineShareRequest as coreDeclineShareRequest,
  deleteNote as coreDeleteNote,
  deleteNoteFolder as coreDeleteNoteFolder,
  moveFolder as coreMoveFolder,
  moveNote as coreMoveNote,
  restoreNote as coreRestoreNote,
  restoreNoteRevision as coreRestoreNoteRevision,
  updateNote as coreUpdateNote,
  type CreateNoteInput,
  type NoteLinksRefresh,
  type NotePatch,
  type NoteRevisionCheckpoint,
  type NoteSummary,
} from "@/lib/data/note";

/**
 * Per-action budgets for the note web write path, shaped like
 * `WRITE_BUDGETS` in `lib/graph/mutations.ts`: server actions POST to the
 * page route so the middleware limiter never sees them; these budgets are
 * the only throttle here. `noteUpdate` mirrors `task.update` because the
 * ~600ms autosave debounce commits at most ~100 writes/min of continuous
 * typing, and settings patches ride the same budget. Window is 60s.
 */
const DEFAULT_NOTE_BUDGET = {
  windowSeconds: 60,
  perUserMax: 60,
  perIpMax: 120,
} as const;

const NOTE_BUDGETS = {
  noteCreate: { ...DEFAULT_NOTE_BUDGET, action: "note.create" },
  noteUpdate: {
    action: "note.update",
    windowSeconds: 60,
    perUserMax: 180,
    perIpMax: 300,
  },
  noteDelete: { ...DEFAULT_NOTE_BUDGET, action: "note.delete" },
  noteMove: { ...DEFAULT_NOTE_BUDGET, action: "note.move" },
  noteShare: { ...DEFAULT_NOTE_BUDGET, action: "note.share" },
} satisfies Record<string, ActionRateLimitConfig>;

/**
 * Server action: create a note in a project.
 * @param input - Note fields; slug is allocated internally.
 * @returns Slim summary of the created note, or a typed failure.
 */
export async function createNoteAction(
  input: CreateNoteInput,
): Promise<NoteActionResult<NoteSummary>> {
  try {
    const ctx = await authorizeWrite(NOTE_BUDGETS.noteCreate);
    return { ok: true, data: await coreCreateNote(ctx, input) };
  } catch (err) {
    const failure = noteFailureFrom(err);
    if (failure.code === "unknown") {
      console.error("createNoteAction failed", {
        projectId: input.projectId,
        err,
      });
    }
    return failure;
  }
}

/**
 * Server action: patch a note's scalar fields with optimistic concurrency.
 * A stale `ifUpdatedAt` returns a `stale_write` failure carrying the live
 * `updatedAt` (next retry token) and `version`; the server applies no write.
 *
 * @param noteId - Note id.
 * @param patch - Fields to update.
 * @param ifUpdatedAt - The cached `updatedAt` as CAS token; omit to force.
 * @returns Slim summary with the fresh `updatedAt` (plus re-derived
 *   `links` on a body change), or a typed failure.
 */
export async function updateNoteAction(
  noteId: string,
  patch: NotePatch,
  ifUpdatedAt?: string,
): Promise<
  NoteActionResult<
    NoteSummary & {
      links?: NoteLinksRefresh;
      revisionCheckpoint?: NoteRevisionCheckpoint;
    }
  >
> {
  try {
    const ctx = await authorizeWrite(NOTE_BUDGETS.noteUpdate);
    return {
      ok: true,
      data: await coreUpdateNote(ctx, noteId, patch, ifUpdatedAt),
    };
  } catch (err) {
    const failure = noteFailureFrom(err);
    if (failure.code === "unknown") {
      console.error("updateNoteAction failed", { noteId, err });
    }
    return failure;
  }
}

/**
 * Server action: restore a note's title and body to a stored revision.
 * Writes through the note-update path (it IS an update: same budget, CAS,
 * lock, and event semantics); the revert is append-only: the pre-restore
 * state is checkpointed, nothing destroyed. A stale `ifUpdatedAt` returns a
 * `stale_write` failure; a missing version returns a `validation` failure
 * naming the available versions.
 *
 * @param noteId - Note id.
 * @param version - Revision counter value to restore.
 * @param ifUpdatedAt - The cached `updatedAt` as CAS token; omit to force.
 * @returns Slim summary with the fresh `updatedAt` (plus re-derived
 *   `links` on a body change), or a typed failure.
 */
export async function restoreRevisionAction(
  noteId: string,
  version: number,
  ifUpdatedAt?: string,
): Promise<
  NoteActionResult<
    NoteSummary & {
      links?: NoteLinksRefresh;
      revisionCheckpoint?: NoteRevisionCheckpoint;
    }
  >
> {
  try {
    const ctx = await authorizeWrite(NOTE_BUDGETS.noteUpdate);
    return {
      ok: true,
      data: await coreRestoreNoteRevision(ctx, noteId, version, {
        ifUpdatedAt,
      }),
    };
  } catch (err) {
    const failure = noteFailureFrom(err);
    if (failure.code === "unknown") {
      console.error("restoreRevisionAction failed", { noteId, version, err });
    }
    return failure;
  }
}

/**
 * Server action: soft-delete a note with optimistic concurrency. The
 * returned `updatedAt` is the restore-undo CAS token.
 *
 * @param noteId - Note id.
 * @param ifUpdatedAt - The cached `updatedAt` as CAS token; omit to force.
 * @returns The id, deletion timestamp, and post-delete `updatedAt`, or a
 *   typed failure.
 */
export async function deleteNoteAction(
  noteId: string,
  ifUpdatedAt?: string,
): Promise<NoteActionResult<{ id: string; deletedAt: Date; updatedAt: Date }>> {
  try {
    const ctx = await authorizeWrite(NOTE_BUDGETS.noteDelete);
    return { ok: true, data: await coreDeleteNote(ctx, noteId, ifUpdatedAt) };
  } catch (err) {
    const failure = noteFailureFrom(err);
    if (failure.code === "unknown") {
      console.error("deleteNoteAction failed", { noteId, err });
    }
    return failure;
  }
}

/**
 * Server action: restore a soft-deleted note (undo of a delete). The
 * slug may differ from before the delete when its namespace was taken.
 *
 * @param noteId - Note id.
 * @param ifUpdatedAt - The delete's returned `updatedAt` as CAS token;
 *   omit for an idempotent tokenless restore.
 * @returns Slim summary of the restored note, or a typed failure.
 */
export async function restoreNoteAction(
  noteId: string,
  ifUpdatedAt?: string,
): Promise<NoteActionResult<NoteSummary>> {
  try {
    const ctx = await authorizeWrite(NOTE_BUDGETS.noteDelete);
    return { ok: true, data: await coreRestoreNote(ctx, noteId, ifUpdatedAt) };
  } catch (err) {
    const failure = noteFailureFrom(err);
    if (failure.code === "unknown") {
      console.error("restoreNoteAction failed", { noteId, err });
    }
    return failure;
  }
}

/**
 * Server action: move a note to another folder with optimistic
 * concurrency.
 *
 * @param noteId - Note id.
 * @param folder - Destination folder path.
 * @param ifUpdatedAt - The cached `updatedAt` as CAS token; omit to force.
 * @returns Slim summary of the moved note, or a typed failure.
 */
export async function moveNoteAction(
  noteId: string,
  folder: string,
  ifUpdatedAt?: string,
): Promise<NoteActionResult<NoteSummary>> {
  try {
    const ctx = await authorizeWrite(NOTE_BUDGETS.noteMove);
    return {
      ok: true,
      data: await coreMoveNote(ctx, noteId, folder, ifUpdatedAt),
    };
  } catch (err) {
    const failure = noteFailureFrom(err);
    if (failure.code === "unknown") {
      console.error("moveNoteAction failed", { noteId, err });
    }
    return failure;
  }
}

/**
 * Server action: re-parent a folder subtree (tree drag-and-drop and
 * rename paths).
 * @param projectId - Owning project id.
 * @param src - Folder path being moved.
 * @param destParent - New parent folder path (empty string for root).
 * @param leaf - Replacement folder name; omit to keep `src`'s leaf.
 * @returns The destination path and moved-note count, or a typed failure.
 */
export async function moveFolderAction(
  projectId: string,
  src: string,
  destParent: string,
  leaf?: string,
): Promise<NoteActionResult<{ dest: string; movedCount: number }>> {
  try {
    const ctx = await authorizeWrite(NOTE_BUDGETS.noteMove);
    return {
      ok: true,
      data: await coreMoveFolder(ctx, projectId, src, destParent, leaf),
    };
  } catch (err) {
    const failure = noteFailureFrom(err);
    if (failure.code === "unknown") {
      console.error("moveFolderAction failed", { projectId, err });
    }
    return failure;
  }
}

/**
 * Server action: persist an explicitly created empty folder.
 * @param projectId - Owning project id.
 * @param path - Folder path to persist.
 * @returns The normalized persisted path, or a typed failure.
 */
export async function createFolderAction(
  projectId: string,
  path: string,
): Promise<NoteActionResult<{ path: string }>> {
  try {
    const ctx = await authorizeWrite(NOTE_BUDGETS.noteCreate);
    return { ok: true, data: await coreCreateNoteFolder(ctx, projectId, path) };
  } catch (err) {
    const failure = noteFailureFrom(err);
    if (failure.code === "unknown") {
      console.error("createFolderAction failed", { projectId, err });
    }
    return failure;
  }
}

/**
 * Server action: delete a folder's explicit marker rows (the path and its
 * explicit descendants). Notes under the folder are deleted separately.
 *
 * @param projectId - Owning project id.
 * @param path - Folder path to delete.
 * @returns The deleted marker-row count, or a typed failure.
 */
export async function deleteFolderAction(
  projectId: string,
  path: string,
): Promise<NoteActionResult<{ deletedCount: number }>> {
  try {
    const ctx = await authorizeWrite(NOTE_BUDGETS.noteDelete);
    return { ok: true, data: await coreDeleteNoteFolder(ctx, projectId, path) };
  } catch (err) {
    const failure = noteFailureFrom(err);
    if (failure.code === "unknown") {
      console.error("deleteFolderAction failed", { projectId, err });
    }
    return failure;
  }
}

/**
 * Server action: approve a pending share request, flipping the note to
 * `team` and clearing `shareRequestedBy`. Human-only by construction:
 * agents are confined to `/api/mcp`, which never routes here.
 *
 * @param noteId - Note id.
 * @returns Slim summary, or a typed failure (`share_state` when no request
 *   is pending).
 */
export async function approveShareRequestAction(
  noteId: string,
): Promise<NoteActionResult<NoteSummary>> {
  try {
    const ctx = await authorizeWrite(NOTE_BUDGETS.noteShare);
    return { ok: true, data: await coreApproveShareRequest(ctx, noteId) };
  } catch (err) {
    const failure = noteFailureFrom(err);
    if (failure.code === "unknown") {
      console.error("approveShareRequestAction failed", { noteId, err });
    }
    return failure;
  }
}

/**
 * Server action: decline a pending share request, clearing
 * `shareRequestedBy` while the note stays private. Human-only by
 * construction: agents are confined to `/api/mcp`, which never routes here.
 *
 * @param noteId - Note id.
 * @returns Slim summary, or a typed failure (`share_state` when no request
 *   is pending).
 */
export async function declineShareRequestAction(
  noteId: string,
): Promise<NoteActionResult<NoteSummary>> {
  try {
    const ctx = await authorizeWrite(NOTE_BUDGETS.noteShare);
    return { ok: true, data: await coreDeclineShareRequest(ctx, noteId) };
  } catch (err) {
    const failure = noteFailureFrom(err);
    if (failure.code === "unknown") {
      console.error("declineShareRequestAction failed", { noteId, err });
    }
    return failure;
  }
}
