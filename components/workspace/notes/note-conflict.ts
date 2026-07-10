import type { QueryClient } from "@tanstack/react-query";
import type { NoteFullResult } from "@/lib/data/note";
import { noteKeys } from "@/lib/query/keys";
import { clearNoteDirty, markNoteDirty } from "@/lib/query/note-cache";

/**
 * Framework-free core of the autosave conflict recovery. The
 * `useNoteAutosave` hook wires these to its React state; tests drive them
 * directly against a `QueryClient` and a buffer map.
 */

/** Fields buffered between editor commits and the next autosave flush. */
export type NotePendingPatch = { body?: string; title?: string };

/**
 * Live `stale_write` conflict with the failed patch stashed for re-apply.
 * The stash is what makes recovery lossless: the flush deletes the buffer
 * entry before the send, so without it the failed fields would be gone,
 * and re-committing the whole cached note would clobber remote changes to
 * fields the user never touched.
 */
export type NoteConflictState = {
  noteId: string;
  currentUpdatedAt: string;
  currentVersion: number;
  patch: NotePendingPatch;
};

/**
 * Fold a new `stale_write` failure into the live conflict state.
 * Consecutive stale flushes for the same note accumulate their patches
 * (newer fields win) so no failed field is ever dropped; a conflict for a
 * different note replaces the previous one.
 *
 * @param prev - Current conflict state, or null.
 * @param next - The new failure with its failed patch.
 * @returns The merged conflict state.
 */
export function mergeConflictStash(
  prev: NoteConflictState | null,
  next: NoteConflictState,
): NoteConflictState {
  if (prev === null || prev.noteId !== next.noteId) return next;
  return { ...next, patch: { ...prev.patch, ...next.patch } };
}

/**
 * List the fields a conflict patch carries, for banner copy.
 *
 * @param patch - The stashed failed patch.
 * @returns The conflicted field names in render order.
 */
export function conflictFields(
  patch: NotePendingPatch,
): Array<"title" | "body"> {
  const fields: Array<"title" | "body"> = [];
  if (patch.title !== undefined) fields.push("title");
  if (patch.body !== undefined) fields.push("body");
  return fields;
}

/**
 * Resolve a conflict by dropping the local draft: delete the note's
 * buffer entry (a post-conflict commit may have re-buffered), release the
 * dirty gate, and invalidate the detail and list so remote truth
 * refetches. The caller clears its conflict state and pending id.
 *
 * @param qc - QueryClient.
 * @param projectId - Owning project id.
 * @param noteId - Conflicted note id.
 * @param buffers - The autosave hook's pending-patch buffer map.
 */
export function resolveNoteConflictDrop(
  qc: QueryClient,
  projectId: string,
  noteId: string,
  buffers: Map<string, NotePendingPatch>,
): void {
  buffers.delete(noteId);
  clearNoteDirty(noteId);
  qc.invalidateQueries({ queryKey: noteKeys.detail(projectId, noteId) });
  qc.invalidateQueries({ queryKey: noteKeys.list(projectId) });
}

/**
 * Resolve a conflict by re-applying the local draft: install the
 * conflict's fresh `updatedAt`/`version` into the cached detail as the
 * next CAS baseline (the send-time token reads the detail first; the
 * `currentUpdatedAt` string came from `toISOString`, so the `Date`
 * round-trips byte-exact through `casToken`), then
 * re-buffer exactly the stashed failed fields merged under any newer
 * buffered fields, so an untouched field is never re-sent. The caller
 * clears its conflict state and flushes; a raced remote write fails
 * `stale_write` again and re-surfaces the banner, so no path silently
 * overwrites.
 *
 * @param qc - QueryClient.
 * @param projectId - Owning project id.
 * @param conflict - The live conflict with its stashed patch.
 * @param buffers - The autosave hook's pending-patch buffer map.
 */
export function resolveNoteConflictReapply(
  qc: QueryClient,
  projectId: string,
  conflict: NoteConflictState,
  buffers: Map<string, NotePendingPatch>,
): void {
  qc.setQueryData<NoteFullResult>(
    noteKeys.detail(projectId, conflict.noteId),
    (detail) =>
      detail
        ? {
            ...detail,
            note: {
              ...detail.note,
              updatedAt: new Date(conflict.currentUpdatedAt),
              version: conflict.currentVersion,
            },
          }
        : detail,
  );
  buffers.set(conflict.noteId, {
    ...conflict.patch,
    ...buffers.get(conflict.noteId),
  });
  markNoteDirty(conflict.noteId);
}
