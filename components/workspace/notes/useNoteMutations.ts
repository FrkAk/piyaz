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
  casToken,
  clearNoteDirty,
  enqueueNoteWrite,
  markNoteDirty,
  mergeLinksIntoDetail,
  mergeSummaryIntoDetail,
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
 * Read the CAS token for a note from its cached detail entry.
 *
 * @param qc - QueryClient.
 * @param projectId - Owning project id.
 * @param noteId - Note id.
 * @returns Token for `ifUpdatedAt`, or `undefined` when not cached.
 */
function cachedCasToken(
  qc: QueryClient,
  projectId: string,
  noteId: string,
): string | undefined {
  const detail = qc.getQueryData<NoteFullResult>(
    noteKeys.detail(projectId, noteId),
  );
  return detail ? casToken(detail.note.updatedAt) : undefined;
}

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
 * @param qc - QueryClient.
 * @param projectId - Owning project id.
 * @param noteId - Note id.
 * @param detailPatch - Optimistic values for the detail cache.
 * @param send - Server call, executed inside the write chain.
 * @param rollbackOnStale - Revert the optimistic patch on `stale_write`.
 * @returns The typed action result; thrown transport errors revert first.
 */
async function runOptimisticNoteWrite(
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
 * row keeps its position until the next natural refresh), and restores
 * the pre-mutation snapshot on failure, returned or thrown (a rejected
 * action call means the transport failed, so the write's outcome is
 * unknown).
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
      const prevList = qc.getQueryData<NoteTreeRow[]>(listKey);
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
      if (prevList !== undefined) {
        qc.setQueryData(listKey, upsertNoteInTree(prevList, tempRow));
      }
      let result: NoteActionResult<NoteSummary>;
      try {
        result = await createNoteAction({ ...input, projectId });
      } catch (err) {
        if (prevList !== undefined) qc.setQueryData(listKey, prevList);
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
      } else if (prevList !== undefined) {
        qc.setQueryData(listKey, prevList);
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
 * Optimistic note move: patches the cached tree row's folder up front,
 * folds the summary into the detail cache on success, restores on any
 * failure, returned or thrown.
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
    }): Promise<NoteActionResult<NoteSummary>> => {
      const listKey = noteKeys.list(projectId);
      const prevList = qc.getQueryData<NoteTreeRow[]>(listKey);
      qc.setQueryData<NoteTreeRow[]>(listKey, (rows) =>
        patchNoteInTree(rows, vars.noteId, { folder: vars.folder }),
      );
      let result: NoteActionResult<NoteSummary>;
      try {
        result = await moveNoteAction(vars.noteId, vars.folder);
      } catch (err) {
        if (prevList !== undefined) qc.setQueryData(listKey, prevList);
        throw err;
      }
      if (result.ok) {
        qc.setQueryData<NoteFullResult>(
          noteKeys.detail(projectId, vars.noteId),
          (detail) => mergeSummaryIntoDetail(detail, result.data),
        );
        qc.invalidateQueries({ queryKey: listKey });
      } else if (prevList !== undefined) {
        qc.setQueryData(listKey, prevList);
      }
      return result;
    },
  });
}

/**
 * Optimistic note delete: drops the cached tree row up front; on success
 * revalidates the list and removes the detail entry, on any failure,
 * returned or thrown, restores both snapshots.
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking the note id.
 */
export function useDeleteNote(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      noteId: string,
    ): Promise<NoteActionResult<{ id: string; deletedAt: Date }>> => {
      const listKey = noteKeys.list(projectId);
      const detailKey = noteKeys.detail(projectId, noteId);
      const prevList = qc.getQueryData<NoteTreeRow[]>(listKey);
      const prevDetail = qc.getQueryData<NoteFullResult>(detailKey);
      qc.setQueryData<NoteTreeRow[]>(listKey, (rows) =>
        removeNoteFromTree(rows, noteId),
      );
      let result: NoteActionResult<{ id: string; deletedAt: Date }>;
      try {
        result = await deleteNoteAction(noteId);
      } catch (err) {
        if (prevList !== undefined) qc.setQueryData(listKey, prevList);
        if (prevDetail !== undefined) qc.setQueryData(detailKey, prevDetail);
        throw err;
      }
      if (result.ok) {
        clearNoteDirty(noteId);
        qc.invalidateQueries({ queryKey: listKey });
        qc.removeQueries({ queryKey: detailKey });
      } else {
        if (prevList !== undefined) qc.setQueryData(listKey, prevList);
        if (prevDetail !== undefined) qc.setQueryData(detailKey, prevDetail);
      }
      return result;
    },
  });
}

/**
 * Restore a soft-deleted note (delete undo). No optimistic surgery: the
 * restored row revalidates into the tree list on success, and the detail
 * cache was dropped at delete time so nothing local needs folding.
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking the note id.
 */
export function useRestoreNote(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      noteId: string,
    ): Promise<NoteActionResult<NoteSummary>> => {
      const result = await restoreNoteAction(noteId);
      if (result.ok) {
        qc.invalidateQueries({ queryKey: noteKeys.list(projectId) });
      }
      return result;
    },
  });
}

/**
 * Folder subtree re-parent (tree drag-and-drop and rename). No optimistic
 * surgery: the move touches an unbounded set of rows, so on success the
 * whole note prefix revalidates (tree, details, search, backlinks all
 * render folder paths; unchanged entries cost a bodiless 304).
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking `{ src, destParent, leaf? }`.
 */
export function useMoveFolder(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      src: string;
      destParent: string;
      leaf?: string;
    }): Promise<NoteActionResult<{ dest: string; movedCount: number }>> => {
      const result = await moveFolderAction(
        projectId,
        vars.src,
        vars.destParent,
        vars.leaf,
      );
      if (result.ok) {
        qc.invalidateQueries({ queryKey: noteKeys.all(projectId) });
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
type PendingPatch = { body?: string; title?: string };

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

/** Live conflict payload surfaced after a `stale_write` autosave failure. */
export type NoteAutosaveConflict = {
  currentUpdatedAt: string;
  currentVersion: number;
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
 * Failure semantics: `stale_write` keeps the optimistic cache content
 * (the server applied no write) and surfaces `conflict` with the live
 * `updatedAt`/`version`. A thrown transport error re-buffers and retries
 * with exponential backoff capped at {@link AUTOSAVE_RETRY_MAX_MS};
 * `rate_limited` re-buffers with the server's `retryAfter`. Retries stop
 * at unmount, with the unmount flush as the final attempt. Every other
 * typed failure is deterministic: the buffer is dropped and `saveError`
 * surfaces until the note's next successful save, with the committed
 * content still in the detail cache so the next commit re-buffers it.
 * Callers must gate `commit` on `isPlaceholderData` from
 * {@link useNoteDetail}: a placeholder's empty body must never be
 * autosaved. The dirty mark clears only on a confirmed save with an
 * empty buffer.
 *
 * @param projectId - Owning project id.
 * @param noteId - Note being edited.
 * @returns `commit` (buffer a block commit), `flush` (save now), `pending`
 *   (unsaved buffered content exists for this note), `conflict` (live
 *   conflict payload, or `null`), `saveError` (terminal failure for this
 *   note's last dropped save, or `null`).
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
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [conflictState, setConflictState] = useState<
    (NoteAutosaveConflict & { noteId: string }) | null
  >(null);
  const [saveErrorState, setSaveErrorState] = useState<
    (NoteAutosaveError & { noteId: string }) | null
  >(null);

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
            setConflictState({
              noteId: target,
              currentUpdatedAt: result.currentUpdatedAt,
              currentVersion: result.currentVersion,
            });
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
        if (!buffers.has(target)) clearNoteDirty(target);
        setConflictState((c) => (c?.noteId === target ? null : c));
        setSaveErrorState((e) => (e?.noteId === target ? null : e));
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
  }, [mutateAsync]);

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

  useEffect(() => {
    return () => {
      void flushRef.current();
    };
  }, [noteId]);

  return {
    commit,
    flush,
    pending: pendingIds.has(noteId),
    conflict:
      conflictState?.noteId === noteId
        ? {
            currentUpdatedAt: conflictState.currentUpdatedAt,
            currentVersion: conflictState.currentVersion,
          }
        : null,
    saveError:
      saveErrorState?.noteId === noteId
        ? { code: saveErrorState.code, message: saveErrorState.message }
        : null,
  };
}
