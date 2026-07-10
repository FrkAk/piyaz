import type { NoteType } from "@/lib/types";

/**
 * Display order for note types — SettingsPane's Type group and every
 * future type-ordered surface read from this single list so they cannot
 * drift.
 */
export const NOTE_TYPE_ORDER: readonly NoteType[] = [
  "reference",
  "guidance",
  "knowledge",
];

/**
 * Sort rank for the notes-tree `type` comparator. `reference` is zero so
 * it sorts first, matching {@link NOTE_TYPE_ORDER}.
 */
export const NOTE_TYPE_RANK: Record<NoteType, number> = {
  reference: 0,
  guidance: 1,
  knowledge: 2,
};

/** Notes-tree sort key. `title` matches the server's default list order. */
export type NoteSortKey = "title" | "updated" | "type";

/** Notes-tree group key. `folder` is the default collapsible tree. */
export type NoteGroupKey = "folder" | "category";

/** Sort dropdown options for the notes tree. */
export const NOTE_SORT_OPTIONS: ReadonlyArray<{
  value: NoteSortKey;
  label: string;
}> = [
  { value: "title", label: "Title" },
  { value: "updated", label: "Updated" },
  { value: "type", label: "Type" },
];

/** Group dropdown options for the notes tree. */
export const NOTE_GROUP_OPTIONS: ReadonlyArray<{
  value: NoteGroupKey;
  label: string;
}> = [
  { value: "folder", label: "Folder" },
  { value: "category", label: "Category" },
];

/**
 * Read the notes-tree sort key from the `nsort` URL param.
 *
 * @param raw - Raw query param value.
 * @returns The matching key, or `title` for any unknown token.
 */
export function readNoteSort(raw: string | null): NoteSortKey {
  if (raw === "updated" || raw === "type") return raw;
  return "title";
}

/**
 * Read the notes-tree group key from the `ngroup` URL param.
 *
 * @param raw - Raw query param value.
 * @returns The matching key, or `folder` for any unknown token.
 */
export function readNoteGroup(raw: string | null): NoteGroupKey {
  if (raw === "category") return raw;
  return "folder";
}
