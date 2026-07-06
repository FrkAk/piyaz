import type { NoteFull } from "@/lib/data/note";

/** The three discrete stops of the note access slider. */
export type AccessLevel = "open" | "agent" | "locked";

/**
 * Derive the access level from a note's write flags. `locked` wins over
 * `agentWritable`; an unlocked note is `open` when agents may write and
 * `agent` (read-only for agents) otherwise.
 *
 * @param note - The note's `agentWritable` and `locked` columns.
 * @returns The matching access level.
 */
export function accessLevel(
  note: Pick<NoteFull, "agentWritable" | "locked">,
): AccessLevel {
  if (note.locked) return "locked";
  return note.agentWritable ? "open" : "agent";
}

/** The write-flag patch one access level maps to. */
export type AccessFlags = { agentWritable: boolean; locked: boolean };

/**
 * Map an access level back to the note's write flags.
 *
 * @param level - Target access level.
 * @returns The `agentWritable` / `locked` flags for that level.
 */
export function applyAccessLevel(level: AccessLevel): AccessFlags {
  if (level === "locked") return { agentWritable: false, locked: true };
  if (level === "agent") return { agentWritable: false, locked: false };
  return { agentWritable: true, locked: false };
}

/**
 * Whether a display-case feed target (a project category or tag) is present
 * in a note's stored feed list. Feed targets are canonicalized to trimmed
 * lowercase on write (PYZ-250), while the project vocabulary keeps display
 * case, so membership is compared case-insensitively.
 *
 * @param stored - The note's stored feed target list (lowercase).
 * @param option - A display-case vocabulary option.
 * @returns `true` when the option matches a stored target.
 */
export function feedTargetActive(
  stored: readonly string[],
  option: string,
): boolean {
  const needle = option.trim().toLowerCase();
  return stored.some((value) => value.toLowerCase() === needle);
}
