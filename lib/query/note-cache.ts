import type { NoteFullResult, NoteSummary, NoteTreeRow } from "@/lib/data/note";

/** Tree-visible fields a patch may change; `id` is immutable. */
export type NoteTreePatch = Partial<Omit<NoteTreeRow, "id">>;

/**
 * Fabricate a placeholder {@link NoteFullResult} from a cached tree-list row
 * so the detail pane renders instantly on select. The tree row carries no
 * `body`, so the placeholder body is empty and every fabricated field below
 * must stay gated on `isPlaceholderData` until the real detail fetch
 * resolves — in particular the empty `body` must never be committed or
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
  const next = [...rows];
  next[idx] = { ...existing, ...patch };
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
