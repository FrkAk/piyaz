import { expect, test } from "bun:test";
import { effectiveDirectPrerequisiteIds } from "@/lib/ui/effective-prereqs";
import type { TaskGraphEdge } from "@/lib/data/views";

/**
 * Build a `depends_on` edge row.
 *
 * @param source - Source task id.
 * @param target - Target task id.
 * @returns Slim edge row.
 */
function dep(source: string, target: string): TaskGraphEdge {
  return {
    id: `${source}->${target}`,
    sourceTaskId: source,
    targetTaskId: target,
    edgeType: "depends_on",
  };
}

/**
 * Build a status map from `id: status` pairs.
 *
 * @param entries - Task id to status pairs.
 * @returns Map in the shape the walk consumes.
 */
function statuses(
  entries: Record<string, string>,
): Map<string, { status: string }> {
  return new Map(
    Object.entries(entries).map(([id, status]) => [id, { status }]),
  );
}

test("direct active prerequisites are the walls", () => {
  const edges = [dep("a", "b"), dep("a", "c")];
  const tasks = statuses({ a: "planned", b: "draft", c: "done" });
  expect(effectiveDirectPrerequisiteIds("a", edges, tasks)).toEqual(["b", "c"]);
});

test("cancelled middles are transparent: the wall behind them surfaces", () => {
  // a -> b(cancelled) -> c(cancelled) -> d(draft)
  const edges = [dep("a", "b"), dep("b", "c"), dep("c", "d")];
  const tasks = statuses({
    a: "planned",
    b: "cancelled",
    c: "cancelled",
    d: "draft",
  });
  expect(effectiveDirectPrerequisiteIds("a", edges, tasks)).toEqual(["d"]);
});

test("active middles are walls: nothing beyond them surfaces", () => {
  // a -> b(done) -> c(draft): c is depth 2, not an effective direct prereq.
  const edges = [dep("a", "b"), dep("b", "c")];
  const tasks = statuses({ a: "planned", b: "done", c: "draft" });
  expect(effectiveDirectPrerequisiteIds("a", edges, tasks)).toEqual(["b"]);
});

test("non-depends_on edges and unknown tasks are ignored", () => {
  const edges: TaskGraphEdge[] = [
    {
      id: "rel",
      sourceTaskId: "a",
      targetTaskId: "b",
      edgeType: "relates_to",
    },
    dep("a", "ghost"),
  ];
  const tasks = statuses({ a: "planned", b: "draft" });
  expect(effectiveDirectPrerequisiteIds("a", edges, tasks)).toEqual([]);
});

test("cycles through cancelled tasks terminate and dedupe", () => {
  // a -> b(cancelled) -> a, plus b -> c(draft) reached exactly once.
  const edges = [dep("a", "b"), dep("b", "a"), dep("b", "c"), dep("a", "c")];
  const tasks = statuses({ a: "planned", b: "cancelled", c: "draft" });
  expect(effectiveDirectPrerequisiteIds("a", edges, tasks)).toEqual(["c"]);
});
