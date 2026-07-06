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
