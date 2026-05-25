import type { TaskStatus } from "@/lib/types";

/** Lifecycle order rendered in the pill row. */
export const STATUS_OPTIONS: readonly TaskStatus[] = [
  "draft",
  "planned",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
];

const STATUS_OPTION_SET = new Set<TaskStatus>(STATUS_OPTIONS);

/** Default selection when `?status=` is absent. The active middle of the lifecycle. */
export const DEFAULT_ACTIVE: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "planned",
  "in_progress",
  "in_review",
]);

/**
 * Resolve the `?status=` param into a status set.
 * - absent (`null`) → default active set
 * - present-but-empty (`""`) → empty set (deliberate "show nothing")
 * - present CSV → exactly the listed statuses (unknown tokens dropped)
 */
export function parseStatusParam(raw: string | null): ReadonlySet<TaskStatus> {
  if (raw === null) return DEFAULT_ACTIVE;
  if (raw === "") return new Set<TaskStatus>();
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p): p is TaskStatus => STATUS_OPTION_SET.has(p as TaskStatus));
  return new Set(parts);
}

/** Serialize in canonical lifecycle order so the URL is stable across toggles. */
export function serializeStatusSet(set: ReadonlySet<TaskStatus>): string {
  return STATUS_OPTIONS.filter((s) => set.has(s)).join(",");
}

export function setsEqual(
  a: ReadonlySet<TaskStatus>,
  b: ReadonlySet<TaskStatus>,
): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function countByStatus<T extends { status: TaskStatus }>(
  rows: readonly T[],
): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    draft: 0,
    planned: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
    cancelled: 0,
  };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}
