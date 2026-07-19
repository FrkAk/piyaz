import type { Task } from "@/lib/db/schema";

/**
 * Slim-visibility predicates for the task metadata clock
 * (`tasks.meta_updated_at`). The slim graph payload renders only a narrow
 * projection of each task, so writers consult these predicates to decide
 * whether a write bumps `meta_updated_at` (slim-visible) or only
 * `updated_at` (content). The touch triggers in `docker/rls-functions.sql`
 * propagate row meta bumps to `projects.meta_updated_at`.
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

/**
 * Whether a pending tasks-row update changes anything the slim graph
 * payload renders: a slim-visible column, the `hasDescription` flip, or
 * the `hasExecutionRecord` flip.
 *
 * @param current - The task row before the write.
 * @param changes - Column changes about to be applied.
 * @returns Whether the write must bump `meta_updated_at`.
 */
export function taskRowMetaChanged(
  current: Task,
  changes: Record<string, unknown>,
): boolean {
  for (const field of SLIM_VISIBLE_TASK_FIELDS) {
    if (field in changes && !columnEqual(current[field], changes[field])) {
      return true;
    }
  }
  if (
    typeof changes.description === "string" &&
    descriptionPresenceFlipped(current.description, changes.description)
  ) {
    return true;
  }
  if (
    "executionRecord" in changes &&
    executionRecordPresenceFlipped(
      current.executionRecord,
      changes.executionRecord as string | null,
    )
  ) {
    return true;
  }
  return false;
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
