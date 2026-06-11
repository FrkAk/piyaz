import "server-only";

import type { Conn } from "@/lib/db/raw";
import { listTasksForGraph } from "@/lib/data/task";
import { listDependsOnEdges } from "@/lib/data/edge";
import type { Priority } from "@/lib/types";

/** Slim active-task info used by graph analyzers. */
export type ActiveTaskInfo = {
  id: string;
  title: string;
  status: string;
  sequenceNumber: number;
  tags: string[];
  priority: Priority | null;
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
 * This is the exact substrate `buildEffectiveDepGraph` needs, kept here
 * so every analyzer that derives a dependency graph from the project as
 * a whole (`getBlockedTasks`, `getCriticalPath`, `deriveTaskStatesSlim`)
 * draws from identical data.
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
  if (allTasks.length === 0) {
    return buildDepAdjacencyFrom(allTasks, []);
  }
  const dependsOnEdges = await listDependsOnEdges(
    allTasks.map((t) => t.id),
    conn,
  );
  return buildDepAdjacencyFrom(allTasks, dependsOnEdges);
}

/** Slim task row the dependency-adjacency builder consumes. */
type GraphTaskRow = {
  id: string;
  title: string;
  status: string;
  sequenceNumber: number;
  tags: string[];
  priority: string | null;
};

/**
 * Build the dependency-traversal substrate from pre-fetched rows. Pure
 * counterpart of {@link buildDepAdjacency} for callers that already hold
 * the project's tasks and `depends_on` edges (e.g. from one read batch).
 *
 * @param allTasks - Every task in the project, cancelled included.
 * @param dependsOnEdges - Every `depends_on` edge in the project.
 * @returns The adjacency map, the all-tasks status map, and the active-task
 *   info map.
 */
export function buildDepAdjacencyFrom(
  allTasks: readonly GraphTaskRow[],
  dependsOnEdges: readonly { sourceTaskId: string; targetTaskId: string }[],
): {
  adj: Map<string, string[]>;
  taskStatus: Map<string, string>;
  activeTasks: Map<string, ActiveTaskInfo>;
} {
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
        priority: t.priority as Priority | null,
      });
    }
  }

  const adj = new Map<string, string[]>();
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
  const substrate = await buildDepAdjacency(projectId, conn);
  return effectiveGraphFromSubstrate(substrate);
}

/**
 * Build the effective dependency graph from pre-fetched rows. Pure
 * counterpart of {@link buildEffectiveDepGraph} for callers that already
 * hold the project's tasks and `depends_on` edges (e.g. from one read
 * batch). Same cancelled-transparency semantics.
 *
 * @param allTasks - Every task in the project, cancelled included.
 * @param dependsOnEdges - Every `depends_on` edge in the project.
 * @returns The effective dependency graph (active-only nodes, transitive edges).
 */
export function buildEffectiveDepGraphFrom(
  allTasks: Parameters<typeof buildDepAdjacencyFrom>[0],
  dependsOnEdges: Parameters<typeof buildDepAdjacencyFrom>[1],
): EffectiveDepGraph {
  return effectiveGraphFromSubstrate(
    buildDepAdjacencyFrom(allTasks, dependsOnEdges),
  );
}

/**
 * Derive the effective graph from a dependency-traversal substrate.
 *
 * @param substrate - Adjacency, status, and active-task maps.
 * @returns The effective dependency graph.
 */
function effectiveGraphFromSubstrate(substrate: {
  adj: Map<string, string[]>;
  taskStatus: Map<string, string>;
  activeTasks: Map<string, ActiveTaskInfo>;
}): EffectiveDepGraph {
  const { adj, taskStatus, activeTasks } = substrate;

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
