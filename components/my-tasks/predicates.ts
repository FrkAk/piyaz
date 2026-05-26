import type { TaskState } from "@/lib/data/task";
import type { LifecycleStage, MyTask } from "@/lib/data/views";
import type { Priority } from "@/lib/types";
import { UNPRIORITIZED_KEY } from "@/lib/ui/priority";

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

/** Full-taskRef pattern (case-insensitive): `MYMR-101`, `ORAS-42`. */
const TASK_REF_PATTERN = /^[a-z0-9]+-\d+$/;

/**
 * Multi-field, multi-token search match. Mirrors `searchTasksAcrossProjects`
 * server-side semantics for the in-memory row set:
 *
 * - **TaskRef short-circuit** — a query that parses as a full taskRef
 *   (e.g. `MYMR-101`) matches exactly the row with that identifier; nothing
 *   else surfaces. Lets the operator paste a ref into the box and land
 *   directly on the row.
 * - **Multi-token AND** — whitespace-separated tokens AND-join. Each token
 *   must match somewhere across the row's searchable fields. Tokens
 *   themselves retain punctuation so a partial ref like `mymr-1` stays
 *   intact instead of fragmenting into `mymr` + `1`.
 * - **Wide field coverage** — title, taskRef, project title + identifier,
 *   category, and every tag. Matches the command palette's reach within
 *   the cap of "no server round-trip".
 *
 * An empty / whitespace-only query passes every row through.
 */
export function matchesSearch(row: MyTask, query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) return true;
  const lower = trimmed.toLowerCase();

  if (TASK_REF_PATTERN.test(lower)) {
    return row.taskRef.toLowerCase() === lower;
  }

  const tokens = lower.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return true;

  const fields: string[] = [
    row.title,
    row.taskRef,
    row.project.title,
    row.project.identifier,
    row.category ?? "",
    ...row.tags,
  ];
  const fieldLowers = fields.map((f) => f.toLowerCase());

  return tokens.every((t) => fieldLowers.some((f) => f.includes(t)));
}

/** Multi-select status filter — URL-serialized as a comma-separated list. */
export function parseStatusSet(raw: string | null): ReadonlySet<TaskState> {
  if (!raw) return new Set();
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p): p is TaskState =>
      STATUS_TOGGLE_ORDER.includes(p as TaskState),
    );
  return new Set(parts);
}

/** Serialize the active status set in canonical {@link STATUS_TOGGLE_ORDER}. */
export function serializeStatusSet(set: ReadonlySet<TaskState>): string {
  return STATUS_TOGGLE_ORDER.filter((s) => set.has(s)).join(",");
}

const PRIORITY_FILTER_VALUES = new Set<string>([
  "urgent",
  "core",
  "normal",
  "backlog",
  UNPRIORITIZED_KEY,
]);

/**
 * Multi-select priority filter — same CSV pattern as status. Allowlists to
 * the four schema priorities plus {@link UNPRIORITIZED_KEY} for null rows.
 */
export function parsePrioritySet(raw: string | null): ReadonlySet<string> {
  if (!raw) return new Set();
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => PRIORITY_FILTER_VALUES.has(p));
  return new Set(parts);
}

export function serializePrioritySet(set: ReadonlySet<string>): string {
  const order = ["urgent", "core", "normal", "backlog", UNPRIORITIZED_KEY];
  return order.filter((p) => set.has(p)).join(",");
}

/** Match a row against the active priority filter (empty set passes through). */
export function matchesPriority(
  row: MyTask,
  active: ReadonlySet<string>,
): boolean {
  if (active.size === 0) return true;
  if (row.priority === null) return active.has(UNPRIORITIZED_KEY);
  return active.has(row.priority);
}

/** Sort key surfaced in the toolbar's Sort dropdown. */
export type SortKey = "updated" | "priority" | "status" | "id";

export const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: "updated", label: "Updated" },
  { value: "priority", label: "Priority" },
  { value: "status", label: "Status" },
  { value: "id", label: "ID" },
];

const STATE_ORDER_INDEX: Record<TaskState, number> = (() => {
  const map = {} as Record<TaskState, number>;
  GROUP_ORDER.forEach((s, i) => {
    map[s] = i;
  });
  return map;
})();

const PRIORITY_RANK_MAP: Record<Priority, number> = {
  urgent: 0,
  core: 1,
  normal: 2,
  backlog: 3,
};

/**
 * Comparator-driven sort over a defensive copy. `updated` matches the
 * server's `updatedAt DESC, id ASC`. `priority` puts urgent first; rows
 * without a priority trail. Ties resolve on `taskRef` for stability.
 */
export function sortRows(rows: readonly MyTask[], key: SortKey): MyTask[] {
  const copy = rows.slice();
  switch (key) {
    case "updated": {
      copy.sort((a, b) => {
        const at = a.updatedAt instanceof Date ? a.updatedAt.getTime() : Date.parse(String(a.updatedAt));
        const bt = b.updatedAt instanceof Date ? b.updatedAt.getTime() : Date.parse(String(b.updatedAt));
        if (bt !== at) return bt - at;
        return a.id.localeCompare(b.id);
      });
      return copy;
    }
    case "priority": {
      copy.sort((a, b) => {
        const ar = a.priority ? PRIORITY_RANK_MAP[a.priority] : 4;
        const br = b.priority ? PRIORITY_RANK_MAP[b.priority] : 4;
        if (ar !== br) return ar - br;
        return a.taskRef.localeCompare(b.taskRef);
      });
      return copy;
    }
    case "status": {
      copy.sort((a, b) => {
        const ai = STATE_ORDER_INDEX[a.state];
        const bi = STATE_ORDER_INDEX[b.state];
        if (ai !== bi) return ai - bi;
        return a.taskRef.localeCompare(b.taskRef);
      });
      return copy;
    }
    case "id": {
      copy.sort((a, b) => a.taskRef.localeCompare(b.taskRef));
      return copy;
    }
  }
}

/** Group key surfaced in the toolbar's Group dropdown. */
export type GroupKey = "status" | "project" | "none";

export const GROUP_OPTIONS: ReadonlyArray<{ value: GroupKey; label: string }> = [
  { value: "status", label: "Status" },
  { value: "project", label: "Project" },
  { value: "none", label: "None" },
];

/** Per-project bundle returned by {@link groupByProject}. */
export interface ProjectGroup {
  projectId: string;
  projectTitle: string;
  projectIdentifier: string;
  projectColor: string;
  rows: MyTask[];
}

export function groupByProject(rows: readonly MyTask[]): ProjectGroup[] {
  const buckets = new Map<string, ProjectGroup>();
  for (const row of rows) {
    const existing = buckets.get(row.project.id);
    if (existing) {
      existing.rows.push(row);
    } else {
      buckets.set(row.project.id, {
        projectId: row.project.id,
        projectTitle: row.project.title,
        projectIdentifier: row.project.identifier,
        projectColor: row.project.color,
        rows: [row],
      });
    }
  }
  return [...buckets.values()].sort((a, b) =>
    a.projectTitle.localeCompare(b.projectTitle),
  );
}

/** Discriminated group payload consumed by `<MyTasksList>`. */
export type DisplayGroup =
  | { kind: "status"; key: TaskState; rows: MyTask[] }
  | {
      kind: "project";
      key: string;
      projectTitle: string;
      projectIdentifier: string;
      projectColor: string;
      rows: MyTask[];
    }
  | { kind: "none"; key: "all"; rows: MyTask[] };

export function applyGrouping(
  rows: readonly MyTask[],
  key: GroupKey,
): DisplayGroup[] {
  if (key === "status") {
    return groupByState(rows).map((g) => ({
      kind: "status" as const,
      key: g.state,
      rows: g.rows,
    }));
  }
  if (key === "project") {
    return groupByProject(rows).map((g) => ({
      kind: "project" as const,
      key: g.projectId,
      projectTitle: g.projectTitle,
      projectIdentifier: g.projectIdentifier,
      projectColor: g.projectColor,
      rows: g.rows,
    }));
  }
  if (rows.length === 0) return [];
  return [{ kind: "none", key: "all", rows: rows.slice() }];
}

export { PRIORITY_DISPLAY_ORDER } from "@/lib/ui/priority";
export { UNPRIORITIZED_KEY } from "@/lib/ui/priority";

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
