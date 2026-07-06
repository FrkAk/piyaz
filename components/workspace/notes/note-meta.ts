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
  const leaf = rawName
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
    .join("/");
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
