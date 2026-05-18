import "server-only";

import type { Conn } from "@/lib/db/raw";
import { listTasksForGraph } from "@/lib/data/task";
import { listDependsOnEdges } from "@/lib/data/edge";

/** Slim active-task info used by graph analyzers. */
export type ActiveTaskInfo = {
  id: string;
  title: string;
  status: string;
  sequenceNumber: number;
  tags: string[];
};

/**
 * The effective dependency graph for a project.
 *
 * Cancelled tasks are *transparent*: passable for graph traversal but never
 * appear as nodes in this graph and never count toward dependency satisfaction.
 * An active task X effectively depends on an active task Y when there exists a
 * `depends_on` path X → m₁ → m₂ → … → Y where every intermediate `mᵢ` is
 * cancelled (zero or more cancelled middles). Y is the wall that terminates
 * the walk; cancelled middles are passed through.
 */
export type EffectiveDepGraph = {
  /** All non-cancelled tasks in the project, indexed by id. */
  activeTasks: Map<string, ActiveTaskInfo>;
  /** active-task-id → set of active-task-ids it effectively depends on. */
  effectiveDeps: Map<string, Set<string>>;
  /** active-task-id → set of active-task-ids that effectively depend on it. */
  effectiveDependents: Map<string, Set<string>>;
};

/**
 * Load the raw dependency-traversal substrate for a project: the
 * `depends_on` adjacency map, the full task-id → status map (all tasks,
 * cancelled included so the walks can pass through them), and the
 * active-only task info map (cancelled excluded).
 *
 * This is the exact substrate `buildEffectiveDepGraph` needs and the
 * depth-bounded bundle walks (`walkEffectiveDepsBounded`) also need, kept
 * as one source of truth so the analyze tools and the context bundles
 * derive their dependency graphs from identical data.
 *
 * @param projectId - UUID of the project.
 * @param conn - Drizzle client or transaction handle. Callers running under
 *   a `withUserContext` transaction must pass the active `tx` so the reads
 *   participate in the same RLS-scoped frame.
 * @returns The adjacency map, the all-tasks status map, and the active-task
 *   info map.
 */
export async function buildDepAdjacency(
  projectId: string,
  conn: Conn,
): Promise<{
  adj: Map<string, string[]>;
  taskStatus: Map<string, string>;
  activeTasks: Map<string, ActiveTaskInfo>;
}> {
  const allTasks = await listTasksForGraph(projectId, conn);

  const activeTasks = new Map<string, ActiveTaskInfo>();
  const taskStatus = new Map<string, string>();
  for (const t of allTasks) {
    taskStatus.set(t.id, t.status);
    if (t.status !== "cancelled") {
      activeTasks.set(t.id, {
        id: t.id,
        title: t.title,
        status: t.status,
        sequenceNumber: t.sequenceNumber,
        tags: t.tags,
      });
    }
  }

  const adj = new Map<string, string[]>();
  if (allTasks.length === 0) {
    return { adj, taskStatus, activeTasks };
  }

  const taskIds = allTasks.map((t) => t.id);
  const dependsOnEdges = await listDependsOnEdges(taskIds, conn);

  for (const e of dependsOnEdges) {
    const list = adj.get(e.sourceTaskId) ?? [];
    list.push(e.targetTaskId);
    adj.set(e.sourceTaskId, list);
  }

  return { adj, taskStatus, activeTasks };
}

/**
 * Build the effective dependency graph for a project.
 *
 * Treats cancelled tasks as transparent: walks through them to find the
 * nearest active prerequisite, but excludes them from the result graph.
 * Used by getBlockedTasks, getCriticalPath, and deriveTaskStatesSlim (which
 * in turn backs getReadyTasks and getPlannableTasks) so they all share
 * consistent transitive-aware semantics.
 *
 * @param projectId - UUID of the project.
 * @param conn - Drizzle client or transaction handle. Callers running under a
 *   `withUserContext` transaction must pass the active `tx` so the underlying
 *   reads participate in the same RLS-scoped frame; standalone callers pass
 *   the bare `db` pool client (data-layer scope only — boundary enforced by
 *   the lint rule on this directory).
 * @returns The effective dependency graph (active-only nodes, transitive edges).
 */
export async function buildEffectiveDepGraph(
  projectId: string,
  conn: Conn,
): Promise<EffectiveDepGraph> {
  const { adj, taskStatus, activeTasks } = await buildDepAdjacency(
    projectId,
    conn,
  );

  if (taskStatus.size === 0) {
    return {
      activeTasks,
      effectiveDeps: new Map(),
      effectiveDependents: new Map(),
    };
  }

  const effectiveDeps = new Map<string, Set<string>>();
  for (const activeId of activeTasks.keys()) {
    effectiveDeps.set(activeId, walkEffectiveDeps(activeId, adj, taskStatus));
  }

  const effectiveDependents = new Map<string, Set<string>>();
  for (const [src, deps] of effectiveDeps) {
    for (const dep of deps) {
      const set = effectiveDependents.get(dep) ?? new Set<string>();
      set.add(src);
      effectiveDependents.set(dep, set);
    }
  }

  return { activeTasks, effectiveDeps, effectiveDependents };
}

/**
 * Walk forward from an active source, treating cancelled tasks as transparent.
 *
 * Cancelled targets are pushed onto the stack (recurse through them); active
 * targets are added to the result and the walk does NOT recurse into them
 * (they are the walls that terminate transitive search).
 *
 * @param source - Starting active task id.
 * @param adj - Source → targets adjacency map for depends_on edges.
 * @param taskStatus - Task id → status map for all project tasks.
 * @returns Set of active task ids reachable through any number of cancelled middles.
 */
function walkEffectiveDeps(
  source: string,
  adj: Map<string, string[]>,
  taskStatus: Map<string, string>,
): Set<string> {
  const result = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [source];

  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (visited.has(cur)) continue;
    visited.add(cur);

    const targets = adj.get(cur) ?? [];
    for (const target of targets) {
      if (visited.has(target)) continue;
      const status = taskStatus.get(target);
      if (status === "cancelled") {
        stack.push(target);
      } else if (status !== undefined) {
        result.add(target);
      }
    }
  }

  return result;
}

/**
 * Walk forward from an active source over the effective dependency graph,
 * stopping at maxDepth active "walls". Cancelled tasks are transparent and
 * depth-free: the walk passes through them without consuming a depth slot,
 * so A -> B(cancelled) -> C(active) yields C at effective depth 1.
 *
 * BFS by effective depth: the first time an active task is seen is at its
 * minimum effective depth, matching the shallowest-depth behaviour of the
 * old recursive CTE. The cancelled-frontier is drained at the current
 * active depth before BFS advances, so a chain of any number of cancelled
 * middles stays depth-free.
 *
 * @param source - Starting active task id (not included in the result).
 * @param adj - source -> targets adjacency map for depends_on edges.
 * @param taskStatus - task id -> status map for ALL project tasks.
 * @param maxDepth - Maximum number of active hops to include (e.g. 2).
 * @returns Map of active-task-id -> effective depth (1..maxDepth).
 */
export function walkEffectiveDepsBounded(
  source: string,
  adj: Map<string, string[]>,
  taskStatus: Map<string, string>,
  maxDepth: number,
): Map<string, number> {
  const result = new Map<string, number>();
  // Seed `visited` with `source` so a cycle back to it never records the
  // source itself (the result is the set of deps, source-exclusive).
  const visited = new Set<string>([source]);
  const visitedCancelled = new Set<string>();
  let queue: { id: string; depth: number }[] = [{ id: source, depth: 0 }];

  while (queue.length > 0) {
    const next: { id: string; depth: number }[] = [];

    for (const node of queue) {
      // Drain the cancelled frontier at this active depth before advancing,
      // so passing through cancelled middles never consumes a depth slot.
      const cancelledFrontier: string[] = [node.id];
      while (cancelledFrontier.length > 0) {
        const cur = cancelledFrontier.pop()!;
        for (const target of adj.get(cur) ?? []) {
          const status = taskStatus.get(target);
          if (status === undefined) continue;
          if (status === "cancelled") {
            if (visitedCancelled.has(target)) continue;
            visitedCancelled.add(target);
            cancelledFrontier.push(target);
            continue;
          }
          // Active wall at active depth node.depth + 1.
          const wallDepth = node.depth + 1;
          if (wallDepth > maxDepth) continue;
          if (visited.has(target)) continue;
          visited.add(target);
          result.set(target, wallDepth);
          next.push({ id: target, depth: wallDepth });
        }
      }
    }

    queue = next;
  }

  return result;
}
