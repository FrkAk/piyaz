import type { Task } from "@/lib/db/schema";
import type { TaskSlimPatch } from "@/lib/realtime/types";

/**
 * Slim-visibility predicates for task-row writes. The slim graph payload
 * renders only a narrow projection of each task, so writers consult these
 * to classify a write for the realtime event contract: graph-inert writes
 * emit `metaChanged: false`, state-neutral slim writes ride a
 * {@link TaskSlimPatch} consumers merge in place, and state-affecting
 * writes (status, hasDescription/hasCriteria flips) force a graph
 * refetch because derived task states must be recomputed server-side.
 */

/** Task row columns rendered in the slim graph payload. */
export const SLIM_VISIBLE_TASK_FIELDS = [
  "title",
  "status",
  "category",
  "tags",
  "priority",
  "estimate",
  "order",
] as const;

/**
 * Positional equality for scalar-or-array column values.
 *
 * @param a - Current value.
 * @param b - Incoming value.
 * @returns Whether the values are equal.
 */
function columnEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/**
 * Whether trimmed non-emptiness differs between two description values.
 * The slim payload renders `hasDescription` (`length(btrim(...)) > 0`),
 * not the text.
 *
 * @param before - Description before the write.
 * @param after - Description after the write.
 * @returns Whether the `hasDescription` flag flips.
 */
export function descriptionPresenceFlipped(
  before: string,
  after: string,
): boolean {
  return before.trim().length > 0 !== after.trim().length > 0;
}

/**
 * Whether nullness differs between two executionRecord values. The slim
 * payload renders `hasExecutionRecord` as `IS NOT NULL`.
 *
 * @param before - Record before the write.
 * @param after - Record after the write.
 * @returns Whether the `hasExecutionRecord` flag flips.
 */
export function executionRecordPresenceFlipped(
  before: string | null,
  after: string | null,
): boolean {
  return (before === null) !== (after === null);
}

/** Classification of a pending tasks-row update for the event contract. */
export type TaskRowChangeClass = {
  /** Whether anything the slim graph payload renders changed. */
  metaChanged: boolean;
  /** Whether the change can alter a derived task state, own or
   *  downstream: status changes and hasDescription flips. These require
   *  a graph refetch; every other slim change patches in place. */
  stateAffecting: boolean;
};

/**
 * Classify a pending tasks-row update against the slim graph payload:
 * whether it changes anything slim-rendered, and whether it touches a
 * derived-state input (status; the `hasDescription` flip). The
 * `hasExecutionRecord` flip is slim-rendered but state-neutral, so it
 * counts as a patchable change.
 *
 * @param current - The task row before the write.
 * @param changes - Column changes about to be applied.
 * @returns The change classification.
 */
export function classifyTaskRowChanges(
  current: Task,
  changes: Record<string, unknown>,
): TaskRowChangeClass {
  let patchable = false;
  let stateAffecting = false;
  for (const field of SLIM_VISIBLE_TASK_FIELDS) {
    if (field in changes && !columnEqual(current[field], changes[field])) {
      if (field === "status") stateAffecting = true;
      else patchable = true;
    }
  }
  if (
    typeof changes.description === "string" &&
    descriptionPresenceFlipped(current.description, changes.description)
  ) {
    stateAffecting = true;
  }
  if (
    "executionRecord" in changes &&
    executionRecordPresenceFlipped(
      current.executionRecord,
      changes.executionRecord as string | null,
    )
  ) {
    patchable = true;
  }
  return { metaChanged: patchable || stateAffecting, stateAffecting };
}

/**
 * Snapshot the state-neutral slim fields of a post-write task row for the
 * realtime patch payload. A full snapshot (not a changed-fields diff)
 * keeps every applied patch a complete sync of these fields, so a merged
 * patch never leaves a cached row partially stale.
 *
 * @param row - The task row after the write.
 * @returns The patch payload.
 */
export function taskSlimPatchFromRow(row: Task): TaskSlimPatch {
  return {
    title: row.title,
    category: row.category,
    tags: row.tags,
    priority: row.priority,
    estimate: row.estimate,
    order: row.order,
    hasExecutionRecord: row.executionRecord !== null,
  };
}

/**
 * Whether two assignee id sets differ, order-insensitive. The slim
 * payload renders the assignee set, so any membership change is
 * slim-visible.
 *
 * @param before - Assignee user ids before the write.
 * @param after - Assignee user ids after the write.
 * @returns Whether the sets differ.
 */
export function assigneeSetChanged(
  before: readonly string[],
  after: readonly string[],
): boolean {
  const a = new Set(before);
  const b = new Set(after);
  if (a.size !== b.size) return true;
  for (const id of a) if (!b.has(id)) return true;
  return false;
}
