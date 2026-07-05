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
  createNoteAction,
  deleteNoteAction,
  moveFolderAction,
  moveNoteAction,
  setNoteAccessAction,
  setNoteVisibilityAction,
  updateNoteAction,
} from "@/lib/actions/note";
import type {
  CreateNoteInput,
  NoteFull,
  NoteFullResult,
  NotePatch,
  NoteSummary,
  NoteTreeRow,
} from "@/lib/data/note";
import { noteKeys } from "@/lib/query/keys";
import {
  mergeSummaryIntoDetail,
  patchNoteInTree,
  removeNoteFromTree,
  upsertNoteInTree,
  type NoteTreePatch,
} from "@/lib/query/note-cache";
import type { Visibility } from "@/lib/types";

/** Debounce window between a block commit and the autosave flush. */
const AUTOSAVE_DEBOUNCE_MS = 600;

/**
 * Serialize a cached `updatedAt` into the CAS token `updateNote` expects.
 * Route payloads carry ISO strings at runtime (JSON serialization) while
 * merged mutation results carry `Date` objects; both must round-trip
 * byte-exact against the value the server last emitted.
 *
 * @param updatedAt - Cached `updatedAt` value.
 * @returns ISO string token for `ifUpdatedAt`.
 */
function casToken(updatedAt: Date | string): string {
  return typeof updatedAt === "string" ? updatedAt : updatedAt.toISOString();
}

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
  patch: NotePatch,
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
function treePatchFrom(patch: NotePatch): NoteTreePatch {
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
 * Optimistic note creation: inserts a temp row into the cached tree list,
 * swaps it for the authoritative summary on success (then revalidates the
 * list, reconciling server-side slug dedupe), and restores the pre-mutation
 * snapshot on failure, returned or thrown (a rejected action call means the
 * transport failed, so the write's outcome is unknown).
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
        title: input.title,
        type: input.type ?? "reference",
        folder: input.folder ?? "",
        summary: input.summary ?? "",
        visibility: input.visibility ?? "private",
        agentWritable: false,
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
        qc.invalidateQueries({ queryKey: listKey });
      } else if (prevList !== undefined) {
        qc.setQueryData(listKey, prevList);
      }
      return result;
    },
  });
}

/**
 * Optimistic note patch with optimistic concurrency. Threads the cached
 * `updatedAt` as the CAS token, applies the patch to the detail and tree
 * caches up front, and on success folds the summary back in so the NEXT
 * save's token is fresh. On `stale_write` the optimistic content is kept
 * (the server applied no write, so nothing was clobbered) and the failure
 * carries the live `updatedAt`/`version` for the conflict banner; every
 * other failure, returned or thrown, restores both snapshots.
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking `{ noteId, patch }`.
 */
export function useUpdateNote(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      noteId: string;
      patch: NotePatch;
    }): Promise<NoteActionResult<NoteSummary>> => {
      const { noteId, patch } = vars;
      const detailKey = noteKeys.detail(projectId, noteId);
      const listKey = noteKeys.list(projectId);
      const prevDetail = qc.getQueryData<NoteFullResult>(detailKey);
      const prevList = qc.getQueryData<NoteTreeRow[]>(listKey);
      const token = prevDetail
        ? casToken(prevDetail.note.updatedAt)
        : undefined;

      if (prevDetail !== undefined) {
        qc.setQueryData(detailKey, applyPatchToDetail(prevDetail, patch));
      }
      qc.setQueryData<NoteTreeRow[]>(listKey, (rows) =>
        patchNoteInTree(rows, noteId, treePatchFrom(patch)),
      );

      let result: NoteActionResult<NoteSummary>;
      try {
        result = await updateNoteAction(noteId, patch, token);
      } catch (err) {
        if (prevDetail !== undefined) qc.setQueryData(detailKey, prevDetail);
        if (prevList !== undefined) qc.setQueryData(listKey, prevList);
        throw err;
      }
      if (result.ok) {
        qc.setQueryData<NoteFullResult>(detailKey, (detail) =>
          mergeSummaryIntoDetail(detail, result.data),
        );
        qc.invalidateQueries({ queryKey: listKey });
        return result;
      }
      if (result.code === "stale_write") return result;
      if (prevDetail !== undefined) qc.setQueryData(detailKey, prevDetail);
      if (prevList !== undefined) qc.setQueryData(listKey, prevList);
      return result;
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
 * Folder subtree re-parent (tree drag-and-drop). No optimistic surgery:
 * the move touches an unbounded set of rows, so on success the whole note
 * prefix revalidates (tree, details, search, backlinks all render folder
 * paths; unchanged entries cost a bodiless 304).
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking `{ src, destParent }`.
 */
export function useMoveFolder(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      src: string;
      destParent: string;
    }): Promise<NoteActionResult<{ dest: string; movedCount: number }>> => {
      const result = await moveFolderAction(
        projectId,
        vars.src,
        vars.destParent,
      );
      if (result.ok) {
        qc.invalidateQueries({ queryKey: noteKeys.all(projectId) });
      }
      return result;
    },
  });
}

/**
 * One-shot agent-access setter (`{agentWritable, locked}` patch). No
 * optimistic surgery; folds the summary into the detail cache on success
 * so the next CAS token is fresh, then revalidates list and detail.
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking `{ noteId, access }`.
 */
export function useSetNoteAccess(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      noteId: string;
      access: { agentWritable: boolean; locked: boolean };
    }): Promise<NoteActionResult<NoteSummary>> => {
      const result = await setNoteAccessAction(
        vars.noteId,
        vars.access,
        cachedCasToken(qc, projectId, vars.noteId),
      );
      if (result.ok) {
        finalizeSettingsWrite(qc, projectId, vars.noteId, result.data);
      }
      return result;
    },
  });
}

/**
 * One-shot visibility setter. Flipping to `team` clears the pending share
 * request server-side; setting `private` is creator-only and surfaces as
 * `not_found` for non-creators. No optimistic surgery.
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking `{ noteId, visibility }`.
 */
export function useSetNoteVisibility(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      noteId: string;
      visibility: Visibility;
    }): Promise<NoteActionResult<NoteSummary>> => {
      const result = await setNoteVisibilityAction(
        vars.noteId,
        vars.visibility,
        cachedCasToken(qc, projectId, vars.noteId),
      );
      if (result.ok) {
        finalizeSettingsWrite(qc, projectId, vars.noteId, result.data);
      }
      return result;
    },
  });
}

/**
 * One-shot share-request approval (flips visibility to `team`, clears
 * `shareRequestedBy`). No optimistic surgery.
 *
 * @param projectId - Owning project id.
 * @returns Mutation taking the note id.
 */
export function useApproveShareRequest(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      noteId: string,
    ): Promise<NoteActionResult<NoteSummary>> => {
      const result = await approveShareRequestAction(noteId);
      if (result.ok) {
        finalizeSettingsWrite(qc, projectId, noteId, result.data);
      }
      return result;
    },
  });
}

/**
 * Shared success path for one-shot settings mutations: fold the summary
 * into the detail cache (fresh CAS token immediately, before the refetch
 * lands), then revalidate the list and the touched detail.
 *
 * @param qc - QueryClient.
 * @param projectId - Owning project id.
 * @param noteId - Touched note id.
 * @param summary - Slim write result.
 */
function finalizeSettingsWrite(
  qc: QueryClient,
  projectId: string,
  noteId: string,
  summary: NoteSummary,
): void {
  qc.setQueryData<NoteFullResult>(noteKeys.detail(projectId, noteId), (d) =>
    mergeSummaryIntoDetail(d, summary),
  );
  qc.invalidateQueries({ queryKey: noteKeys.list(projectId) });
  qc.invalidateQueries({ queryKey: noteKeys.detail(projectId, noteId) });
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
 * FULL body (per the editor contract), so N commits inside one debounce
 * window collapse into ONE `updateNote` patch holding the latest body and
 * latest title. Commits apply to the detail cache immediately (blocks
 * re-render from cache) and flush ~600ms after the last commit, on note
 * switch, and on unmount.
 *
 * Buffers are keyed by note id, so a commit on one note never displaces
 * another note's unsaved content: switching notes mid-flight leaves the
 * previous note's buffer in place until a flush drains it. `flush` drains
 * every buffered note one write at a time under a single-flight guard;
 * entries buffered or re-buffered while a drain runs wait for the next
 * flush, which the drain re-arms itself.
 *
 * Failure semantics: on `stale_write` the optimistic cache content is kept
 * (the server applied no write; rollback would fake data loss) and
 * `conflict` carries the live `updatedAt`/`version` until the next
 * successful save. A thrown transport error (write outcome unknown) and
 * `rate_limited` re-buffer the patch for retry, the latter re-arming the
 * timer with the server's `retryAfter`. Every other typed failure is
 * deterministic — retrying it loops write traffic without recovery — so
 * the buffer is dropped and the failure surfaces as `saveError` until the
 * note's next successful save; the committed content stays in the detail
 * cache (the commit-time optimistic patch is the flush-time snapshot), so
 * the next commit re-buffers it. Callers must gate `commit` on
 * `isPlaceholderData` from {@link useNoteDetail} — a placeholder's empty
 * body must never be autosaved. An SSE invalidation may refetch over
 * kept-optimistic conflict content; resolving that is the conflict
 * banner's contract (PYZ-262).
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
            if (result !== null) {
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
        setConflictState((c) => (c?.noteId === target ? null : c));
        setSaveErrorState((e) => (e?.noteId === target ? null : e));
      }
    } finally {
      inFlightRef.current = false;
      if (buffersRef.current.size > 0 && timerRef.current === null) {
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

  const commit = useCallback(
    (next: { body?: string; title?: string }) => {
      if (next.body === undefined && next.title === undefined) return;
      const base = buffersRef.current.get(noteId) ?? {};
      buffersRef.current.set(noteId, {
        ...base,
        ...(next.body !== undefined ? { body: next.body } : {}),
        ...(next.title !== undefined ? { title: next.title } : {}),
      });
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
