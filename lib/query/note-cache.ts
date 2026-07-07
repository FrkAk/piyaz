import type {
  NoteFull,
  NoteFullResult,
  NoteLinksRefresh,
  NoteSummary,
  NoteTreeRow,
} from "@/lib/data/note";

/** Tree-visible fields a patch may change; `id` is immutable. */
export type NoteTreePatch = Partial<Omit<NoteTreeRow, "id">>;

/**
 * Serialize a cached `updatedAt` into the CAS token `updateNote` expects.
 * Route payloads carry ISO strings at runtime (JSON serialization) while
 * merged mutation results carry `Date` objects; both must round-trip
 * byte-exact against the value the server last emitted.
 *
 * @param updatedAt - Cached `updatedAt` value.
 * @returns ISO string token for `ifUpdatedAt`.
 */
export function casToken(updatedAt: Date | string): string {
  return typeof updatedAt === "string" ? updatedAt : updatedAt.toISOString();
}

/**
 * Note ids with unsaved editor content: buffered commits, an in-flight
 * autosave, kept-optimistic conflict content, or a terminal save error
 * whose content still lives only in the cache. The realtime bridge checks
 * this before refetching a note's detail so a remote event never clobbers
 * local edits. Module-level (not React state) so the bridge can read it
 * without importing from the notes component tree.
 */
const dirtyNoteIds = new Set<string>();

/**
 * Mark a note as holding unsaved editor content.
 * @param noteId - Note id.
 */
export function markNoteDirty(noteId: string): void {
  dirtyNoteIds.add(noteId);
}

/**
 * Clear a note's unsaved-content mark after a confirmed save.
 * @param noteId - Note id.
 */
export function clearNoteDirty(noteId: string): void {
  dirtyNoteIds.delete(noteId);
}

/**
 * Whether a note holds unsaved editor content.
 * @param noteId - Note id.
 * @returns True when a detail refetch could clobber local edits.
 */
export function hasUnsavedNoteEdits(noteId: string): boolean {
  return dirtyNoteIds.has(noteId);
}

/** Per-note FIFO chains; see {@link enqueueNoteWrite}. */
const noteWriteChains = new Map<string, Promise<unknown>>();

/**
 * Serialize server calls per note so each write reads a fresh CAS token
 * at send time, after the previous response merged into the cache.
 * Optimistic cache patches still apply immediately at enqueue time; only
 * the server round-trips are chained. Rejections propagate to their own
 * caller and never break the chain; the chain entry is dropped once its
 * tail settles.
 *
 * @param noteId - Note id keying the chain.
 * @param job - Server call to run when the chain reaches it.
 * @returns The job's result.
 */
export function enqueueNoteWrite<T>(
  noteId: string,
  job: () => Promise<T>,
): Promise<T> {
  const prev = noteWriteChains.get(noteId) ?? Promise.resolve();
  const run = prev.then(job, job);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  noteWriteChains.set(noteId, tail);
  void tail.then(() => {
    if (noteWriteChains.get(noteId) === tail) noteWriteChains.delete(noteId);
  });
  return run;
}

/**
 * Resolve once the note's currently chained writes have settled (their
 * responses merged into the cache). Resolves immediately when no write is
 * in flight. The realtime bridge awaits this before judging an event
 * against the cache, so the actor's own SSE event, which can outrun the
 * mutation response, never triggers a redundant refetch.
 *
 * @param noteId - Note id keying the chain.
 * @returns Promise settling after the current chain tail.
 */
export function whenNoteWritesSettle(noteId: string): Promise<void> {
  return (noteWriteChains.get(noteId) ?? Promise.resolve()).then(
    () => undefined,
  );
}

/**
 * Fabricate a placeholder {@link NoteFullResult} from a cached tree-list row
 * so the detail pane renders instantly on select. The tree row carries no
 * `body`, so the placeholder body is empty and every fabricated field below
 * must stay gated on `isPlaceholderData` until the real detail fetch
 * resolves; in particular the empty `body` must never be committed or
 * autosaved.
 *
 * @param projectId - Owning project id.
 * @param row - Cached slim tree row for the note.
 * @returns Placeholder detail result with empty body and link context.
 */
export function notePlaceholderFromRow(
  projectId: string,
  row: NoteTreeRow,
): NoteFullResult {
  return {
    note: {
      id: row.id,
      projectId,
      sequenceNumber: 0,
      type: row.type,
      folder: row.folder,
      title: row.title,
      slug: row.slug,
      summary: row.summary,
      body: "",
      visibility: row.visibility,
      agentWritable: row.agentWritable,
      locked: row.locked,
      feedMode: "none",
      feedCategories: [],
      feedTags: [],
      feedTaskIds: [],
      tags: [],
      category: null,
      version: 1,
      embeddingStatus: "none",
      shareRequestedBy: null,
      createdBy: null,
      updatedBy: null,
      createdAt: row.updatedAt,
      updatedAt: row.updatedAt,
      deletedAt: null,
    },
    mentions: [],
    linksOut: [],
    linksIn: [],
  };
}

/**
 * Shallow field equality between two tree rows.
 * @param a - First row.
 * @param b - Second row.
 * @returns True when every field is `===`-equal.
 */
function treeRowsEqual(a: NoteTreeRow, b: NoteTreeRow): boolean {
  return (Object.keys(a) as (keyof NoteTreeRow)[]).every(
    (key) => a[key] === b[key],
  );
}

/**
 * Insert or replace a row in the cached tree list.
 *
 * @param rows - Cached tree rows, or `undefined` when the list isn't cached.
 * @param row - Row to upsert.
 * @returns New array with the row applied; the same reference when the row
 *   is already present and field-equal (no needless re-render).
 */
export function upsertNoteInTree(
  rows: NoteTreeRow[] | undefined,
  row: NoteTreeRow,
): NoteTreeRow[] {
  if (!rows) return [row];
  const idx = rows.findIndex((r) => r.id === row.id);
  if (idx === -1) return [...rows, row];
  const existing = rows[idx];
  if (existing && treeRowsEqual(existing, row)) return rows;
  const next = [...rows];
  next[idx] = row;
  return next;
}

/**
 * Apply a partial patch to one row in the cached tree list.
 *
 * @param rows - Cached tree rows, or `undefined` when the list isn't cached.
 * @param noteId - Id of the row to patch.
 * @param patch - Fields to overwrite; `undefined` values are skipped.
 * @returns New array with the patch applied; the same reference when the
 *   row is absent or every patched value is already equal.
 */
export function patchNoteInTree(
  rows: NoteTreeRow[] | undefined,
  noteId: string,
  patch: NoteTreePatch,
): NoteTreeRow[] | undefined {
  if (!rows) return rows;
  const idx = rows.findIndex((r) => r.id === noteId);
  const existing = rows[idx];
  if (!existing) return rows;
  const entries = (Object.keys(patch) as (keyof NoteTreePatch)[]).filter(
    (key) => patch[key] !== undefined,
  );
  if (entries.every((key) => existing[key] === patch[key])) return rows;
  const patched = { ...existing } as Record<string, unknown>;
  for (const key of entries) patched[key] = patch[key];
  const next = [...rows];
  next[idx] = patched as NoteTreeRow;
  return next;
}

/**
 * Drop a row from the cached tree list.
 *
 * @param rows - Cached tree rows, or `undefined` when the list isn't cached.
 * @param noteId - Id of the row to remove.
 * @returns New array without the row; the same reference when absent.
 */
export function removeNoteFromTree(
  rows: NoteTreeRow[] | undefined,
  noteId: string,
): NoteTreeRow[] | undefined {
  if (!rows) return rows;
  if (!rows.some((r) => r.id === noteId)) return rows;
  return rows.filter((r) => r.id !== noteId);
}

/**
 * Fold a mutation's {@link NoteSummary} result into a cached detail entry so
 * the next optimistic-concurrency token is the fresh `updatedAt`. Skipping
 * this makes the second consecutive autosave always stale.
 *
 * @param detail - Cached detail result, or `undefined` when not cached.
 * @param summary - Slim write result returned by the mutation.
 * @returns New detail with the summary folded in; the same reference when
 *   `undefined` or when every summary field is already equal.
 */
export function mergeSummaryIntoDetail(
  detail: NoteFullResult | undefined,
  summary: NoteSummary,
): NoteFullResult | undefined {
  if (!detail || detail.note.id !== summary.id) return detail;
  const { note } = detail;
  if (
    note.slug === summary.slug &&
    note.title === summary.title &&
    note.folder === summary.folder &&
    note.version === summary.version &&
    note.updatedAt === summary.updatedAt
  ) {
    return detail;
  }
  return {
    ...detail,
    note: {
      ...note,
      slug: summary.slug,
      title: summary.title,
      folder: summary.folder,
      version: summary.version,
      updatedAt: summary.updatedAt,
    },
  };
}

/**
 * Index-wise field equality between two mention lists.
 * @param a - First list.
 * @param b - Second list.
 * @returns True when both lists are field-equal in order.
 */
function mentionsEqual(
  a: NoteFullResult["mentions"],
  b: NoteFullResult["mentions"],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => {
    const o = b[i];
    return (
      o !== undefined &&
      m.taskId === o.taskId &&
      m.kind === o.kind &&
      m.taskRef === o.taskRef &&
      m.status === o.status &&
      m.title === o.title
    );
  });
}

/**
 * Index-wise id/updatedAt equality between two linked-note lists.
 * @param a - First list.
 * @param b - Second list.
 * @returns True when both lists match in order.
 */
function linkedNotesEqual(
  a: NoteFullResult["linksOut"],
  b: NoteFullResult["linksOut"],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((l, i) => {
    const o = b[i];
    return (
      o !== undefined &&
      l.id === o.id &&
      l.title === o.title &&
      String(l.updatedAt) === String(o.updatedAt)
    );
  });
}

/**
 * Fold the re-derived link context of a body-changing write into a cached
 * detail entry so the Mentions and Linked-notes surfaces refresh without a
 * detail refetch. `linksIn` is never touched: incoming rows belong to
 * other notes' derivations.
 *
 * @param detail - Cached detail result, or `undefined` when not cached.
 * @param links - Link context from the write response; `undefined` for
 *   metadata-only patches.
 * @returns New detail with the links folded in; the same reference when
 *   there is nothing to fold or the lists already match.
 */
export function mergeLinksIntoDetail(
  detail: NoteFullResult | undefined,
  links: NoteLinksRefresh | undefined,
): NoteFullResult | undefined {
  if (!detail || !links) return detail;
  if (
    mentionsEqual(detail.mentions, links.mentions) &&
    linkedNotesEqual(detail.linksOut, links.linksOut)
  ) {
    return detail;
  }
  return { ...detail, mentions: links.mentions, linksOut: links.linksOut };
}

/**
 * Field-scoped optimistic rollback for a cached detail entry: restore the
 * previous value ONLY for patch fields whose cached value still equals
 * this mutation's optimistic value, so an earlier failure never clobbers
 * a newer optimistic write to the same field. Arrays compare by
 * reference; each optimistic patch installs a fresh array.
 *
 * @param detail - Cached detail result, or `undefined` when not cached.
 * @param patch - The optimistic values this mutation wrote.
 * @param prev - The pre-patch values for the same fields.
 * @returns New detail with untouched fields restored; the same reference
 *   when nothing qualifies.
 */
export function revertPatchOnDetail(
  detail: NoteFullResult | undefined,
  patch: Partial<NoteFull>,
  prev: Partial<NoteFull>,
): NoteFullResult | undefined {
  if (!detail) return detail;
  const restored: Record<string, unknown> = {};
  let changed = false;
  for (const key of Object.keys(patch) as (keyof NoteFull)[]) {
    const optimistic = patch[key];
    if (optimistic === undefined) continue;
    if (detail.note[key] === optimistic && prev[key] !== optimistic) {
      restored[key] = prev[key];
      changed = true;
    }
  }
  if (!changed) return detail;
  return { ...detail, note: { ...detail.note, ...restored } };
}

/**
 * Field-scoped optimistic rollback for one cached tree row; same contract
 * as {@link revertPatchOnDetail}.
 *
 * @param rows - Cached tree rows, or `undefined` when the list isn't cached.
 * @param noteId - Id of the row to revert.
 * @param patch - The optimistic values this mutation wrote.
 * @param prev - The pre-patch values for the same fields.
 * @returns New array with untouched fields restored; the same reference
 *   when the row is absent or nothing qualifies.
 */
export function revertPatchInTree(
  rows: NoteTreeRow[] | undefined,
  noteId: string,
  patch: NoteTreePatch,
  prev: NoteTreePatch,
): NoteTreeRow[] | undefined {
  if (!rows) return rows;
  const idx = rows.findIndex((r) => r.id === noteId);
  const existing = rows[idx];
  if (!existing) return rows;
  const restored: Record<string, unknown> = {};
  let changed = false;
  for (const key of Object.keys(patch) as (keyof NoteTreePatch)[]) {
    const optimistic = patch[key];
    if (optimistic === undefined) continue;
    if (existing[key] === optimistic && prev[key] !== optimistic) {
      restored[key] = prev[key];
      changed = true;
    }
  }
  if (!changed) return rows;
  const next = [...rows];
  next[idx] = { ...existing, ...restored } as NoteTreeRow;
  return next;
}
