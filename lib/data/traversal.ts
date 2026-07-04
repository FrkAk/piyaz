import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { type Conn } from "@/lib/db/raw";
import { withUserContext, withUserContextRead, type Tx } from "@/lib/db/rls";
import { tasks, projects, taskEdges } from "@/lib/db/schema";
import { fetchEffectiveDownstream } from "@/lib/db/raw/fetch-effective-downstream";
import { asIdentifier, composeTaskRef } from "@/lib/graph/identifier";
import {
  buildEffectiveDepGraph,
  type ActiveTaskInfo,
} from "@/lib/graph/effective-deps";
import { hasCriteriaExpr, deriveTaskStatesSlim } from "@/lib/data/task";
import {
  getTaskEdgesDetailed,
  taskEdgesForManyStmt,
  connectedTaskInfoStmt,
} from "@/lib/data/edge";
import type { AuthContext } from "@/lib/auth/context";
import type { EdgeType, Priority } from "@/lib/types";
import {
  assertProjectAccessTx,
  assertTaskAccessTx,
} from "@/lib/auth/authorization";

// ---------------------------------------------------------------------------
// Priority weighting for the critical-path DP
// ---------------------------------------------------------------------------

/**
 * Doubling ladder so a single `urgent` node (8) dominates a chain of three
 * `normal` nodes (6); a 2-chain of two `urgent` (16) outranks a 3-chain of
 * three `backlog` (3). See MYMR-208.
 */
const PRIORITY_WEIGHTS = {
  urgent: 8,
  core: 4,
  normal: 2,
  backlog: 1,
} as const satisfies Record<Priority, number>;

const DEFAULT_PRIORITY_WEIGHT = PRIORITY_WEIGHTS.normal;

/**
 * Lookup the DP weight for a task's priority. Null or any string outside the
 * recognized alphabet falls back to the `normal` weight (2) so the DP never
 * sees `undefined`/`NaN`.
 */
function priorityWeight(p: ActiveTaskInfo["priority"]): number {
  if (p === null) return DEFAULT_PRIORITY_WEIGHT;
  return PRIORITY_WEIGHTS[p] ?? DEFAULT_PRIORITY_WEIGHT;
}

// ---------------------------------------------------------------------------
// Connected tasks — internal helper (1-hop neighbors)
// ---------------------------------------------------------------------------

/** A 1-hop neighbor connected via an edge. */
type ConnectedTask = {
  id: string;
  edgeType: string;
  direction: "outgoing" | "incoming";
};

/**
 * Fetch all tasks connected by exactly one edge hop. Internal helper.
 * @param taskId - UUID of the task.
 * @param conn - RLS-scoped {@link Conn} from an active `withUserContext` frame.
 * @returns Array of connected tasks with edge info.
 */
export async function getConnectedTasks(
  taskId: string,
  conn: Conn,
): Promise<ConnectedTask[]> {
  const outgoing = await conn
    .select({
      id: taskEdges.targetTaskId,
      edgeType: taskEdges.edgeType,
    })
    .from(taskEdges)
    .where(eq(taskEdges.sourceTaskId, taskId));

  const incoming = await conn
    .select({
      id: taskEdges.sourceTaskId,
      edgeType: taskEdges.edgeType,
    })
    .from(taskEdges)
    .where(eq(taskEdges.targetTaskId, taskId));

  return [
    ...outgoing.map((e) => ({
      id: e.id,
      edgeType: e.edgeType as string,
      direction: "outgoing" as const,
    })),
    ...incoming.map((e) => ({
      id: e.id,
      edgeType: e.edgeType as string,
      direction: "incoming" as const,
    })),
  ];
}

// ---------------------------------------------------------------------------
// Downstream (reverse dependency chain)
// ---------------------------------------------------------------------------

/** A task in a downstream chain with depth. */
export type DownstreamNode = {
  id: string;
  taskRef: string;
  title: string;
  depth: number;
};

/**
 * Find tasks that depend on this task.
 *
 * Defense-in-depth: walks only edges whose source task lives in the same
 * project as the starting task, so a stale or hand-crafted cross-project
 * edge cannot pull dependents from another team into the result.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the starting task.
 * @param maxDepth - Maximum traversal depth (default 10).
 * @returns Array of downstream tasks with depth.
 */
export async function getDownstream(
  ctx: AuthContext,
  taskId: string,
  maxDepth = 10,
): Promise<DownstreamNode[]> {
  return withUserContext(ctx.userId, (tx) =>
    getDownstreamTx(tx, taskId, maxDepth),
  );
}

/**
 * {@link getDownstream} on a caller-supplied tx.
 *
 * @param tx - Active RLS transaction handle.
 * @param taskId - UUID of the starting task.
 * @param maxDepth - Maximum traversal depth (default 10).
 * @returns Array of downstream tasks with depth.
 */
export async function getDownstreamTx(
  tx: Tx,
  taskId: string,
  maxDepth = 10,
): Promise<DownstreamNode[]> {
  const rootTask = await assertTaskAccessTx(tx, taskId);
  const projectId = rootTask.projectId;

  const raw = await fetchEffectiveDownstream(tx, taskId, projectId, maxDepth);
  if (raw.length === 0) return [];

  const ids = raw.map((r) => r.id);
  const taskRows = await tx
    .select({
      id: tasks.id,
      title: tasks.title,
      sequenceNumber: tasks.sequenceNumber,
      identifier: projects.identifier,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(sql`${tasks.id} IN ${ids} AND ${tasks.projectId} = ${projectId}`);

  const infoMap = new Map<string, { taskRef: string; title: string }>();
  for (const t of taskRows) {
    infoMap.set(t.id, {
      taskRef: composeTaskRef(asIdentifier(t.identifier), t.sequenceNumber),
      title: t.title,
    });
  }

  return raw.map((r) => {
    const info = infoMap.get(r.id);
    return {
      id: r.id,
      taskRef: info?.taskRef ?? "",
      title: info?.title ?? "",
      depth: r.depth,
    };
  });
}

// ---------------------------------------------------------------------------
// Ready tasks
// ---------------------------------------------------------------------------

/** A task that is ready to be worked on. */
export type ReadyTask = {
  id: string;
  taskRef: string;
  title: string;
  status: string;
  tags: string[];
};

/**
 * Find all tasks whose dependencies are fully satisfied.
 *
 * A task is ready when its status is "planned" and every effective dep is
 * `done`. Cancelled tasks are transparent — they don't satisfy a dep on their
 * own, but the walk continues through them to find the next active
 * prerequisite (which is the actual wall).
 *
 * Delegates the derivation to `deriveTaskStatesSlim` so this analyzer agrees
 * with search-result `state`, `getPlannableTasks`, `piyaz_map
 * type='blocked'`, and the slim payload's `task.state`. Single source of
 * truth — no parallel implementations to drift.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns Array of ready tasks (state === 'ready' from deriveTaskStatesSlim).
 */
export async function getReadyTasks(
  ctx: AuthContext,
  projectId: string,
): Promise<ReadyTask[]> {
  return withUserContext(ctx.userId, async (tx) => {
    const { project } = await assertProjectAccessTx(tx, projectId);
    const identifier = asIdentifier(project.identifier);

    // Pre-filter to `status = 'planned'` at SQL: `ready` requires it, so
    // every other status row would be discarded by the JS filter below.
    const allTasks = await tx
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        tags: tasks.tags,
        hasDescription: sql<boolean>`length(btrim(${tasks.description})) > 0`,
        hasCriteria: hasCriteriaExpr(),
        sequenceNumber: tasks.sequenceNumber,
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.status, "planned")));

    if (allTasks.length === 0) return [];

    const stateMap = await deriveTaskStatesSlim(
      projectId,
      allTasks.map((t) => ({
        id: t.id,
        status: t.status,
        hasDescription: t.hasDescription,
        hasCriteria: t.hasCriteria,
      })),
      tx,
    );

    return allTasks
      .filter((task) => stateMap.get(task.id) === "ready")
      .map((task) => ({
        id: task.id,
        taskRef: composeTaskRef(identifier, task.sequenceNumber),
        title: task.title,
        status: task.status,
        tags: task.tags,
      }));
  });
}

// ---------------------------------------------------------------------------
// Plannable tasks
// ---------------------------------------------------------------------------

/** A draft task with enough content to be planned. */
export type PlannableTask = {
  id: string;
  taskRef: string;
  title: string;
  status: string;
  tags: string[];
};

/**
 * Find draft tasks that are plannable now: have a description, at least one
 * acceptance criterion, AND every effective dep is done. Delegates the
 * readiness logic to `deriveTaskStatesSlim` so this analyzer agrees with
 * search-result `state` and `piyaz_map view='blocked'`.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns Array of plannable tasks (state === 'plannable' from deriveTaskStatesSlim).
 */
export async function getPlannableTasks(
  ctx: AuthContext,
  projectId: string,
): Promise<PlannableTask[]> {
  return withUserContext(ctx.userId, async (tx) => {
    const { project } = await assertProjectAccessTx(tx, projectId);
    const identifier = asIdentifier(project.identifier);

    // Pre-filter to `status = 'draft' AND hasDescription AND hasCriteria`
    // at SQL: those three are necessary conditions for `plannable`, and
    // every other row would be discarded by the JS filter below. The dep
    // readiness check stays in JS via `deriveTaskStatesSlim`.
    const allTasks = await tx
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        tags: tasks.tags,
        hasDescription: sql<boolean>`length(btrim(${tasks.description})) > 0`,
        hasCriteria: hasCriteriaExpr(),
        sequenceNumber: tasks.sequenceNumber,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, projectId),
          eq(tasks.status, "draft"),
          sql`length(btrim(${tasks.description})) > 0`,
          hasCriteriaExpr(),
        ),
      );

    if (allTasks.length === 0) return [];

    const stateMap = await deriveTaskStatesSlim(
      projectId,
      allTasks.map((t) => ({
        id: t.id,
        status: t.status,
        hasDescription: t.hasDescription,
        hasCriteria: t.hasCriteria,
      })),
      tx,
    );

    return allTasks
      .filter((task) => stateMap.get(task.id) === "plannable")
      .map((task) => ({
        id: task.id,
        taskRef: composeTaskRef(identifier, task.sequenceNumber),
        title: task.title,
        status: task.status,
        tags: task.tags,
      }));
  });
}

// ---------------------------------------------------------------------------
// Blocked tasks
// ---------------------------------------------------------------------------

/** A task blocked by unsatisfied dependencies. */
export type BlockedTask = {
  id: string;
  taskRef: string;
  title: string;
  status: string;
  blockedBy: {
    id: string;
    taskRef: string;
    title: string;
    status: string;
  }[];
};

/**
 * Find all active tasks with at least one effective dependency that is not done.
 *
 * Blockers are reported at the *effective* level: if A depends on B and B is
 * cancelled with an unsatisfied dep C, A is reported as blocked by C (not B).
 * Cancelled tasks are transparent — they never appear as blockers and are
 * never themselves listed as blocked.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns Array of blocked tasks with their effective blockers.
 */
export async function getBlockedTasks(
  ctx: AuthContext,
  projectId: string,
): Promise<BlockedTask[]> {
  return withUserContext(ctx.userId, async (tx) => {
    const { project } = await assertProjectAccessTx(tx, projectId);
    const identifier = asIdentifier(project.identifier);

    const graph = await buildEffectiveDepGraph(projectId, tx);
    const blocked: BlockedTask[] = [];

    for (const info of graph.activeTasks.values()) {
      const deps = graph.effectiveDeps.get(info.id) ?? new Set<string>();
      const blockers: {
        id: string;
        taskRef: string;
        title: string;
        status: string;
      }[] = [];
      for (const depId of deps) {
        const depInfo = graph.activeTasks.get(depId);
        if (!depInfo) continue;
        if (depInfo.status === "done") continue;
        blockers.push({
          id: depInfo.id,
          taskRef: composeTaskRef(identifier, depInfo.sequenceNumber),
          title: depInfo.title,
          status: depInfo.status,
        });
      }
      if (blockers.length === 0) continue;
      blocked.push({
        id: info.id,
        taskRef: composeTaskRef(identifier, info.sequenceNumber),
        title: info.title,
        status: info.status,
        blockedBy: blockers,
      });
    }

    return blocked;
  });
}

// ---------------------------------------------------------------------------
// Critical path
// ---------------------------------------------------------------------------

/** A task in the critical path. */
export type CriticalPathTask = {
  id: string;
  taskRef: string;
  title: string;
  status: string;
};

/**
 * Find the most important remaining chain of effective `depends_on` edges
 * across active, non-done tasks.
 *
 * Operates on the effective dependency graph: cancelled tasks are transparent
 * (passed through inside the shared graph substrate) and done tasks are
 * locally transparent here (filtered out of the DP node set), so a chain
 * `A(done) → B(planned) → C(draft)` reports as `B → C`. Each DP node
 * contributes weight by its `priority` (urgent=8, core=4, normal=2,
 * backlog=1; null or unrecognized → 2) so a chain's score reflects priority
 * mass, not raw length. A single `urgent` task (8) outranks a chain of three
 * `normal` tasks (6); a 2-chain of two `urgent` tasks (16) outranks a
 * 3-chain of three `backlog` tasks (3).
 *
 * Algorithm: Kahn's topological sort over not-done active tasks (deps first)
 * followed by DP `longest[node] = max(longest[dep]) + priorityWeight(node)`,
 * then backtrack from the highest-`longest` node to recover the chain in
 * root-first order. Returns empty when no not-done active tasks exist or a
 * cycle is detected.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns Ordered array of active, not-done tasks forming the highest-weight
 *   effective chain (foundational task first, topmost dependent last). Empty
 *   when no not-done active tasks exist or a cycle is detected.
 */
export async function getCriticalPath(
  ctx: AuthContext,
  projectId: string,
): Promise<CriticalPathTask[]> {
  return withUserContext(ctx.userId, async (tx) => {
    const { project } = await assertProjectAccessTx(tx, projectId);
    const identifier = asIdentifier(project.identifier);

    const graph = await buildEffectiveDepGraph(projectId, tx);
    if (graph.activeTasks.size === 0) return [];

    // Done-transparency, scoped locally: build a DP node set that excludes
    // done tasks, then rebuild deps/dependents adjacency over that set. The
    // shared graph substrate keeps done tasks (other analyzers depend on
    // them); the filter happens here only.
    const dpNodes = new Map<string, ActiveTaskInfo>();
    for (const info of graph.activeTasks.values()) {
      if (info.status === "done") continue;
      dpNodes.set(info.id, info);
    }
    if (dpNodes.size === 0) return [];

    const dpDeps = new Map<string, Set<string>>();
    for (const id of dpNodes.keys()) {
      const fullDeps = graph.effectiveDeps.get(id) ?? new Set<string>();
      const filtered = new Set<string>();
      for (const dep of fullDeps) {
        if (dpNodes.has(dep)) filtered.add(dep);
      }
      dpDeps.set(id, filtered);
    }

    const dpDependents = new Map<string, Set<string>>();
    for (const [src, deps] of dpDeps) {
      for (const dep of deps) {
        const set = dpDependents.get(dep) ?? new Set<string>();
        set.add(src);
        dpDependents.set(dep, set);
      }
    }

    const remaining = new Map<string, number>();
    for (const id of dpNodes.keys()) {
      remaining.set(id, dpDeps.get(id)?.size ?? 0);
    }

    const topoOrder: string[] = [];
    const queue: string[] = [];
    for (const [id, count] of remaining) {
      if (count === 0) queue.push(id);
    }
    while (queue.length > 0) {
      const cur = queue.shift()!;
      topoOrder.push(cur);
      const dependents = dpDependents.get(cur) ?? new Set<string>();
      for (const dependent of dependents) {
        const newCount = (remaining.get(dependent) ?? 0) - 1;
        remaining.set(dependent, newCount);
        if (newCount === 0) queue.push(dependent);
      }
    }

    if (topoOrder.length < dpNodes.size) return [];

    const longestTo = new Map<string, number>();
    const parent = new Map<string, string | null>();
    for (const node of topoOrder) {
      const deps = dpDeps.get(node) ?? new Set<string>();
      let bestParent: string | null = null;
      let bestParentLen = 0;
      for (const dep of deps) {
        const len = longestTo.get(dep) ?? 0;
        if (len > bestParentLen) {
          bestParentLen = len;
          bestParent = dep;
        } else if (len === bestParentLen && len > 0 && bestParent !== null) {
          // Deterministic tie-break: lower sequenceNumber wins. Sequence
          // numbers are unique per project and immutable, so the comparison
          // is total and survives any future change to dpNodes iteration
          // order (MYMR-210).
          const depSeq = dpNodes.get(dep)!.sequenceNumber;
          const bestSeq = dpNodes.get(bestParent)!.sequenceNumber;
          if (depSeq < bestSeq) {
            bestParent = dep;
          }
        }
      }
      const info = dpNodes.get(node)!;
      longestTo.set(node, bestParentLen + priorityWeight(info.priority));
      parent.set(node, bestParent);
    }

    let endNode: string | null = null;
    let maxLen = 0;
    for (const [node, len] of longestTo) {
      if (len > maxLen) {
        maxLen = len;
        endNode = node;
      } else if (len === maxLen && endNode !== null) {
        // Same tie-break as the bestParent loop: lower sequenceNumber wins
        // when two chains share the longest weighted length (MYMR-210).
        const nodeSeq = dpNodes.get(node)!.sequenceNumber;
        const endSeq = dpNodes.get(endNode)!.sequenceNumber;
        if (nodeSeq < endSeq) {
          endNode = node;
        }
      }
    }
    if (!endNode) return [];

    const chain: string[] = [];
    let cur: string | null = endNode;
    while (cur !== null) {
      chain.push(cur);
      cur = parent.get(cur) ?? null;
    }
    chain.reverse();

    return chain.map((id) => {
      const info = dpNodes.get(id)!;
      return {
        id: info.id,
        taskRef: composeTaskRef(identifier, info.sequenceNumber),
        title: info.title,
        status: info.status,
      };
    });
  });
}

// ---------------------------------------------------------------------------
// Neighbors (1- and 2-hop edge walk)
// ---------------------------------------------------------------------------

/** A neighbor reached by a 1- or 2-hop edge walk from an origin task. */
export type Neighbor = {
  /** Hop distance from the origin (1 or 2). */
  hop: 1 | 2;
  /** Edge orientation relative to the anchor of its hop. */
  direction: "outgoing" | "incoming";
  /** Relationship type of the connecting edge. */
  edgeType: EdgeType;
  /** Edge note (empty string when unset). */
  note: string;
  /** Composed taskRef of the neighbor, e.g. `MYMR-83`. */
  taskRef: string;
  /** Neighbor title. */
  title: string;
  /** Neighbor lifecycle status. */
  status: string;
  /** Neighbor task UUID. */
  id: string;
};

/** A resolved hop-2 edge extending the frontier to a new task. */
type Hop2Extension = {
  newId: string;
  direction: "outgoing" | "incoming";
  edgeType: EdgeType;
  note: string;
};

/**
 * Map the frontier's edges to their hop-2 extensions, first-wins per new task.
 * An edge extends the frontier only when one endpoint is a frontier task and
 * the opposite endpoint is unvisited (not the origin, not a hop-1 task). Edges
 * are processed in id order so a task reachable by several paths (a diamond)
 * resolves to one deterministic row.
 *
 * @param edges - All edges touching the frontier, in any order.
 * @param frontier - Hop-1 task ids (the walk anchors).
 * @param visited - Origin plus hop-1 ids that must never reappear.
 * @returns One extension per distinct new hop-2 task, insertion-ordered.
 */
function resolveHop2Extensions(
  edges: readonly {
    id: string;
    sourceTaskId: string;
    targetTaskId: string;
    edgeType: EdgeType;
    note: string;
  }[],
  frontier: ReadonlySet<string>,
  visited: ReadonlySet<string>,
): Hop2Extension[] {
  const byNewTask = new Map<string, Hop2Extension>();
  const sorted = [...edges].sort((a, b) => a.id.localeCompare(b.id));
  for (const edge of sorted) {
    let extension: Hop2Extension | null = null;
    if (frontier.has(edge.sourceTaskId) && !visited.has(edge.targetTaskId)) {
      extension = {
        newId: edge.targetTaskId,
        direction: "outgoing",
        edgeType: edge.edgeType,
        note: edge.note,
      };
    } else if (
      frontier.has(edge.targetTaskId) &&
      !visited.has(edge.sourceTaskId)
    ) {
      extension = {
        newId: edge.sourceTaskId,
        direction: "incoming",
        edgeType: edge.edgeType,
        note: edge.note,
      };
    }
    if (extension && !byNewTask.has(extension.newId)) {
      byNewTask.set(extension.newId, extension);
    }
  }
  return [...byNewTask.values()];
}

/**
 * Walk the edges around a task to its 1- or 2-hop neighbors, both edge types
 * and both directions. Hop 1 reuses {@link getTaskEdgesDetailed} (which gates
 * origin access and drops RLS-invisible endpoints); hop 2 fans out from the
 * hop-1 frontier in one edge scan plus one connected-task read, deduping so the
 * origin and hop-1 tasks never reappear as hop-2 rows.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the origin task.
 * @param hops - Walk depth, 1 or 2.
 * @returns Neighbor rows, hop-1 first then deduped hop-2.
 * @throws ForbiddenError when the caller cannot access the origin task.
 */
export async function getNeighbors(
  ctx: AuthContext,
  taskId: string,
  hops: 1 | 2,
): Promise<Neighbor[]> {
  const detailed = await getTaskEdgesDetailed(ctx, taskId);
  const hop1: Neighbor[] = detailed.map((e) => ({
    hop: 1,
    direction: e.direction,
    edgeType: e.edgeType,
    note: e.note,
    taskRef: e.connectedTask.taskRef,
    title: e.connectedTask.title,
    status: e.connectedTask.status,
    id: e.connectedTask.id,
  }));
  if (hops === 1) return hop1;

  const frontier = [...new Set(hop1.map((n) => n.id))];
  if (frontier.length === 0) return hop1;
  const frontierSet = new Set(frontier);
  const visited = new Set<string>([taskId, ...frontier]);

  const [edgeRows] = await withUserContextRead(ctx.userId, (read) => [
    taskEdgesForManyStmt(read, frontier),
  ]);
  const extensions = resolveHop2Extensions(edgeRows, frontierSet, visited);
  if (extensions.length === 0) return hop1;

  const [taskRows] = await withUserContextRead(ctx.userId, (read) => [
    connectedTaskInfoStmt(
      read,
      extensions.map((e) => e.newId),
    ),
  ]);
  const infoMap = new Map(
    taskRows.map((t) => [
      t.id,
      {
        taskRef: composeTaskRef(asIdentifier(t.identifier), t.sequenceNumber),
        title: t.title,
        status: t.status,
      },
    ]),
  );

  const hop2: Neighbor[] = [];
  for (const ext of extensions) {
    const info = infoMap.get(ext.newId);
    if (!info) continue;
    hop2.push({
      hop: 2,
      direction: ext.direction,
      edgeType: ext.edgeType,
      note: ext.note,
      taskRef: info.taskRef,
      title: info.title,
      status: info.status,
      id: ext.newId,
    });
  }
  return [...hop1, ...hop2];
}
