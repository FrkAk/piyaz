import { expect, test } from "bun:test";
import {
  effectiveDirectPrerequisiteIds,
  effectiveNeighbors,
} from "@/lib/ui/effective-prereqs";
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

test("effectiveNeighbors reports effective depth up to maxDepth", () => {
  // a -> b(active) -> c(active): b is depth 1, c is depth 2.
  const edges = [dep("a", "b"), dep("b", "c")];
  const tasks = statuses({ a: "planned", b: "draft", c: "draft" });
  expect(effectiveNeighbors("a", edges, tasks, "upstream", 2)).toEqual([
    { id: "b", depth: 1 },
    { id: "c", depth: 2 },
  ]);
  // maxDepth 1 prunes c.
  expect(effectiveNeighbors("a", edges, tasks, "upstream", 1)).toEqual([
    { id: "b", depth: 1 },
  ]);
});

test("effectiveNeighbors downstream walks dependents", () => {
  // c depends_on b depends_on a: from a, both depend on it (b at 1, c at 2).
  const edges = [dep("b", "a"), dep("c", "b")];
  const tasks = statuses({ a: "done", b: "planned", c: "planned" });
  expect(effectiveNeighbors("a", edges, tasks, "downstream", 2)).toEqual([
    { id: "b", depth: 1 },
    { id: "c", depth: 2 },
  ]);
});

test("effectiveNeighbors keeps minimum depth across multiple paths", () => {
  // a -> b -> d and a -> c(cancelled) -> d: d is depth 1 via the cancelled
  // path, depth 2 via b. The minimum (1) wins.
  const edges = [dep("a", "b"), dep("b", "d"), dep("a", "c"), dep("c", "d")];
  const tasks = statuses({
    a: "planned",
    b: "draft",
    c: "cancelled",
    d: "draft",
  });
  const result = effectiveNeighbors("a", edges, tasks, "upstream", 2);
  expect(result.find((n) => n.id === "d")?.depth).toBe(1);
});
