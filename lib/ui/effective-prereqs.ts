import type { TaskGraphEdge } from "@/lib/data/views";

/**
 * Effective direct (depth 1) prerequisite ids for a task, computed from the
 * slim project graph on the client.
 *
 * Mirrors the wall semantics of `lib/graph/effective-deps.ts`: cancelled
 * tasks are transparent — a `depends_on` path through zero or more cancelled
 * middles terminates at the first non-cancelled task, which is the effective
 * prerequisite. The slim payload carries every task (cancelled included) and
 * every edge, so this walk is exact, not an approximation.
 *
 * @param taskId - UUID of the task whose prerequisites to walk.
 * @param edges - All slim project edges.
 * @param taskById - Project tasks keyed by id; only `status` is read.
 * @returns Deduplicated effective direct prerequisite ids, in walk order.
 */
export function effectiveDirectPrerequisiteIds(
  taskId: string,
  edges: readonly TaskGraphEdge[],
  taskById: ReadonlyMap<string, { status: string }>,
): string[] {
  const dependsOn = new Map<string, string[]>();
  for (const e of edges) {
    if (e.edgeType !== "depends_on") continue;
    const targets = dependsOn.get(e.sourceTaskId);
    if (targets) targets.push(e.targetTaskId);
    else dependsOn.set(e.sourceTaskId, [e.targetTaskId]);
  }

  const walls: string[] = [];
  const collected = new Set<string>();
  const visited = new Set<string>([taskId]);
  const frontier = [...(dependsOn.get(taskId) ?? [])];
  while (frontier.length > 0) {
    const id = frontier.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const info = taskById.get(id);
    if (!info) continue;
    if (info.status === "cancelled") {
      frontier.push(...(dependsOn.get(id) ?? []));
      continue;
    }
    if (!collected.has(id)) {
      collected.add(id);
      walls.push(id);
    }
  }
  return walls;
}
