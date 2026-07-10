import type { NoteTreeRow } from "@/lib/data/note";
import type { NoteType } from "@/lib/types";

/** Display metadata and context behavior for one note type. */
export interface NoteTypeMeta {
  label: string;
  color: string;
  behavior: "Pull-on-demand" | "Auto-inject" | "Search";
  blurb: string;
  rule: string;
  depth: string;
}

/** Type-driven context behavior + the real token each note type borrows. */
export const NOTE_TYPE_META: Record<NoteType, NoteTypeMeta> = {
  reference: {
    label: "Reference",
    color: "var(--color-planned)",
    behavior: "Pull-on-demand",
    blurb: "Specs, docs, research.",
    rule: "Pulled on demand. Heading-addressable; never auto-injected.",
    depth: "agent · planning",
  },
  guidance: {
    label: "Guidance",
    color: "var(--color-progress)",
    behavior: "Auto-inject",
    blurb: "Agent rules & project guidelines.",
    rule: "Auto-injected as a short constraints block for in-scope tasks.",
    depth: "agent · planning",
  },
  knowledge: {
    label: "Knowledge",
    color: "var(--color-relates)",
    behavior: "Search",
    blurb: "Agent-maintained wiki & memory.",
    rule: "Interlinked base. Surfaced to agents via semantic search.",
    depth: "agent (semantic)",
  },
};

/** Tree type-filter value: one note type or all. */
export type TypeFilter = "all" | NoteType;

/**
 * Tint a token color at a given percentage over transparent.
 *
 * @param color - CSS color or custom-property reference.
 * @param pct - Opacity percentage of the color in the mix.
 * @returns `color-mix` expression.
 */
export function tint(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

/**
 * Parent folder path of a path.
 *
 * @param path - Folder path.
 * @returns Parent path, or `""` for a root folder.
 */
export function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/**
 * Last path segment, the folder's display name.
 *
 * @param path - Folder path.
 * @returns Final segment of the path.
 */
export function leafOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Normalize user-entered folder text with the server's segment rules:
 * split on `/`, trim segments, drop empties. Shared by the inline
 * rename and the naming-first folder create so both compute the exact
 * path the server will persist.
 *
 * @param raw - User-entered folder name or path.
 * @returns Canonical path (`""` when nothing survives normalization).
 */
export function normalizeFolderInput(raw: string): string {
  return raw
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
    .join("/");
}

/**
 * Resolve the folder a new note lands in: an explicitly selected folder
 * wins, else the selected note's folder, else the `Drafts` inbox (also
 * the fallback for a selected root note, preserving the pre-selection
 * behavior byte for byte).
 *
 * @param selectedFolder - Folder selected in the tree, or null.
 * @param selectedNoteFolder - Selected note's folder, or undefined when
 *   no note is selected.
 * @returns Destination folder path for the create.
 */
export function resolveCreateTarget(
  selectedFolder: string | null,
  selectedNoteFolder: string | undefined,
): string {
  if (selectedFolder !== null) return selectedFolder;
  return selectedNoteFolder ? selectedNoteFolder : "Drafts";
}

/**
 * Outcome of a folder mutation (inline rename or drag re-parent):
 * nothing to do, a sibling collision that would silently merge two
 * folders, or the dispatchable move.
 */
export type FolderMovePlan =
  | { kind: "noop" }
  | { kind: "collision"; dest: string }
  | { kind: "move"; destParent: string; leaf: string; dest: string };

/**
 * Plan an inline folder rename. Normalizes the entered name with the
 * server's folder segment rules (split on `/`, trim, drop empties) so
 * the computed destination matches what `moveFolder` will return.
 *
 * @param path - Folder path being renamed.
 * @param rawName - User-entered replacement name.
 * @param allFolders - Every visible folder path, server and client-local.
 * @returns No-op for an empty or unchanged name, collision when the
 *   destination folder already exists, otherwise the move parameters.
 */
export function planFolderRename(
  path: string,
  rawName: string,
  allFolders: readonly string[],
): FolderMovePlan {
  const leaf = normalizeFolderInput(rawName);
  if (leaf === "" || leaf === leafOf(path)) return { kind: "noop" };
  const destParent = parentOf(path);
  const dest = destParent === "" ? leaf : `${destParent}/${leaf}`;
  if (allFolders.includes(dest)) return { kind: "collision", dest };
  return { kind: "move", destParent, leaf, dest };
}

/**
 * Plan a folder drag re-parent. Self, descendant, and same-parent drops
 * are no-ops; a destination that already holds a same-named sibling is
 * a collision (dispatching it would silently merge the two folders).
 *
 * @param src - Folder path being moved.
 * @param destParent - Target parent path (`""` = root).
 * @param allFolders - Every visible folder path, server and client-local.
 * @returns No-op, collision, or the move parameters.
 */
export function planFolderMove(
  src: string,
  destParent: string,
  allFolders: readonly string[],
): FolderMovePlan {
  if (destParent === src || destParent.startsWith(`${src}/`)) {
    return { kind: "noop" };
  }
  if (parentOf(src) === destParent) return { kind: "noop" };
  const leaf = leafOf(src);
  const dest = destParent === "" ? leaf : `${destParent}/${leaf}`;
  if (allFolders.includes(dest)) return { kind: "collision", dest };
  return { kind: "move", destParent, leaf, dest };
}

/** Base row indent in px; each nesting level adds {@link INDENT_STEP}. */
const INDENT_BASE = 8;

/** Indent added per folder nesting level, in px. */
const INDENT_STEP = 12;

/**
 * One row of the flattened visible tree: a folder header or a note. The
 * flat sequence preserves the recursive render order so the virtualized
 * list matches the previous DOM exactly.
 */
export type FlatTreeRow =
  | {
      kind: "folder";
      key: string;
      path: string;
      depth: number;
      indent: number;
      noteCount: number;
    }
  | { kind: "note"; key: string; note: NoteTreeRow; indent: number };

/**
 * Group folder paths by their parent path, preserving input order.
 *
 * @param allFolders - Every visible folder path, sorted.
 * @returns Map from parent path (`""` = root) to its child folder paths.
 */
export function groupFoldersByParent(
  allFolders: readonly string[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const f of allFolders) {
    const parent = parentOf(f);
    const bucket = map.get(parent);
    if (bucket) bucket.push(f);
    else map.set(parent, [f]);
  }
  return map;
}

/**
 * Flatten the visible folder tree into one row sequence: for each folder
 * its header row, then (when expanded) its child folders and its direct
 * notes; root notes follow all root folders. A collapsed folder emits
 * only its header. Folders with no visible notes still render.
 *
 * @param foldersByParent - Parent-keyed folder map from {@link groupFoldersByParent}.
 * @param notesByFolder - Visible notes keyed by folder path.
 * @param collapsed - Collapsed folder paths.
 * @returns Flat rows in render order with per-row indent.
 */
export function flattenNoteTree(
  foldersByParent: ReadonlyMap<string, string[]>,
  notesByFolder: ReadonlyMap<string, NoteTreeRow[]>,
  collapsed: ReadonlySet<string>,
): FlatTreeRow[] {
  const items: FlatTreeRow[] = [];
  const walk = (path: string, depth: number) => {
    const indent = INDENT_BASE + depth * INDENT_STEP;
    const notes = notesByFolder.get(path) ?? [];
    items.push({
      kind: "folder",
      key: `folder:${path}`,
      path,
      depth,
      indent,
      noteCount: notes.length,
    });
    if (collapsed.has(path)) return;
    for (const child of foldersByParent.get(path) ?? []) {
      walk(child, depth + 1);
    }
    for (const note of notes) {
      items.push({ kind: "note", key: note.id, note, indent });
    }
  };
  for (const root of foldersByParent.get("") ?? []) walk(root, 0);
  for (const note of notesByFolder.get("") ?? []) {
    items.push({ kind: "note", key: note.id, note, indent: INDENT_BASE });
  }
  return items;
}
