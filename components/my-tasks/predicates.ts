import type { TaskState } from "@/lib/data/task";
import type { MyTask } from "@/lib/data/views";
import type { Priority } from "@/lib/types";
import { UNPRIORITIZED_KEY } from "@/lib/ui/priority";

export type SavedView = "open" | "today" | "stale" | "done" | "all";

// Order drives hotkeys 1-5 in useSavedView.
export const SAVED_VIEWS: readonly SavedView[] = [
  "open",
  "today",
  "stale",
  "done",
  "all",
];

export const SAVED_VIEW_LABEL: Record<SavedView, string> = {
  open: "Open",
  today: "Today",
  stale: "Stale",
  done: "Done",
  all: "All",
};

// `cancelled` omitted: surfaced via the `all` view, not the toggle row.
export const STATUS_TOGGLE_ORDER: readonly TaskState[] = [
  "in_progress",
  "in_review",
  "blocked",
  "ready",
  "plannable",
  "draft",
  "done",
];

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

export function viewPredicate(
  view: SavedView,
  row: MyTask,
  now: Date,
): boolean {
  const updated =
    row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt);
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

export function countByState(
  rows: readonly MyTask[],
): Record<TaskState, number> {
  const counts = emptyStateCounts();
  for (const row of rows) counts[row.state] += 1;
  return counts;
}

export interface StateGroup {
  state: TaskState;
  rows: MyTask[];
}

// Empty states omitted so the list doesn't render empty headers.
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

// Runs against the full payload, not the active view, so the banner
// stays visible when the user filters the list.
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

const TASK_REF_PATTERN = /^[a-z0-9]+-\d+$/;

// One lowercased blob per row, computed once and reused for every keystroke.
// Field boundary is `\n` so `mymr` in the project identifier can't bleed into
// the title of the same row (`includes` is substring, not token-bounded — the
// newline keeps adjacent fields independent).
function buildHaystack(row: MyTask): string {
  return [
    row.title,
    row.taskRef,
    row.project.title,
    row.project.identifier,
    row.category ?? "",
    ...row.tags,
  ]
    .join("\n")
    .toLowerCase();
}

export function buildSearchHaystacks(
  rows: readonly MyTask[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) out.set(row.id, buildHaystack(row));
  return out;
}

// Tokens split on whitespace only (not punctuation) so a partial ref like
// `mymr-1` stays intact rather than fragmenting into `mymr` + `1`.
// Production callers pass the precomputed `haystack` from
// `buildSearchHaystacks` to avoid per-keystroke allocations; tests may
// omit it and pay the per-call rebuild.
export function matchesSearch(
  row: MyTask,
  query: string,
  haystack?: string,
): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) return true;
  const lower = trimmed.toLowerCase();

  if (TASK_REF_PATTERN.test(lower)) {
    return row.taskRef.toLowerCase() === lower;
  }

  const tokens = lower.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return true;

  const blob = haystack ?? buildHaystack(row);
  return tokens.every((t) => blob.includes(t));
}

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

// Empty set passes every row through.
export function matchesPriority(
  row: MyTask,
  active: ReadonlySet<string>,
): boolean {
  if (active.size === 0) return true;
  if (row.priority === null) return active.has(UNPRIORITIZED_KEY);
  return active.has(row.priority);
}

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

// `updated` mirrors the server's `updatedAt DESC, id ASC`. Other keys
// tie-break on `taskRef` for a stable order across calls.
export function sortRows(rows: readonly MyTask[], key: SortKey): MyTask[] {
  const copy = rows.slice();
  switch (key) {
    case "updated": {
      copy.sort((a, b) => {
        const at =
          a.updatedAt instanceof Date
            ? a.updatedAt.getTime()
            : Date.parse(String(a.updatedAt));
        const bt =
          b.updatedAt instanceof Date
            ? b.updatedAt.getTime()
            : Date.parse(String(b.updatedAt));
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
        return a.taskRef.localeCompare(b.taskRef, undefined, { numeric: true });
      });
      return copy;
    }
    case "status": {
      copy.sort((a, b) => {
        const ai = STATE_ORDER_INDEX[a.state];
        const bi = STATE_ORDER_INDEX[b.state];
        if (ai !== bi) return ai - bi;
        return a.taskRef.localeCompare(b.taskRef, undefined, { numeric: true });
      });
      return copy;
    }
    case "id": {
      copy.sort((a, b) =>
        a.taskRef.localeCompare(b.taskRef, undefined, { numeric: true }),
      );
      return copy;
    }
  }
}

export type GroupKey = "status" | "project" | "none";

export const GROUP_OPTIONS: ReadonlyArray<{ value: GroupKey; label: string }> =
  [
    { value: "status", label: "Status" },
    { value: "project", label: "Project" },
    { value: "none", label: "None" },
  ];

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

export function taskStateToneClass(state: TaskState): string {
  switch (state) {
    case "in_progress":
      return "text-glyph-progress bg-glyph-progress/12 border border-glyph-progress/22";
    case "in_review":
      return "text-glyph-review bg-glyph-review/12 border border-glyph-review/22";
    case "ready":
      return "text-glyph-ready bg-glyph-ready/12 border border-glyph-ready/22";
    case "blocked":
      return "text-glyph-blocked bg-glyph-blocked/12 border border-glyph-blocked/22";
    case "plannable":
      return "text-glyph-planned bg-glyph-planned/12 border border-glyph-planned/22";
    case "done":
      return "text-glyph-done bg-glyph-done/12 border border-glyph-done/22";
    case "cancelled":
      return "text-glyph-cancelled bg-glyph-cancelled/12 border border-glyph-cancelled/22";
    case "draft":
      return "text-text-secondary bg-surface-raised border border-border";
  }
}
