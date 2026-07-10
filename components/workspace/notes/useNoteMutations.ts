"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type {
  NoteActionFailure,
  NoteActionResult,
} from "@/lib/actions/note-errors";
import {
  approveShareRequestAction,
  createFolderAction,
  createNoteAction,
  declineShareRequestAction,
  deleteFolderAction,
  deleteNoteAction,
  moveFolderAction,
  moveNoteAction,
  restoreNoteAction,
  restoreRevisionAction,
  updateNoteAction,
} from "@/lib/actions/note";
import type {
  CreateNoteInput,
  NoteFull,
  NoteFullResult,
  NoteLinksRefresh,
  NotePatch,
  NoteSummary,
  NoteTreeRow,
} from "@/lib/data/note";
import { noteKeys } from "@/lib/query/keys";
import {
  conflictFields,
  mergeConflictStash,
  resolveNoteConflictDrop,
  resolveNoteConflictReapply,
  type NoteConflictState,
  type NotePendingPatch,
} from "@/components/workspace/notes/note-conflict";
import {
  beginNoteEditSession,
  cachedCasToken,
  casToken,
  clearNoteDirty,
  clearNoteDirtyUnlessEditing,
  clearNoteTrashed,
  endNoteEditSession,
  enqueueNoteWrite,
  isNoteTrashed,
  markNoteDirty,
  markNoteTrashed,
  mergeLinksIntoDetail,
  mergeSummaryIntoDetail,
  moveFolderInTree,
  patchNoteInTree,
  removeNoteFromTree,
  revertPatchInTree,
  revertPatchOnDetail,
  upsertNoteInTree,
  type NoteTreePatch,
} from "@/lib/query/note-cache";

/** Debounce window between a block commit and the autosave flush. */
const AUTOSAVE_DEBOUNCE_MS = 600;

/** Ceiling for the exponential transport-failure retry backoff. */
const AUTOSAVE_RETRY_MAX_MS = 30_000;

/** Write result shared by every note patch path. */
type NoteWriteResult = NoteActionResult<
  NoteSummary & { links?: NoteLinksRefresh }
>;

/**
 * Apply the defined fields of a patch onto a cached detail entry.
 *
 * @param detail - Cached detail result.
 * @param patch - Patch whose defined fields overwrite the note.
 * @returns New detail result with the patch applied.
 */
function applyPatchToDetail(
  detail: NoteFullResult,
  patch: Partial<NoteFull>,
): NoteFullResult {
  const defined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) defined[key] = value;
  }
  return {
    ...detail,
    note: { ...detail.note, ...(defined as Partial<NoteFull>) },
  };
}

/**
 * Project the tree-visible fields out of a note patch.
 *
 * @param patch - Full note patch.
 * @returns Partial tree row with only the fields the tree list renders.
 */
function treePatchFrom(patch: Partial<NoteFull>): NoteTreePatch {
  return {
    title: patch.title,
    folder: patch.folder,
    summary: patch.summary,
    type: patch.type,
    visibility: patch.visibility,
    agentWritable: patch.agentWritable,
    locked: patch.locked,
  };
}

/**
 * Capture the current values of the fields a patch defines, for
 * field-scoped rollback.
 *
 * @param source - Object holding the current values.
 * @param patch - Patch whose defined keys select the fields.
 * @returns Partial with the captured values.
 */
function pickFields<T extends object>(
  source: T,
  patch: Partial<T>,
): Partial<T> {
  const prev: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if ((patch as Record<string, unknown>)[key] !== undefined) {
      prev[key] = (source as Record<string, unknown>)[key];
    }
  }
  return prev as Partial<T>;
}

/**
 * Shared optimistic core for note writes: apply the patch to the detail
 * and tree caches immediately, serialize the server call through the
 * per-note write chain, fold the response (summary plus any re-derived
 * links) into both caches on success, and field-scope-revert on failure
 * so an earlier failure never clobbers a newer optimistic write.
 *
 * On `stale_write` with `rollbackOnStale` false the optimistic content is
 * kept: the server applied no write, and the autosave conflict banner
 * owns recovery. Settings controls pass true so the control snaps back.
 *
 * The success merge is not field-scoped: an earlier chained write's
 * response can transiently overwrite a newer write's optimistic `title`
 * or `folder` until the newer write's own merge or revert lands one
 * round trip later. Every interleaving converges on server truth, so the
 * exposure is a brief flicker, accepted over tracking per-field
 * optimistic ownership.
 *
 * Exported for tests.
 *
 * @param qc - QueryClient.
 * @param projectId - Owning project id.
 * @param noteId - Note id.
 * @param detailPatch - Optimistic values for the detail cache.
 * @param send - Server call, executed inside the write chain.
 * @param rollbackOnStale - Revert the optimistic patch on `stale_write`.
 * @returns The typed action result; thrown transport errors revert first.
 */
export async function runOptimisticNoteWrite(
  qc: QueryClient,
  projectId: string,
  noteId: string,
  detailPatch: Partial<NoteFull>,
  send: () => Promise<NoteWriteResult>,
  rollbackOnStale: boolean,
): Promise<NoteWriteResult> {
  const detailKey = noteKeys.detail(projectId, noteId);
  const listKey = noteKeys.list(projectId);
  const treePatch = treePatchFrom(detailPatch);

  const prevDetail = qc.getQueryData<NoteFullResult>(detailKey);
  const prevDetailFields = prevDetail
    ? pickFields(prevDetail.note, detailPatch)
    : {};
  const prevRow = qc
    .getQueryData<NoteTreeRow[]>(listKey)
    ?.find((r) => r.id === noteId);
  const prevTreeFields = prevRow ? pickFields(prevRow, treePatch) : {};

  if (prevDetail !== undefined) {
    qc.setQueryData(detailKey, applyPatchToDetail(prevDetail, detailPatch));
  }
  qc.setQueryData<NoteTreeRow[]>(listKey, (rows) =>
    patchNoteInTree(rows, noteId, treePatch),
  );

  const revert = () => {
    qc.setQueryData<NoteFullResult>(detailKey, (d) =>
      revertPatchOnDetail(d, detailPatch, prevDetailFields),
    );
    qc.setQueryData<NoteTreeRow[]>(listKey, (rows) =>
      revertPatchInTree(rows, noteId, treePatch, prevTreeFields),
    );
  };

  return enqueueNoteWrite(noteId, async () => {
    let result: NoteWriteResult;
    try {
      result = await send();
    } catch (err) {
      revert();
      throw err;
    }
    if (result.ok) {
      qc.setQueryData<NoteFullResult>(detailKey, (d) =>
        mergeLinksIntoDetail(
          mergeSummaryIntoDetail(d, result.data),
          result.data.links,
        ),
      );
      qc.setQueryData<NoteTreeRow[]>(listKey, (rows) =>
        patchNoteInTree(rows, noteId, {
          slug: result.data.slug,
          title: result.data.title,
          folder: result.data.folder,
          updatedAt: result.data.updatedAt,
        }),
      );
      if (result.data.links !== undefined) {
        qc.invalidateQueries({ queryKey: noteKeys.backlinksAll(projectId) });
      }
      return result;
    }
    if (result.code === "stale_write" && !rollbackOnStale) return result;
    revert();
    return result;
  });
}

/**
 * Optimistic note creation: inserts a temp row into the cached tree list,
 * swaps it for the authoritative summary on success (the response carries
 * the server slug and timestamps, so no list refetch follows and the new
 * row keeps its position until the next natural refresh), and removes
 * only its temp row on failure, returned or thrown, so a concurrent
 * sibling optimistic write to another row survives the rollback.
 *
 * @param projectId - Owning project id.
 * @returns Mutation whose result is the typed `NoteActionResult`.
 */
export function useCreateNote(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: Omit<CreateNoteInput, "projectId">,
    ): Promise<NoteActionResult<NoteSummary>> => {
      const listKey = noteKeys.list(projectId);
      const hasList = qc.getQueryData<NoteTreeRow[]>(listKey) !== undefined;
      const tempRow: NoteTreeRow = {
        id: crypto.randomUUID(),
        slug: "",
        sequenceNumber: 0,
        title: input.title,
        type: input.type ?? "reference",
        folder: input.folder ?? "",
        summary: input.summary ?? "",
        visibility: input.visibility ?? "private",
        feedMode: input.feedMode ?? "none",
        agentWritable: true,
        locked: false,
        updatedAt: new Date(),
      };
      if (hasList) {
        qc.setQueryData<NoteTreeRow[]>(listKey, (rows) =>
          upsertNoteInTree(rows, tempRow),
        );
      }
      const removeTempRow = () => {
        qc.setQueryData<NoteTreeRow[]>(listKey, (rows) =>
          removeNoteFromTree(rows, tempRow.id),
        );
      };
      let result: NoteActionResult<NoteSummary>;
      try {
        result = await createNoteAction({ ...input, projectId });
      } catch (err) {
        removeTempRow();
        throw err;
      }
      if (result.ok) {
        qc.setQueryData<NoteTreeRow[]>(listKey, (rows) =>
          upsertNoteInTree(removeNoteFromTree(rows, tempRow.id), {
            ...tempRow,
            id: result.data.id,
            slug: result.data.slug,
            title: result.data.title,
            folder: result.data.folder,
            updatedAt: result.data.updatedAt,
          }),
        );
      } else {
        removeTempRow();
      }
      return result;
    },
  });
}

/**
 * Optimistic note patch with optimistic concurrency. Applies the patch to
 * the detail and tree caches up front; the server call rides the per-note
 * write chain, reading its CAS token at send time so chained writes never
 * trip each other. On success the response (summary plus re-derived links
 * on a body change) folds into both caches; no list or detail
 * revalidation. A patch to `visibility: "team"` also optimistically
 * clears `shareRequestedBy`, matching the server. Failure semantics live
 * on {@link runOptimisticNoteWrite}.
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking `{ noteId, patch, rollbackOnStale? }`.
 */
export function useUpdateNote(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      noteId: string;
      patch: NotePatch;
      rollbackOnStale?: boolean;
    }): Promise<NoteWriteResult> => {
      const { noteId, patch } = vars;
      const detailPatch: Partial<NoteFull> = { ...patch };
      if (patch.visibility === "team") detailPatch.shareRequestedBy = null;
      return runOptimisticNoteWrite(
        qc,
        projectId,
        noteId,
        detailPatch,
        () =>
          updateNoteAction(
            noteId,
            patch,
            cachedCasToken(qc, projectId, noteId),
          ),
        vars.rollbackOnStale === true,
      );
    },
  });
}

/**
 * Optimistic note move riding {@link runOptimisticNoteWrite}: cancels
 * in-flight list refetches (a stale response landing after success would
 * resurrect the old folder with no reconciling invalidation), patches the
 * folder on the detail and tree caches up front, serializes the server
 * call through the per-note write chain with a send-time CAS token, folds
 * the summary on success, and field-scope-reverts on any failure
 * including `stale_write` (no conflict banner owns move conflicts; the
 * caller surfaces the typed failure).
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking `{ noteId, folder }`.
 */
export function useMoveNote(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      noteId: string;
      folder: string;
    }): Promise<NoteWriteResult> => {
      await qc.cancelQueries({ queryKey: noteKeys.list(projectId) });
      return runOptimisticNoteWrite(
        qc,
        projectId,
        vars.noteId,
        { folder: vars.folder },
        () =>
          moveNoteAction(
            vars.noteId,
            vars.folder,
            cachedCasToken(qc, projectId, vars.noteId),
          ),
        true,
      );
    },
  });
}

/**
 * Delete write flow behind {@link useDeleteNote}: drops the cached tree
 * row up front; the server call rides the per-note write chain with a
 * send-time CAS token, falling back to the row token captured before the
 * optimistic removal (the removal empties the tree-side cache, so a
 * never-opened note would otherwise send no token). On success marks the
 * note trashed (autosave drops any later buffered edits), revalidates the
 * list, and removes the detail entry; on any failure, returned or thrown,
 * re-inserts only its own captured row. The detail entry is never
 * restored: the optimistic phase does not touch it, and rewriting it
 * would regress a chained-ahead autosave's merged `updatedAt`.
 *
 * @param qc - QueryClient.
 * @param projectId - Owning project id.
 * @param noteId - Note id.
 * @returns The typed action result; thrown transport errors roll back
 *   first.
 */
export async function runDeleteNoteWrite(
  qc: QueryClient,
  projectId: string,
  noteId: string,
): Promise<NoteActionResult<{ id: string; deletedAt: Date; updatedAt: Date }>> {
  const listKey = noteKeys.list(projectId);
  const detailKey = noteKeys.detail(projectId, noteId);
  const prevRow = qc
    .getQueryData<NoteTreeRow[]>(listKey)
    ?.find((r) => r.id === noteId);
  const fallbackToken = prevRow ? casToken(prevRow.updatedAt) : undefined;
  qc.setQueryData<NoteTreeRow[]>(listKey, (rows) =>
    removeNoteFromTree(rows, noteId),
  );
  const restoreOwnRow = () => {
    qc.setQueryData<NoteTreeRow[]>(listKey, (rows) =>
      prevRow ? upsertNoteInTree(rows, prevRow) : rows,
    );
  };
  return enqueueNoteWrite(noteId, async () => {
    let result: NoteActionResult<{
      id: string;
      deletedAt: Date;
      updatedAt: Date;
    }>;
    try {
      result = await deleteNoteAction(
        noteId,
        cachedCasToken(qc, projectId, noteId) ?? fallbackToken,
      );
    } catch (err) {
      restoreOwnRow();
      throw err;
    }
    if (result.ok) {
      clearNoteDirty(noteId);
      markNoteTrashed(noteId, result.data.updatedAt);
      qc.invalidateQueries({ queryKey: listKey });
      qc.removeQueries({ queryKey: detailKey });
    } else {
      restoreOwnRow();
    }
    return result;
  });
}

/**
 * Optimistic note delete over {@link runDeleteNoteWrite}.
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking the note id.
 */
export function useDeleteNote(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (noteId: string) => runDeleteNoteWrite(qc, projectId, noteId),
  });
}

/**
 * Restore a soft-deleted note (delete undo), serialized through the
 * per-note write chain so a rapid delete→undo issues strictly ordered
 * server calls and list invalidations. No optimistic surgery: the
 * restored row revalidates into the tree list on success, and the detail
 * cache was dropped at delete time so nothing local needs folding.
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking `{ noteId, ifUpdatedAt? }`; `ifUpdatedAt` is
 *   the delete's returned `updatedAt` acting as the undo CAS token.
 */
export function useRestoreNote(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      noteId: string;
      ifUpdatedAt?: string;
    }): Promise<NoteActionResult<NoteSummary>> =>
      enqueueNoteWrite(vars.noteId, async () => {
        const result = await restoreNoteAction(vars.noteId, vars.ifUpdatedAt);
        if (result.ok) {
          clearNoteTrashed(vars.noteId);
          qc.invalidateQueries({ queryKey: noteKeys.list(projectId) });
        }
        return result;
      }),
  });
}

/**
 * Revision-restore write flow behind {@link useRestoreRevision}:
 * serialized through the per-note write chain so it never races an
 * in-flight autosave; the CAS token is read at send time inside the
 * chained job for the same reason. No optimistic surgery: the restored
 * content is server-derived (the client holds no revision body), so
 * success invalidates the detail, tree list, events, and revisions
 * queries and the editor refetches the restored note. A `stale_write`
 * failure surfaces to the caller (the versions panel renders it inline;
 * no silent retry) and still invalidates, so the panel re-syncs to
 * server truth. Other failures invalidate nothing: the server applied no
 * write and the caches hold nothing optimistic.
 *
 * @param qc - QueryClient.
 * @param projectId - Owning project id.
 * @param noteId - Note id.
 * @param version - Revision counter value to restore.
 * @returns The typed action result.
 */
export async function runRestoreRevisionWrite(
  qc: QueryClient,
  projectId: string,
  noteId: string,
  version: number,
): Promise<NoteWriteResult> {
  return enqueueNoteWrite(noteId, async () => {
    const result = await restoreRevisionAction(
      noteId,
      version,
      cachedCasToken(qc, projectId, noteId),
    );
    if (result.ok || result.code === "stale_write") {
      qc.invalidateQueries({ queryKey: noteKeys.detail(projectId, noteId) });
      qc.invalidateQueries({ queryKey: noteKeys.list(projectId) });
      qc.invalidateQueries({ queryKey: noteKeys.events(projectId, noteId) });
      qc.invalidateQueries({
        queryKey: noteKeys.revisions(projectId, noteId),
      });
    }
    return result;
  });
}

/**
 * Revision restore over {@link runRestoreRevisionWrite}.
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking `{ noteId, version }`.
 */
export function useRestoreRevision(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { noteId: string; version: number }) =>
      runRestoreRevisionWrite(qc, projectId, vars.noteId, vars.version),
  });
}

/**
 * Optimistic folder subtree re-parent (tree drag-and-drop and rename):
 * rewrites every cached tree row under the planned destination up front
 * and restores the snapshot on any failure, returned or thrown. On
 * success the whole note prefix still revalidates against the server's
 * authoritative paths (tree, details, search, backlinks all render folder
 * paths; unchanged entries cost a bodiless 304).
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking `{ src, destParent, leaf?, dest }`.
 */
export function useMoveFolder(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      src: string;
      destParent: string;
      leaf?: string;
      dest: string;
    }): Promise<NoteActionResult<{ dest: string; movedCount: number }>> => {
      const listKey = noteKeys.list(projectId);
      const prevList = qc.getQueryData<NoteTreeRow[]>(listKey);
      qc.setQueryData<NoteTreeRow[]>(listKey, (rows) =>
        moveFolderInTree(rows, vars.src, vars.dest),
      );
      let result: NoteActionResult<{ dest: string; movedCount: number }>;
      try {
        result = await moveFolderAction(
          projectId,
          vars.src,
          vars.destParent,
          vars.leaf,
        );
      } catch (err) {
        if (prevList !== undefined) qc.setQueryData(listKey, prevList);
        throw err;
      }
      if (result.ok) {
        qc.invalidateQueries({ queryKey: noteKeys.all(projectId) });
      } else if (prevList !== undefined) {
        qc.setQueryData(listKey, prevList);
      }
      return result;
    },
  });
}

/**
 * Optimistic empty-folder create: appends the path to the cached folders
 * list up front, restores the snapshot on failure, returned or thrown.
 * Kept as-is on success: the server upsert is idempotent and returns
 * the same normalized path the optimistic entry used.
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking the normalized folder path.
 */
export function useCreateFolder(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      path: string,
    ): Promise<NoteActionResult<{ path: string }>> => {
      const foldersKey = noteKeys.folders(projectId);
      const prev = qc.getQueryData<string[]>(foldersKey);
      qc.setQueryData<string[]>(foldersKey, (paths) =>
        (paths ?? []).includes(path) ? paths : [...(paths ?? []), path].sort(),
      );
      let result: NoteActionResult<{ path: string }>;
      try {
        result = await createFolderAction(projectId, path);
      } catch (err) {
        if (prev !== undefined) qc.setQueryData(foldersKey, prev);
        throw err;
      }
      if (!result.ok && prev !== undefined) qc.setQueryData(foldersKey, prev);
      return result;
    },
  });
}

/**
 * Optimistic empty-folder delete: drops the path and its descendants
 * from the cached folders list up front, restores the snapshot on
 * failure, returned or thrown.
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking the folder path.
 */
export function useDeleteFolder(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      path: string,
    ): Promise<NoteActionResult<{ deletedCount: number }>> => {
      const foldersKey = noteKeys.folders(projectId);
      const prev = qc.getQueryData<string[]>(foldersKey);
      qc.setQueryData<string[]>(foldersKey, (paths) =>
        (paths ?? []).filter((p) => p !== path && !p.startsWith(`${path}/`)),
      );
      let result: NoteActionResult<{ deletedCount: number }>;
      try {
        result = await deleteFolderAction(projectId, path);
      } catch (err) {
        if (prev !== undefined) qc.setQueryData(foldersKey, prev);
        throw err;
      }
      if (!result.ok && prev !== undefined) qc.setQueryData(foldersKey, prev);
      return result;
    },
  });
}

/**
 * Optimistic share-request approval: flips the cached visibility to
 * `team` and clears `shareRequestedBy` up front, rides the per-note write
 * chain, folds the summary on success, field-scope-reverts on failure
 * (including `share_state` when no request is pending).
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking the note id.
 */
export function useApproveShareRequest(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (noteId: string): Promise<NoteWriteResult> =>
      runOptimisticNoteWrite(
        qc,
        projectId,
        noteId,
        { visibility: "team", shareRequestedBy: null },
        () => approveShareRequestAction(noteId),
        true,
      ),
  });
}

/**
 * Optimistic share-request decline for the ribbon's "Keep private":
 * clears the cached `shareRequestedBy` up front while the note stays
 * private, rides the per-note write chain, reverts on failure.
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking the note id.
 */
export function useDeclineShareRequest(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (noteId: string): Promise<NoteWriteResult> =>
      runOptimisticNoteWrite(
        qc,
        projectId,
        noteId,
        { shareRequestedBy: null },
        () => declineShareRequestAction(noteId),
        true,
      ),
  });
}

/** Body/title content buffered between block commits and the next flush. */
type PendingPatch = NotePendingPatch;

/**
 * Add an id to a pending-id set without mutating the original.
 * @param ids - Current set.
 * @param id - Id to add.
 * @returns Same set when already present, otherwise a new set.
 */
function addPendingId(
  ids: ReadonlySet<string>,
  id: string,
): ReadonlySet<string> {
  if (ids.has(id)) return ids;
  const next = new Set(ids);
  next.add(id);
  return next;
}

/**
 * Remove an id from a pending-id set without mutating the original.
 * @param ids - Current set.
 * @param id - Id to remove.
 * @returns Same set when absent, otherwise a new set.
 */
function removePendingId(
  ids: ReadonlySet<string>,
  id: string,
): ReadonlySet<string> {
  if (!ids.has(id)) return ids;
  const next = new Set(ids);
  next.delete(id);
  return next;
}

/**
 * Live conflict payload surfaced after a `stale_write` autosave failure.
 * `fields` names the conflicted fields (derived from the stashed failed
 * patch) for banner copy.
 */
export type NoteAutosaveConflict = {
  currentUpdatedAt: string;
  currentVersion: number;
  fields: Array<"title" | "body">;
};

/**
 * Terminal autosave failure surfaced after the buffer is dropped. Covers
 * every failure code the flush does not retry (`stale_write` surfaces as
 * `conflict`, `rate_limited` and thrown transport errors re-buffer).
 */
export type NoteAutosaveError = {
  code: Exclude<NoteActionFailure["code"], "stale_write" | "rate_limited">;
  message: string;
};

/**
 * Debounced autosave for the note editor. Each block commit carries the
 * full body, so commits inside one debounce window collapse into one
 * `updateNote` patch. Commits apply to the detail cache immediately and
 * mark the note dirty in the shared registry (blocking realtime detail
 * refetches); flushes run ~600ms after the last commit, on note switch,
 * and on unmount. Buffers are keyed by note id so a commit on one note
 * never displaces another's unsaved content; the flush drains one write
 * at a time under a single-flight guard.
 *
 * Failure semantics: `stale_write` is terminal for the flush. It keeps
 * the optimistic cache content (the server applied no write), stashes the
 * failed patch, and surfaces `conflict` with the live
 * `updatedAt`/`version`; the conflict banner owns recovery via
 * {@link resolveNoteConflictDrop} / {@link resolveNoteConflictReapply},
 * there is no automatic retry. A thrown transport error re-buffers and
 * retries with exponential backoff capped at
 * {@link AUTOSAVE_RETRY_MAX_MS}; `rate_limited` re-buffers with the
 * server's `retryAfter`. Retries stop at unmount, with the unmount flush
 * as the final attempt. Every other typed failure is deterministic: the
 * buffer is dropped and `saveError` surfaces until the note's next
 * successful save, with the committed content still in the detail cache
 * so the next commit re-buffers it. Callers must gate `commit` on
 * `isPlaceholderData` from {@link useNoteDetail}: a placeholder's empty
 * body must never be autosaved. The dirty mark clears only on a confirmed
 * save with an empty buffer outside an open edit session, or on an idle
 * `endEditSession`. Notes marked
 * trashed (a confirmed delete whose restore has not yet succeeded) are
 * excluded on both ends: `commit` drops the edit before touching the
 * buffer or the removed detail entry, and the flush discards a buffered
 * edit instead of sending a doomed write.
 *
 * Edit sessions: `beginEditSession` records an open session (focused
 * title input or open body textarea) and marks the note dirty, so a
 * mid-edit remote event never refetches the detail (a refetch would
 * refresh the CAS token and let the eventual commit silently clobber the
 * remote change). The session is recorded module-level so a save
 * confirmed mid-session releases nothing: the flush clears the dirty
 * mark only outside an open session. `endEditSession` releases the gate
 * only when nothing is buffered, no flush is in flight for the note, and
 * no conflict is live; unmount ends any dangling session the same way.
 *
 * @param projectId - Owning project id.
 * @param noteId - Note being edited.
 * @returns `commit` (buffer a block commit), `flush` (save now), `pending`
 *   (unsaved buffered content exists for this note), `conflict` (live
 *   conflict payload, or `null`), `saveError` (terminal failure for this
 *   note's last dropped save, or `null`), `beginEditSession` /
 *   `endEditSession` (dirty-gate holds for the textarea session), and
 *   `resolveConflictDrop` / `resolveConflictReapply` (banner recovery).
 */
export function useNoteAutosave(projectId: string, noteId: string) {
  const qc = useQueryClient();
  const { mutateAsync } = useUpdateNote(projectId);
  const buffersRef = useRef<Map<string, PendingPatch>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const mountedRef = useRef(true);
  const transportFailuresRef = useRef(0);
  const inFlightNoteRef = useRef<string | null>(null);
  const conflictRef = useRef<NoteConflictState | null>(null);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [conflictState, setConflictState] = useState<NoteConflictState | null>(
    null,
  );
  const [saveErrorState, setSaveErrorState] = useState<
    (NoteAutosaveError & { noteId: string }) | null
  >(null);

  const setConflict = useCallback((next: NoteConflictState | null) => {
    conflictRef.current = next;
    setConflictState(next);
  }, []);

  const flush = useCallback(async () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (inFlightRef.current) return;
    const buffers = buffersRef.current;
    if (buffers.size === 0) return;
    inFlightRef.current = true;
    let retryDelayMs = AUTOSAVE_DEBOUNCE_MS;
    try {
      for (const target of [...buffers.keys()]) {
        const patch = buffers.get(target);
        if (!patch) continue;
        buffers.delete(target);
        setPendingIds((ids) => removePendingId(ids, target));
        if (isNoteTrashed(target)) {
          clearNoteDirty(target);
          continue;
        }
        inFlightNoteRef.current = target;
        try {
          let result: NoteActionResult<NoteSummary> | null = null;
          try {
            result = await mutateAsync({ noteId: target, patch });
          } catch {
            result = null;
          }
          if (result === null || result.ok === false) {
            if (result === null || result.code === "rate_limited") {
              const newer = buffers.get(target);
              buffers.set(target, newer ? { ...patch, ...newer } : patch);
              setPendingIds((ids) => addPendingId(ids, target));
              if (result === null) {
                transportFailuresRef.current += 1;
                retryDelayMs = Math.max(
                  retryDelayMs,
                  Math.min(
                    AUTOSAVE_DEBOUNCE_MS * 2 ** transportFailuresRef.current,
                    AUTOSAVE_RETRY_MAX_MS,
                  ),
                );
              } else {
                retryDelayMs = Math.max(retryDelayMs, result.retryAfter * 1000);
              }
              continue;
            }
            if (result.code === "stale_write") {
              setConflict(
                mergeConflictStash(conflictRef.current, {
                  noteId: target,
                  currentUpdatedAt: result.currentUpdatedAt,
                  currentVersion: result.currentVersion,
                  patch,
                }),
              );
              continue;
            }
            setSaveErrorState({
              noteId: target,
              code: result.code,
              message: result.message,
            });
            continue;
          }
          transportFailuresRef.current = 0;
          if (!buffers.has(target)) clearNoteDirtyUnlessEditing(target);
          if (conflictRef.current?.noteId === target) setConflict(null);
          setSaveErrorState((e) => (e?.noteId === target ? null : e));
        } finally {
          inFlightNoteRef.current = null;
        }
      }
    } finally {
      inFlightRef.current = false;
      if (
        mountedRef.current &&
        buffersRef.current.size > 0 &&
        timerRef.current === null
      ) {
        timerRef.current = setTimeout(
          () => void flushRef.current(),
          retryDelayMs,
        );
      }
    }
  }, [mutateAsync, setConflict]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const commit = useCallback(
    (next: { body?: string; title?: string }) => {
      if (next.body === undefined && next.title === undefined) return;
      if (isNoteTrashed(noteId)) return;
      const base = buffersRef.current.get(noteId) ?? {};
      buffersRef.current.set(noteId, {
        ...base,
        ...(next.body !== undefined ? { body: next.body } : {}),
        ...(next.title !== undefined ? { title: next.title } : {}),
      });
      markNoteDirty(noteId);
      setPendingIds((ids) => addPendingId(ids, noteId));
      qc.setQueryData<NoteFullResult>(
        noteKeys.detail(projectId, noteId),
        (detail) => (detail ? applyPatchToDetail(detail, next) : detail),
      );
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(
        () => void flushRef.current(),
        AUTOSAVE_DEBOUNCE_MS,
      );
    },
    [noteId, projectId, qc],
  );

  const beginEditSession = useCallback(() => {
    if (isNoteTrashed(noteId)) return;
    beginNoteEditSession(noteId);
  }, [noteId]);

  const endEditSession = useCallback(() => {
    endNoteEditSession(noteId);
    if (
      buffersRef.current.has(noteId) ||
      inFlightNoteRef.current === noteId ||
      conflictRef.current?.noteId === noteId
    ) {
      return;
    }
    clearNoteDirty(noteId);
  }, [noteId]);

  useEffect(() => {
    return () => {
      endEditSession();
      void flushRef.current();
    };
  }, [endEditSession]);

  const resolveConflictDrop = useCallback(() => {
    if (conflictRef.current?.noteId !== noteId) return;
    resolveNoteConflictDrop(qc, projectId, noteId, buffersRef.current);
    setPendingIds((ids) => removePendingId(ids, noteId));
    setConflict(null);
  }, [noteId, projectId, qc, setConflict]);

  const resolveConflictReapply = useCallback(() => {
    const conflict = conflictRef.current;
    if (conflict?.noteId !== noteId) return;
    resolveNoteConflictReapply(qc, projectId, conflict, buffersRef.current);
    setPendingIds((ids) => addPendingId(ids, noteId));
    setConflict(null);
    void flushRef.current();
  }, [noteId, projectId, qc, setConflict]);

  return {
    commit,
    flush,
    pending: pendingIds.has(noteId),
    conflict:
      conflictState?.noteId === noteId
        ? {
            currentUpdatedAt: conflictState.currentUpdatedAt,
            currentVersion: conflictState.currentVersion,
            fields: conflictFields(conflictState.patch),
          }
        : null,
    saveError:
      saveErrorState?.noteId === noteId
        ? { code: saveErrorState.code, message: saveErrorState.message }
        : null,
    beginEditSession,
    endEditSession,
    resolveConflictDrop,
    resolveConflictReapply,
  };
}
