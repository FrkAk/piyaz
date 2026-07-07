/**
 * Pure decision predicates for the note editor's title reconciliation.
 * React-free, no cache or DOM access, so the local stale-title clobber fix
 * (PYZ-301) and the remote conflict banner (PYZ-262) can share one
 * reconcile/commit decision. The editor holds the title in local state; the
 * detail query cache advances `serverTitle` on a tree rename or a remote
 * change. These predicates gate when the local state adopts the server value
 * and when a local edit is committed back.
 */

/** Provenance inputs for {@link shouldAdoptServerTitle}. */
export interface AdoptTitleInput {
  /** @param dirty - The input holds user edits not yet committed. */
  dirty: boolean;
  /** @param focused - The title input currently has focus. */
  focused: boolean;
}

/** Provenance inputs for {@link shouldCommitTitle}. */
export interface CommitTitleInput {
  /** @param dirty - The input holds user edits not yet committed. */
  dirty: boolean;
  /** @param localTitle - The editor's local title, or null before seeding. */
  localTitle: string | null;
  /** @param serverTitle - The note's current cached title. */
  serverTitle: string;
  /** @param locked - The note is locked and rejects writes. */
  locked: boolean;
}

/** Provenance inputs for {@link shouldClearDirty}. */
export interface ClearDirtyInput {
  /** @param dirty - The input holds user edits not yet committed. */
  dirty: boolean;
  /** @param localTitle - The editor's local title, or null before seeding. */
  localTitle: string | null;
  /** @param serverTitle - The note's current cached title. */
  serverTitle: string;
}

/**
 * Decide whether the editor should adopt the server title into local state.
 * Adoption is safe only when the input is idle: no uncommitted edits and no
 * focus. A focused or dirty input holds in-progress user text that a server
 * change must never overwrite (PYZ-301 AC 4b46ea3f).
 *
 * @param input - Dirty and focus provenance for the title input.
 * @returns True when the local title may be replaced by the server value.
 */
export function shouldAdoptServerTitle({
  dirty,
  focused,
}: AdoptTitleInput): boolean {
  return !dirty && !focused;
}

/**
 * Decide whether a local title edit should be committed to autosave. Commits
 * only user-originated changes: the input must be dirty, unlocked, seeded,
 * and actually diverged from the server value. This is what stops the
 * blur/Enter/unmount commit from writing a stale, externally-superseded title
 * back over a rename.
 *
 * @param input - Dirty, local title, server title, and locked provenance.
 * @returns True when the local title should be written through autosave.
 */
export function shouldCommitTitle({
  dirty,
  localTitle,
  serverTitle,
  locked,
}: CommitTitleInput): boolean {
  return dirty && !locked && localTitle !== null && localTitle !== serverTitle;
}

/**
 * Decide whether a dirty flag should be cleared without a commit. A dirty edit
 * that has converged back to the server value (the user typed then reverted to
 * the same text) has nothing to write, yet leaving it dirty wedges the flag
 * true for the session: it blocks {@link shouldAdoptServerTitle} from adopting
 * a later external rename, then lets the blur/unmount commit write the stale
 * local title over that rename (PYZ-301).
 *
 * @param input - Dirty, local title, and server title provenance.
 * @returns True when the flag should be cleared because the edit netted to no change.
 */
export function shouldClearDirty({
  dirty,
  localTitle,
  serverTitle,
}: ClearDirtyInput): boolean {
  return dirty && localTitle !== null && localTitle === serverTitle;
}
