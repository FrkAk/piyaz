import { test, expect } from "bun:test";
import {
  GROUP_ORDER,
  SAVED_VIEWS,
  STATUS_TOGGLE_ORDER,
  countByState,
  emptyStateCounts,
  groupByState,
  lifecycleStageToneClass,
  matchesSearch,
  pickPickupTask,
  viewPredicate,
} from "@/components/my-tasks/predicates";
import type { TaskState } from "@/lib/data/task";
import type { MyTask } from "@/lib/data/views";

const NOW = new Date("2026-05-26T12:00:00Z");
const HOURS = 60 * 60 * 1000;

/** Build a deterministic MyTask fixture overlaying onto a baseline shape. */
function row(overrides: Partial<MyTask> & { id: string; state: TaskState }): MyTask {
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
    agentActive: overrides.agentActive ?? false,
  };
}

test("viewPredicate(open) excludes done and cancelled", () => {
  expect(viewPredicate("open", row({ id: "1", state: "in_progress" }), NOW)).toBe(true);
  expect(viewPredicate("open", row({ id: "2", state: "ready" }), NOW)).toBe(true);
  expect(viewPredicate("open", row({ id: "3", state: "done" }), NOW)).toBe(false);
  expect(viewPredicate("open", row({ id: "4", state: "cancelled" }), NOW)).toBe(false);
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
  expect(viewPredicate("done", row({ id: "1", state: "done" }), NOW)).toBe(true);
  expect(viewPredicate("done", row({ id: "2", state: "in_progress" }), NOW)).toBe(false);
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

test("lifecycleStageToneClass returns a non-empty class string for every stage", () => {
  for (const stage of ["draft", "planning", "working", "agent", "execution"] as const) {
    expect(lifecycleStageToneClass(stage).length).toBeGreaterThan(0);
  }
});

test("constants are aligned for the UI to import", () => {
  expect(SAVED_VIEWS.length).toBe(5);
  expect(STATUS_TOGGLE_ORDER.length).toBeGreaterThan(0);
  expect(GROUP_ORDER.length).toBe(8);
});
