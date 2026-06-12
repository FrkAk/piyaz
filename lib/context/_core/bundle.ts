import "server-only";

import { loadBundleDeps } from "@/lib/graph/effective-deps";
import {
  fetchCancelledDepRecords,
  fetchDependencyTasks,
  fetchEdgeNotesBySource,
  fetchEdgeNotesByTarget,
  fetchTaskSummaries,
  getTaskForDepthTx,
  type DependencyTaskInfo,
} from "@/lib/data/task";
import { getProjectHeader, type ProjectHeader } from "@/lib/data/project";
import { getAncestors } from "@/lib/data/traversal";
import { getTaskEdgesDetailedTx, type DetailedEdge } from "@/lib/data/edge";
import type { TaskFull } from "@/lib/data/views";
import type { TaskFetchDepth } from "@/lib/db/raw/fetch-task-full";
import type { Tx } from "@/lib/db/rls";

/** Downstream-task summary projection shared by the agent + planning cores. */
type DownstreamSummary = {
  id: string;
  taskRef: string;
  title: string;
  status: string;
  description: string;
};

/** Ancestor node surfaced by the working core. */
type Ancestor = { id: string; type: "project"; title: string };

/**
 * The shared 2-hop effective dependency closure and every secondary lookup
 * keyed off it. Read by both the agent and planning cores.
 */
export type DependencyClosureData = {
  /** Full task row. */
  task: TaskFull;
  /** Active prerequisites within 2 effective hops, with effective depth. */
  deps: { id: string; depth: number }[];
  /** Active dependents within 2 effective hops, with effective depth. */
  downstream: { id: string; depth: number }[];
  /** Outgoing depends_on edge notes, keyed by prerequisite id. */
  upstreamEdgeNotes: Map<string, string>;
  /** Dependency-task summaries (taskRef, title, status, executionRecord). */
  depTasks: DependencyTaskInfo[];
  /** Incoming depends_on edge notes, keyed by dependent id. */
  downstreamEdgeNotes: Map<string, string>;
  /** Downstream-task summaries (taskRef, title, status, description). */
  downstreamSummaries: DownstreamSummary[];
};

/** Exactly what {@link buildAgentContextFrom} reads. */
export type AgentContextData = DependencyClosureData;

/** Exactly what {@link buildPlanningContextFrom} reads. */
export type PlanningContextData = DependencyClosureData & {
  /** Parent project header, or null when the project is unjoinable. */
  project: ProjectHeader | null;
  /** Direct cancelled deps with execution records ("Abandoned Approaches"). */
  abandonedDeps: DependencyTaskInfo[];
};

/** Exactly what {@link buildWorkingContextFrom} reads. */
export type WorkingContextData = {
  /** Full task row. */
  task: TaskFull;
  /** Connected 1-hop edges of every type with connected-task detail. */
  detailedEdges: DetailedEdge[];
  /** Ancestor chain (always the parent project). */
  ancestors: Ancestor[];
};

/**
 * The complete data union the three context cores read. Resolving this once
 * lets the route feed all three pure cores from a single task read and a
 * single dependency traversal. A wider object than any single core needs, so
 * it is structurally assignable to each narrower core parameter.
 */
export type ContextBundle = PlanningContextData & WorkingContextData;

/**
 * Resolve the shared dependency closure for a task in one task read and one
 * dependency/downstream traversal. The secondary closure lookups run in
 * parallel off that shared substrate. `getTaskForDepthTx` asserts access, so
 * callers need no prior gate.
 *
 * `depth` scopes ONLY the main task-row column projection — the agent core
 * fetches at `agent`, the planning core at `planning`. The traversal and every
 * secondary lookup (dep-task execution records, edge notes, downstream
 * summaries) are depth-independent and identical across both cores.
 *
 * @param tx Active RLS transaction handle from a `withUserContext` frame.
 * @param taskId UUID of the task.
 * @param depth Column projection for the main task-row fetch.
 * @returns The resolved closure feeding the agent and planning cores.
 * @throws ForbiddenError When the caller cannot access the task.
 */
export async function resolveDependencyClosure(
  tx: Tx,
  taskId: string,
  depth: TaskFetchDepth,
): Promise<DependencyClosureData> {
  const task = await getTaskForDepthTx(tx, taskId, depth);
  const { projectId } = task;

  const [{ deps, downstream }, upstreamEdgeNotes] = await Promise.all([
    loadBundleDeps(projectId, taskId, 2, tx),
    fetchEdgeNotesBySource(projectId, taskId, tx),
  ]);

  const [depTasks, downstreamEdgeNotes, downstreamSummaries] =
    await resolveClosureSecondaries(tx, projectId, taskId, deps, downstream);

  return {
    task,
    deps,
    downstream,
    upstreamEdgeNotes,
    depTasks,
    downstreamEdgeNotes,
    downstreamSummaries,
  };
}

/**
 * Resolve the dependency closure plus the parent project header, the planning
 * core's full input. One task read and one traversal.
 *
 * @param tx Active RLS transaction handle from a `withUserContext` frame.
 * @param taskId UUID of the task.
 * @returns The closure plus project header.
 * @throws ForbiddenError When the caller cannot access the task.
 */
export async function resolvePlanningData(
  tx: Tx,
  taskId: string,
): Promise<PlanningContextData> {
  const closure = await resolveDependencyClosure(tx, taskId, "planning");
  const [project, abandonedDeps] = await Promise.all([
    getProjectHeader(closure.task.projectId, tx),
    fetchCancelledDepRecords(closure.task.projectId, taskId, tx),
  ]);
  return { ...closure, project, abandonedDeps };
}

/** Exactly what {@link buildReviewContextFrom} reads. */
export type ReviewContextData = DependencyClosureData & {
  /** Parent project header, or null when the project is unjoinable. */
  project: ProjectHeader | null;
};

/**
 * Resolve the dependency closure plus the parent project header at `review`
 * depth, the review core's full input. One task read and one traversal.
 *
 * @param tx Active RLS transaction handle from a `withUserContext` frame.
 * @param taskId UUID of the task.
 * @returns The closure plus project header.
 * @throws ForbiddenError When the caller cannot access the task.
 */
export async function resolveReviewData(
  tx: Tx,
  taskId: string,
): Promise<ReviewContextData> {
  const closure = await resolveDependencyClosure(tx, taskId, "review");
  const project = await getProjectHeader(closure.task.projectId, tx);
  return { ...closure, project };
}

/**
 * Resolve the working core's input: the full task row plus its 1-hop edges and
 * ancestor chain. One task read, no dependency closure.
 *
 * @param tx Active RLS transaction handle from a `withUserContext` frame.
 * @param taskId UUID of the task.
 * @returns The task row, detailed edges, and ancestors.
 * @throws ForbiddenError When the caller cannot access the task.
 */
export async function resolveWorkingData(
  tx: Tx,
  taskId: string,
): Promise<WorkingContextData> {
  const task = await getTaskForDepthTx(tx, taskId, "working");
  const [detailedEdges, ancestors] = await Promise.all([
    getTaskEdgesDetailedTx(tx, taskId),
    getAncestors(taskId, tx),
  ]);
  return { task, detailedEdges, ancestors };
}

/**
 * Resolve the full {@link ContextBundle} for a task in one task read and one
 * dependency traversal, sharing every lookup across the three cores. Used by
 * the route, which feeds all three cores from this single bundle. Fetches at
 * `agent` depth, the column superset of the agent, planning, and working
 * cores, so one read serves all three.
 *
 * @param tx Active RLS transaction handle from a `withUserContext` frame.
 * @param taskId UUID of the task.
 * @returns The resolved bundle feeding all three context cores.
 * @throws ForbiddenError When the caller cannot access the task.
 */
export async function resolveContextBundle(
  tx: Tx,
  taskId: string,
): Promise<ContextBundle> {
  const task = await getTaskForDepthTx(tx, taskId, "agent");
  const { projectId } = task;

  const [
    { deps, downstream },
    upstreamEdgeNotes,
    project,
    detailedEdges,
    ancestors,
    abandonedDeps,
  ] = await Promise.all([
    loadBundleDeps(projectId, taskId, 2, tx),
    fetchEdgeNotesBySource(projectId, taskId, tx),
    getProjectHeader(projectId, tx),
    getTaskEdgesDetailedTx(tx, taskId),
    getAncestors(taskId, tx),
    fetchCancelledDepRecords(projectId, taskId, tx),
  ]);

  const [depTasks, downstreamEdgeNotes, downstreamSummaries] =
    await resolveClosureSecondaries(tx, projectId, taskId, deps, downstream);

  return {
    task,
    deps,
    downstream,
    upstreamEdgeNotes,
    depTasks,
    downstreamEdgeNotes,
    downstreamSummaries,
    project,
    detailedEdges,
    ancestors,
    abandonedDeps,
  };
}

/**
 * Resolve the closure-derived secondary lookups: dependency-task summaries,
 * incoming edge notes, and downstream summaries. Each guards on a non-empty
 * id set so an isolated task issues no superfluous query, matching the
 * per-depth fetch shape the cores assume.
 *
 * @param tx Active RLS transaction handle from a `withUserContext` frame.
 * @param projectId UUID of the project the task belongs to.
 * @param taskId UUID of the task.
 * @param deps Active prerequisite ids from the closure.
 * @param downstream Active dependent ids from the closure.
 * @returns Dep-task summaries, downstream edge notes, and downstream summaries.
 */
async function resolveClosureSecondaries(
  tx: Tx,
  projectId: string,
  taskId: string,
  deps: { id: string }[],
  downstream: { id: string }[],
): Promise<[DependencyTaskInfo[], Map<string, string>, DownstreamSummary[]]> {
  return Promise.all([
    deps.length > 0
      ? fetchDependencyTasks(
          projectId,
          deps.map((d) => d.id),
          tx,
        )
      : Promise.resolve([] as DependencyTaskInfo[]),
    downstream.length > 0
      ? fetchEdgeNotesByTarget(projectId, taskId, tx)
      : Promise.resolve(new Map<string, string>()),
    downstream.length > 0
      ? fetchTaskSummaries(
          projectId,
          downstream.map((d) => d.id),
          tx,
        )
      : Promise.resolve([] as DownstreamSummary[]),
  ]);
}
