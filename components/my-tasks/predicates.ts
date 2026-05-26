import type { TaskState } from "@/lib/data/task";
import type { LifecycleStage, MyTask } from "@/lib/data/views";

/** Identifier for one of the five hardcoded saved views on `/my-tasks`. */
export type SavedView = "open" | "today" | "stale" | "done" | "all";

/** Tabs render in this order; `useSavedView` also keys hotkeys 1-5 off it. */
export const SAVED_VIEWS: readonly SavedView[] = [
  "open",
  "today",
  "stale",
  "done",
  "all",
];

/** Human label for each saved view (sentence case per UX_PRINCIPLES § 1). */
export const SAVED_VIEW_LABEL: Record<SavedView, string> = {
  open: "Open",
  today: "Today",
  stale: "Stale",
  done: "Done",
  all: "All",
};

/**
 * Status-count toggle order shown under the H1. Mirrors the row group order
 * inside the list. `cancelled` is intentionally absent — cancelled rows
 * are surfaced via the `all` saved view, not the per-status toggle row.
 */
export const STATUS_TOGGLE_ORDER: readonly TaskState[] = [
  "in_progress",
  "in_review",
  "blocked",
  "ready",
  "plannable",
  "draft",
  "done",
];

/** Row group order inside `<MyTasksList>`. Cancelled trails after done. */
export const GROUP_ORDER: readonly TaskState[] = [
  "in_progress",
  "in_review",
  "blocked",
  "ready",
  "plannable",
  "draft",
  "done",
  "cancelled",
];

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Saved-view predicate. Pure function — same `(view, row, now)` always
 * returns the same boolean.
 *
 * - `open`: row is not done or cancelled.
 * - `today`: row is in flight (`in_progress` / `in_review`) OR was touched
 *   in the last 24 hours.
 * - `stale`: row is still open AND has not been touched in 7+ days.
 * - `done`: row is terminal-success.
 * - `all`: every row.
 */
export function viewPredicate(view: SavedView, row: MyTask, now: Date): boolean {
  const updated = row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt);
  const age = now.getTime() - updated.getTime();
  switch (view) {
    case "open":
      return row.state !== "done" && row.state !== "cancelled";
    case "today":
      if (row.state === "done" || row.state === "cancelled") return false;
      if (row.state === "in_progress" || row.state === "in_review") return true;
      return age < DAY_MS;
    case "stale":
      if (row.state === "done" || row.state === "cancelled") return false;
      return age >= WEEK_MS;
    case "done":
      return row.state === "done";
    case "all":
      return true;
  }
}

/** Initialise a `Record<TaskState, number>` with every bucket at 0. */
export function emptyStateCounts(): Record<TaskState, number> {
  return {
    draft: 0,
    plannable: 0,
    ready: 0,
    blocked: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
    cancelled: 0,
  };
}

/** Tally rows by derived state. Every bucket present, zero-initialised. */
export function countByState(
  rows: readonly MyTask[],
): Record<TaskState, number> {
  const counts = emptyStateCounts();
  for (const row of rows) counts[row.state] += 1;
  return counts;
}

/** One group of rows sharing a derived state, ready for `<MyTasksList>`. */
export interface StateGroup {
  state: TaskState;
  rows: MyTask[];
}

/**
 * Group rows by derived `state` and return groups in {@link GROUP_ORDER}.
 * Empty states are skipped so the list doesn't render empty headers.
 */
export function groupByState(rows: readonly MyTask[]): StateGroup[] {
  const buckets = new Map<TaskState, MyTask[]>();
  for (const row of rows) {
    const bucket = buckets.get(row.state);
    if (bucket) bucket.push(row);
    else buckets.set(row.state, [row]);
  }
  const out: StateGroup[] = [];
  for (const state of GROUP_ORDER) {
    const rowsForState = buckets.get(state);
    if (rowsForState && rowsForState.length > 0) {
      out.push({ state, rows: rowsForState });
    }
  }
  return out;
}

/**
 * Pickup-banner candidate selection per DESIGN.md § 3 — first urgent
 * in-progress, else first core ready, else any ready, else null. Selection
 * is done against the *full* payload, not the active-view subset, so the
 * banner stays visible even when the user filters the list.
 */
export function pickPickupTask(rows: readonly MyTask[]): MyTask | null {
  const urgentInProgress = rows.find(
    (r) => r.state === "in_progress" && r.priority === "urgent",
  );
  if (urgentInProgress) return urgentInProgress;
  const coreReady = rows.find(
    (r) => r.state === "ready" && r.priority === "core",
  );
  if (coreReady) return coreReady;
  const anyReady = rows.find((r) => r.state === "ready");
  return anyReady ?? null;
}

/**
 * Case-insensitive substring match against `title` and `taskRef`. Empty /
 * whitespace query matches every row.
 */
export function matchesSearch(row: MyTask, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return (
    row.title.toLowerCase().includes(q) ||
    row.taskRef.toLowerCase().includes(q)
  );
}

/**
 * Tailwind class string for the row's lifecycle stage pill. Colors come
 * from existing `--color-glyph-*` tokens — no new tokens introduced per
 * UX_PRINCIPLES § 14.3.
 */
export function lifecycleStageToneClass(stage: LifecycleStage): string {
  switch (stage) {
    case "agent":
      return "text-accent-light bg-accent/12 border border-accent/22";
    case "planning":
      return "text-glyph-planned bg-glyph-planned/12 border border-glyph-planned/22";
    case "working":
      return "text-glyph-progress bg-glyph-progress/12 border border-glyph-progress/22";
    case "execution":
      return "text-glyph-done bg-glyph-done/12 border border-glyph-done/22";
    case "draft":
      return "text-text-muted bg-surface-raised border border-border";
  }
}
