import { test, expect } from "bun:test";
import {
  GROUP_ORDER,
  SAVED_VIEWS,
  STATUS_TOGGLE_ORDER,
  applyGrouping,
  countByState,
  emptyStateCounts,
  groupByProject,
  groupByState,
  lifecycleStageToneClass,
  matchesPriority,
  matchesSearch,
  parsePrioritySet,
  parseStatusSet,
  pickPickupTask,
  serializePrioritySet,
  serializeStatusSet,
  sortRows,
  viewPredicate,
} from "@/components/my-tasks/predicates";
import type { TaskState } from "@/lib/data/task";
import type { MyTask } from "@/lib/data/views";
import { UNPRIORITIZED_KEY } from "@/lib/ui/priority";

const NOW = new Date("2026-05-26T12:00:00Z");
const HOURS = 60 * 60 * 1000;

/** Build a deterministic MyTask fixture overlaying onto a baseline shape. */
function row(
  overrides: Partial<MyTask> & { id: string; state: TaskState },
): MyTask {
  return {
    id: overrides.id,
    taskRef: `MYMR-${overrides.id}`,
    title: `task ${overrides.id}`,
    status: overrides.status ?? "draft",
    state: overrides.state,
    category: null,
    tags: [],
    priority: overrides.priority ?? null,
    estimate: null,
    order: 0,
    updatedAt: overrides.updatedAt ?? NOW,
    hasDescription: false,
    hasCriteria: false,
    assigneeCount: 1,
    assigneeUserIds: ["user"],
    project: {
      id: "p",
      identifier: "MYMR",
      title: "Mymir",
      color: "hsl(0 0% 50%)",
    },
    stage: overrides.stage ?? "draft",
    upstreamCount: overrides.upstreamCount ?? 0,
    downstreamCount: overrides.downstreamCount ?? 0,
    blockedBy: overrides.blockedBy ?? null,
  };
}

test("viewPredicate(open) excludes done and cancelled", () => {
  expect(
    viewPredicate("open", row({ id: "1", state: "in_progress" }), NOW),
  ).toBe(true);
  expect(viewPredicate("open", row({ id: "2", state: "ready" }), NOW)).toBe(
    true,
  );
  expect(viewPredicate("open", row({ id: "3", state: "done" }), NOW)).toBe(
    false,
  );
  expect(viewPredicate("open", row({ id: "4", state: "cancelled" }), NOW)).toBe(
    false,
  );
});

test("viewPredicate(today) includes in-flight states regardless of age", () => {
  const stale = row({
    id: "1",
    state: "in_progress",
    updatedAt: new Date(NOW.getTime() - 72 * HOURS),
  });
  expect(viewPredicate("today", stale, NOW)).toBe(true);
});

test("viewPredicate(today) includes any open task touched in the last 24h", () => {
  const recent = row({
    id: "1",
    state: "ready",
    updatedAt: new Date(NOW.getTime() - 2 * HOURS),
  });
  const old = row({
    id: "2",
    state: "ready",
    updatedAt: new Date(NOW.getTime() - 36 * HOURS),
  });
  expect(viewPredicate("today", recent, NOW)).toBe(true);
  expect(viewPredicate("today", old, NOW)).toBe(false);
});

test("viewPredicate(stale) requires 7+ days of inactivity and not terminal", () => {
  const stale = row({
    id: "1",
    state: "ready",
    updatedAt: new Date(NOW.getTime() - 10 * 24 * HOURS),
  });
  const fresh = row({
    id: "2",
    state: "ready",
    updatedAt: new Date(NOW.getTime() - 2 * 24 * HOURS),
  });
  const staleDone = row({
    id: "3",
    state: "done",
    updatedAt: new Date(NOW.getTime() - 14 * 24 * HOURS),
  });
  expect(viewPredicate("stale", stale, NOW)).toBe(true);
  expect(viewPredicate("stale", fresh, NOW)).toBe(false);
  expect(viewPredicate("stale", staleDone, NOW)).toBe(false);
});

test("viewPredicate(done) only matches done", () => {
  expect(viewPredicate("done", row({ id: "1", state: "done" }), NOW)).toBe(
    true,
  );
  expect(
    viewPredicate("done", row({ id: "2", state: "in_progress" }), NOW),
  ).toBe(false);
});

test("viewPredicate(all) matches every row", () => {
  for (const state of GROUP_ORDER) {
    expect(viewPredicate("all", row({ id: state, state }), NOW)).toBe(true);
  }
});

test("emptyStateCounts initialises every TaskState bucket to 0", () => {
  const counts = emptyStateCounts();
  for (const state of GROUP_ORDER) {
    expect(counts[state]).toBe(0);
  }
});

test("countByState tallies rows by derived state", () => {
  const rows = [
    row({ id: "1", state: "in_progress" }),
    row({ id: "2", state: "in_progress" }),
    row({ id: "3", state: "ready" }),
    row({ id: "4", state: "done" }),
  ];
  const counts = countByState(rows);
  expect(counts.in_progress).toBe(2);
  expect(counts.ready).toBe(1);
  expect(counts.done).toBe(1);
  expect(counts.cancelled).toBe(0);
});

test("groupByState orders groups per GROUP_ORDER and skips empty buckets", () => {
  const rows = [
    row({ id: "1", state: "done" }),
    row({ id: "2", state: "in_progress" }),
    row({ id: "3", state: "ready" }),
  ];
  const groups = groupByState(rows);
  expect(groups.map((g) => g.state)).toEqual(["in_progress", "ready", "done"]);
});

test("pickPickupTask prefers urgent in_progress over core ready over any ready", () => {
  const urgent = row({ id: "1", state: "in_progress", priority: "urgent" });
  const core = row({ id: "2", state: "ready", priority: "core" });
  const any = row({ id: "3", state: "ready" });
  expect(pickPickupTask([urgent, core, any])?.id).toBe("1");
  expect(pickPickupTask([core, any])?.id).toBe("2");
  expect(pickPickupTask([any])?.id).toBe("3");
});

test("pickPickupTask returns null when nothing is in flight or ready", () => {
  const rows = [
    row({ id: "1", state: "draft" }),
    row({ id: "2", state: "done" }),
  ];
  expect(pickPickupTask(rows)).toBeNull();
});

test("matchesSearch matches title and taskRef case-insensitively", () => {
  const r = row({ id: "12", state: "ready" });
  expect(matchesSearch(r, "TASK")).toBe(true);
  expect(matchesSearch(r, "mymr-12")).toBe(true);
  expect(matchesSearch(r, "  ")).toBe(true);
  expect(matchesSearch(r, "nope")).toBe(false);
});

test("matchesSearch short-circuits on a full taskRef", () => {
  const target = row({ id: "12", state: "ready" });
  const other = row({ id: "13", state: "ready" });
  // The two rows share `task` in their title; the full-ref query should
  // surface ONLY the exact match and skip the title substring fallback.
  expect(matchesSearch(target, "MYMR-12")).toBe(true);
  expect(matchesSearch(other, "MYMR-12")).toBe(false);
});

test("matchesSearch tokens AND-join across fields", () => {
  const r: MyTask = {
    ...row({ id: "1", state: "ready" }),
    title: "Fix the auth race",
    tags: ["backend", "race-condition"],
    category: "Bug",
  };
  // Both tokens hit different fields — should match.
  expect(matchesSearch(r, "auth backend")).toBe(true);
  // First token hits, second misses everywhere — should not match.
  expect(matchesSearch(r, "auth frontend")).toBe(false);
  // Project identifier matches the second token.
  expect(matchesSearch(r, "auth mymr")).toBe(true);
});

test("matchesSearch sees tags and category in addition to title", () => {
  const r: MyTask = {
    ...row({ id: "1", state: "ready" }),
    title: "totally unrelated",
    tags: ["kafka"],
    category: "Infra",
  };
  expect(matchesSearch(r, "kafka")).toBe(true);
  expect(matchesSearch(r, "infra")).toBe(true);
  expect(matchesSearch(r, "missing")).toBe(false);
});

test("matchesSearch sees project title and identifier", () => {
  const r: MyTask = {
    ...row({ id: "1", state: "ready" }),
    project: {
      id: "p",
      identifier: "ORAS",
      title: "Oracle Service",
      color: "hsl(0 0% 50%)",
    },
  };
  expect(matchesSearch(r, "oras")).toBe(true);
  expect(matchesSearch(r, "oracle")).toBe(true);
});

test("lifecycleStageToneClass returns a non-empty class string for every stage", () => {
  for (const stage of ["draft", "planning", "working", "done"] as const) {
    expect(lifecycleStageToneClass(stage).length).toBeGreaterThan(0);
  }
});

test("constants are aligned for the UI to import", () => {
  expect(SAVED_VIEWS.length).toBe(5);
  expect(STATUS_TOGGLE_ORDER.length).toBeGreaterThan(0);
  expect(GROUP_ORDER.length).toBe(8);
});

test("parseStatusSet allowlists tokens and drops unknown", () => {
  const set = parseStatusSet("in_progress,bogus,ready,done");
  expect([...set].sort()).toEqual(["done", "in_progress", "ready"]);
});

test("parseStatusSet(null) returns an empty set", () => {
  expect(parseStatusSet(null).size).toBe(0);
});

test("serializeStatusSet emits canonical STATUS_TOGGLE_ORDER", () => {
  const set = new Set<TaskState>(["done", "in_progress", "ready"]);
  expect(serializeStatusSet(set)).toBe("in_progress,ready,done");
});

test("parsePrioritySet allowlists schema priorities + Unprioritized sentinel", () => {
  const set = parsePrioritySet("urgent,bogus,core,Unprioritized");
  expect([...set].sort()).toEqual([UNPRIORITIZED_KEY, "core", "urgent"]);
});

test("serializePrioritySet emits canonical order", () => {
  const set = new Set<string>(["core", "urgent", UNPRIORITIZED_KEY]);
  expect(serializePrioritySet(set)).toBe(`urgent,core,${UNPRIORITIZED_KEY}`);
});

test("matchesPriority(empty set) passes every row through", () => {
  const r = row({ id: "1", state: "ready", priority: "core" });
  expect(matchesPriority(r, new Set())).toBe(true);
});

test("matchesPriority(set) filters by exact value and Unprioritized maps to null", () => {
  const urgent = row({ id: "1", state: "in_progress", priority: "urgent" });
  const noPrio = row({ id: "2", state: "ready", priority: null });
  expect(matchesPriority(urgent, new Set(["urgent"]))).toBe(true);
  expect(matchesPriority(urgent, new Set(["core"]))).toBe(false);
  expect(matchesPriority(noPrio, new Set([UNPRIORITIZED_KEY]))).toBe(true);
  expect(matchesPriority(noPrio, new Set(["urgent"]))).toBe(false);
});

test("sortRows(priority) orders urgent → core → normal → backlog → null", () => {
  const rows = [
    row({ id: "a", state: "in_progress", priority: "normal" }),
    row({ id: "b", state: "in_progress", priority: "urgent" }),
    row({ id: "c", state: "in_progress", priority: null }),
    row({ id: "d", state: "in_progress", priority: "backlog" }),
    row({ id: "e", state: "in_progress", priority: "core" }),
  ];
  const sorted = sortRows(rows, "priority");
  expect(sorted.map((r) => r.id)).toEqual(["b", "e", "a", "d", "c"]);
});

test("sortRows(id) orders by taskRef ascending", () => {
  const rows = [
    row({ id: "10", state: "ready" }),
    row({ id: "2", state: "ready" }),
    row({ id: "100", state: "ready" }),
  ];
  // taskRef strings sort lexicographically: MYMR-10, MYMR-100, MYMR-2.
  const sorted = sortRows(rows, "id");
  expect(sorted.map((r) => r.taskRef)).toEqual([
    "MYMR-10",
    "MYMR-100",
    "MYMR-2",
  ]);
});

test("sortRows(status) follows GROUP_ORDER", () => {
  const rows = [
    row({ id: "1", state: "done" }),
    row({ id: "2", state: "in_progress" }),
    row({ id: "3", state: "ready" }),
    row({ id: "4", state: "draft" }),
  ];
  const sorted = sortRows(rows, "status");
  expect(sorted.map((r) => r.state)).toEqual([
    "in_progress",
    "ready",
    "draft",
    "done",
  ]);
});

test("sortRows(updated) puts newer first, ties resolve on id", () => {
  const base = new Date("2026-05-01T00:00:00Z");
  const day = 24 * 60 * 60 * 1000;
  const rows = [
    row({ id: "a", state: "ready", updatedAt: new Date(base.getTime()) }),
    row({
      id: "b",
      state: "ready",
      updatedAt: new Date(base.getTime() + 2 * day),
    }),
    row({
      id: "c",
      state: "ready",
      updatedAt: new Date(base.getTime() + day),
    }),
  ];
  const sorted = sortRows(rows, "updated");
  expect(sorted.map((r) => r.id)).toEqual(["b", "c", "a"]);
});

test("groupByProject buckets rows and orders groups alphabetically", () => {
  const rows: MyTask[] = [
    {
      ...row({ id: "1", state: "ready" }),
      project: {
        id: "proj-z",
        identifier: "ZULU",
        title: "Zulu",
        color: "hsl(0 0% 50%)",
      },
    },
    {
      ...row({ id: "2", state: "ready" }),
      project: {
        id: "proj-a",
        identifier: "ALFA",
        title: "Alfa",
        color: "hsl(0 0% 50%)",
      },
    },
    {
      ...row({ id: "3", state: "ready" }),
      project: {
        id: "proj-a",
        identifier: "ALFA",
        title: "Alfa",
        color: "hsl(0 0% 50%)",
      },
    },
  ];
  const groups = groupByProject(rows);
  expect(groups.map((g) => g.projectTitle)).toEqual(["Alfa", "Zulu"]);
  expect(groups[0].rows.map((r) => r.id)).toEqual(["2", "3"]);
});

test("applyGrouping(none) returns a single bundle when rows are non-empty", () => {
  const rows = [
    row({ id: "1", state: "in_progress" }),
    row({ id: "2", state: "ready" }),
  ];
  const groups = applyGrouping(rows, "none");
  expect(groups.length).toBe(1);
  expect(groups[0].kind).toBe("none");
  expect(groups[0].rows.length).toBe(2);
});

test("applyGrouping(status) returns the same shape as groupByState", () => {
  const rows = [
    row({ id: "1", state: "ready" }),
    row({ id: "2", state: "in_progress" }),
  ];
  const groups = applyGrouping(rows, "status");
  expect(groups.map((g) => g.kind)).toEqual(["status", "status"]);
  expect(groups.map((g) => g.key)).toEqual(["in_progress", "ready"]);
});

test("applyGrouping([], any) returns an empty array", () => {
  expect(applyGrouping([], "status").length).toBe(0);
  expect(applyGrouping([], "project").length).toBe(0);
  expect(applyGrouping([], "none").length).toBe(0);
});
