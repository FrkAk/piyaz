import type { TaskGraphEdge } from "@/lib/data/views";

/** A task in an effective walk with its minimum effective depth. */
export type EffectiveNeighbor = { id: string; depth: number };

/**
 * Effective `depends_on` neighbors of a task, computed from the slim
 * project graph on the client.
 *
 * Mirrors the recursive-CTE walks in `lib/db/raw/fetch-effective-dep-chain.ts`
 * and `fetch-effective-downstream.ts`: entering a node costs 1 effective hop
 * unless the node is cancelled (cost 0 — cancelled tasks are transparent),
 * a node's depth is the minimum over all paths, expansion stops once a
 * path's depth reaches `maxDepth`, and cancelled tasks never appear in the
 * result. The slim payload carries every task (cancelled included) and
 * every edge, so this walk is exact, not an approximation.
 *
 * @param taskId - UUID of the task to walk from (excluded from the result).
 * @param edges - All slim project edges.
 * @param taskById - Project tasks keyed by id; only `status` is read.
 * @param direction - `"upstream"` walks prerequisites (edge source →
 *   target); `"downstream"` walks dependents (edge target → source).
 * @param maxDepth - Maximum effective hops to include.
 * @returns Non-cancelled neighbors within `maxDepth` effective hops,
 *   ordered by depth ascending (discovery order within a depth).
 */
export function effectiveNeighbors(
  taskId: string,
  edges: readonly TaskGraphEdge[],
  taskById: ReadonlyMap<string, { status: string }>,
  direction: "upstream" | "downstream",
  maxDepth: number,
): EffectiveNeighbor[] {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (e.edgeType !== "depends_on") continue;
    const [from, to] =
      direction === "upstream"
        ? [e.sourceTaskId, e.targetTaskId]
        : [e.targetTaskId, e.sourceTaskId];
    const next = adjacency.get(from);
    if (next) next.push(to);
    else adjacency.set(from, [to]);
  }

  // 0-1 BFS: cancelled nodes cost 0 and go to the deque front, so nodes
  // are settled in nondecreasing depth and each `dist` entry is minimal.
  const dist = new Map<string, number>([[taskId, 0]]);
  const discovered: string[] = [];
  const deque: string[] = [taskId];
  while (deque.length > 0) {
    const id = deque.shift()!;
    const depth = dist.get(id)!;
    if (depth >= maxDepth) continue;
    for (const nextId of adjacency.get(id) ?? []) {
      if (nextId === taskId) continue;
      const info = taskById.get(nextId);
      if (!info) continue;
      const cost = info.status === "cancelled" ? 0 : 1;
      const nextDepth = depth + cost;
      const prev = dist.get(nextId);
      if (prev !== undefined && prev <= nextDepth) continue;
      if (prev === undefined) discovered.push(nextId);
      dist.set(nextId, nextDepth);
      if (cost === 0) deque.unshift(nextId);
      else deque.push(nextId);
    }
  }

  return discovered
    .filter((id) => taskById.get(id)?.status !== "cancelled")
    .map((id) => ({ id, depth: dist.get(id)! }))
    .sort((a, b) => a.depth - b.depth);
}

/**
 * Effective direct (depth 1) prerequisite ids for a task — the walls of the
 * cancelled-transparent walk. Drives the blocked chip/drawer, mirroring the
 * agent builder's depth-1 blocked-notice filter.
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
  return effectiveNeighbors(taskId, edges, taskById, "upstream", 1).map(
    (n) => n.id,
  );
}
