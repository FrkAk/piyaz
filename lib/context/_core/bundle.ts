import "server-only";

import {
  dependencyTasksStmt,
  edgeNotesBySourceStmt,
  edgeNotesByTargetStmt,
  mapDependencyTaskRows,
  mapEdgeNoteRows,
  mapTaskSummaryRows,
  requireTaskRow,
  taskSummariesStmt,
  type DependencyTaskInfo,
} from "@/lib/data/task";
import {
  projectHeaderByTaskStmt,
  type ProjectHeader,
} from "@/lib/data/project";
import {
  assembleDetailedEdges,
  connectedTaskIds,
  connectedTaskInfoStmt,
  taskEdgesStmt,
  type DetailedEdge,
} from "@/lib/data/edge";
import { assertValidTaskId } from "@/lib/auth/authorization";
import { withUserContextRead, type ReadConn } from "@/lib/db/rls";
import { normalizeExecuteResult } from "@/lib/db/raw";
import type { ReadResults } from "@/lib/db/read-guard";
import { effectiveDepChainStmt } from "@/lib/db/raw/fetch-effective-dep-chain";
import { effectiveDownstreamStmt } from "@/lib/db/raw/fetch-effective-downstream";
import type {
  TaskFetchDepth,
  TaskFullRawRow,
} from "@/lib/db/raw/fetch-task-full";
import { taskForDepthStmt } from "@/lib/db/raw/fetch-task-full";
import type { TaskFull } from "@/lib/data/views";

/** Effective dependency hops included in the closure. */
const CLOSURE_DEPTH = 2;

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
  /** Active prerequisites within 2 effective hops. */
  deps: { id: string }[];
  /** Active dependents within 2 effective hops. */
  downstream: { id: string }[];
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
 * lets the route feed all three pure cores from a single statement batch and
 * one closure-secondaries batch. A wider object than any single core needs,
 * so it is structurally assignable to each narrower core parameter.
 */
export type ContextBundle = PlanningContextData & WorkingContextData;

/** Header row produced by `projectHeaderByTaskStmt`. */
type HeaderRow = ProjectHeader & { id: string };

/**
 * Build the closure-core batch shared by every closure resolver: the
 * depth-projected task row (whose empty result is the 404 signal — RLS
 * hides rows the caller cannot access), both effective-dependency walks,
 * and the outgoing edge notes. Every statement is keyed on `taskId` alone
 * (project scope derives in SQL), so the whole set rides ONE read batch
 * before the task row has been seen.
 *
 * @param db - Read statement-building handle.
 * @param taskId - UUID of the task.
 * @param depth - Column projection for the task-row fetch.
 * @returns Tuple of four lazy statements.
 */
function closureCoreBatch(db: ReadConn, taskId: string, depth: TaskFetchDepth) {
  return [
    taskForDepthStmt(db, taskId, depth),
    effectiveDepChainStmt(db, taskId, CLOSURE_DEPTH),
    effectiveDownstreamStmt(db, taskId, CLOSURE_DEPTH),
    edgeNotesBySourceStmt(db, taskId),
  ] as const;
}

/**
 * {@link closureCoreBatch} plus the parent-project header, for resolvers
 * that render the header (planning, review, bundle). The agent path runs
 * the core batch alone — it never reads the header.
 *
 * @param db - Read statement-building handle.
 * @param taskId - UUID of the task.
 * @param depth - Column projection for the task-row fetch.
 * @returns Tuple of five lazy statements; header rows are position 4.
 */
function closureBatch(db: ReadConn, taskId: string, depth: TaskFetchDepth) {
  return [
    ...closureCoreBatch(db, taskId, depth),
    projectHeaderByTaskStmt(db, taskId),
  ] as const;
}

/** Positional results of a {@link closureCoreBatch} run. */
type ClosureCoreResults = ReadResults<ReturnType<typeof closureCoreBatch>>;

/** Decoded closure core: task row, dependency walks, outgoing notes. */
type ClosureCore = {
  task: TaskFull;
  deps: { id: string }[];
  downstream: { id: string }[];
  upstreamEdgeNotes: Map<string, string>;
};

/**
 * Decode the closure-core positions of a batch result tuple: map the task
 * row (throwing the 404-shaped ForbiddenError when RLS hides it), normalize
 * the dependency walks, and fold the outgoing edge notes. Accepts any batch
 * that begins with the {@link closureCoreBatch} statements so wider batches
 * (header, edges) decode without rebuilding tuples.
 *
 * @param taskId - UUID of the task the batch targeted.
 * @param results - Batch results whose first four positions are the core.
 * @returns Task, walks, and outgoing notes.
 * @throws ForbiddenError when the task row is not visible to the caller.
 */
function decodeClosureCore(
  taskId: string,
  results: readonly [...ClosureCoreResults, ...unknown[]],
): ClosureCore {
  const [taskRaw, depRaw, downRaw, srcNotes] = results;
  const task = requireTaskRow(
    normalizeExecuteResult<TaskFullRawRow>(taskRaw),
    taskId,
  );
  const deps = normalizeExecuteResult<{ id: string }>(depRaw).map((r) => ({
    id: r.id,
  }));
  const downstream = normalizeExecuteResult<{ id: string }>(downRaw).map(
    (r) => ({ id: r.id }),
  );
  return {
    task,
    deps,
    downstream,
    upstreamEdgeNotes: mapEdgeNoteRows(srcNotes),
  };
}

/**
 * The single skip rule for the closure-secondaries batch: secondaries are
 * only worth a round-trip when either dependency walk returned ids.
 *
 * @param deps - Active prerequisite ids from the closure walk.
 * @param downstream - Active dependent ids from the closure walk.
 * @returns True when a secondaries batch has rows to fetch.
 */
function closureHasSecondaries(
  deps: { id: string }[],
  downstream: { id: string }[],
): boolean {
  return deps.length > 0 || downstream.length > 0;
}

/**
 * Build the closure-secondaries statements: dependency-task summaries,
 * downstream summaries, and incoming edge notes. Single source for
 * {@link resolveClosureSecondaries} and {@link resolveContextBundle} (which
 * appends the connected-task detail to the same batch) so the two
 * consumers cannot drift.
 *
 * @param db - Read statement-building handle.
 * @param projectId - UUID of the task's project (from the closure task row).
 * @param taskId - UUID of the task.
 * @param deps - Active prerequisite ids.
 * @param downstream - Active dependent ids.
 * @returns Tuple of three lazy statements.
 */
function secondariesBatch(
  db: ReadConn,
  projectId: string,
  taskId: string,
  deps: { id: string }[],
  downstream: { id: string }[],
) {
  return [
    dependencyTasksStmt(
      db,
      projectId,
      deps.map((d) => d.id),
    ),
    taskSummariesStmt(
      db,
      projectId,
      downstream.map((d) => d.id),
    ),
    edgeNotesByTargetStmt(db, taskId),
  ] as const;
}

/**
 * Fetch the closure secondaries (dependency-task summaries, downstream
 * summaries, and incoming edge notes) in one read batch, skipped entirely
 * when the closure is empty — the incoming notes are only ever consumed
 * alongside a non-empty downstream walk.
 *
 * @param userId - Authenticated user id.
 * @param projectId - UUID of the task's project (from the closure task row).
 * @param taskId - UUID of the task.
 * @param deps - Active prerequisite ids.
 * @param downstream - Active dependent ids.
 * @returns Dep-task summaries, downstream summaries, and incoming notes.
 */
async function resolveClosureSecondaries(
  userId: string,
  projectId: string,
  taskId: string,
  deps: { id: string }[],
  downstream: { id: string }[],
): Promise<[DependencyTaskInfo[], DownstreamSummary[], Map<string, string>]> {
  if (!closureHasSecondaries(deps, downstream)) {
    return [[], [], new Map()];
  }
  const [depRows, summaryRows, tgtNotes] = await withUserContextRead(
    userId,
    (db) => secondariesBatch(db, projectId, taskId, deps, downstream),
  );
  return [
    mapDependencyTaskRows(depRows),
    mapTaskSummaryRows(summaryRows),
    mapEdgeNoteRows(tgtNotes),
  ];
}

/**
 * Resolve the shared dependency closure for a task in two read batches: one
 * for the task row, dependency walks, and edge notes (no header — the agent
 * core never renders it); one for the closure-keyed secondaries (skipped
 * for isolated tasks). The task row's empty result is the 404 signal,
 * evaluated before any other row is consumed, so callers need no prior
 * check.
 *
 * `depth` scopes ONLY the main task-row column projection — the agent core
 * fetches at `agent`, the planning core at `planning`. Snapshot consistency
 * across the two batches is non-transactional; acceptable for read-only
 * context assembly.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param taskId - UUID of the task.
 * @param depth - Column projection for the main task-row fetch.
 * @returns The resolved closure feeding the agent and planning cores.
 * @throws ForbiddenError When the caller cannot access the task.
 */
export async function resolveDependencyClosure(
  userId: string,
  taskId: string,
  depth: TaskFetchDepth,
): Promise<DependencyClosureData> {
  assertValidTaskId(taskId);
  const results = await withUserContextRead(userId, (db) =>
    closureCoreBatch(db, taskId, depth),
  );
  return finishClosure(userId, taskId, decodeClosureCore(taskId, results));
}

/**
 * Run the closure batch and secondaries, returning the closure plus the
 * parent-project header row. Internal substrate for the header-rendering
 * closure resolvers (planning, review).
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param taskId - UUID of the task.
 * @param depth - Column projection for the main task-row fetch.
 * @returns The closure and the header row (null when unjoinable).
 * @throws ForbiddenError When the caller cannot access the task.
 */
async function resolveClosureWithHeader(
  userId: string,
  taskId: string,
  depth: TaskFetchDepth,
): Promise<{ closure: DependencyClosureData; header: HeaderRow | null }> {
  assertValidTaskId(taskId);
  const results = await withUserContextRead(userId, (db) =>
    closureBatch(db, taskId, depth),
  );
  const closure = await finishClosure(
    userId,
    taskId,
    decodeClosureCore(taskId, results),
  );
  return { closure, header: results[4][0] ?? null };
}

/**
 * Fetch the closure secondaries for a decoded core and assemble the full
 * {@link DependencyClosureData}. Shared tail of the agent and
 * header-rendering closure resolvers.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param taskId - UUID of the task.
 * @param core - Decoded closure-core rows.
 * @returns The resolved closure.
 */
async function finishClosure(
  userId: string,
  taskId: string,
  core: ClosureCore,
): Promise<DependencyClosureData> {
  const [depTasks, downstreamSummaries, downstreamEdgeNotes] =
    await resolveClosureSecondaries(
      userId,
      core.task.projectId,
      taskId,
      core.deps,
      core.downstream,
    );
  return { ...core, depTasks, downstreamEdgeNotes, downstreamSummaries };
}

/**
 * Resolve the dependency closure plus the parent project header, the
 * planning core's full input. Two read batches.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param taskId - UUID of the task.
 * @returns The closure plus project header.
 * @throws ForbiddenError When the caller cannot access the task.
 */
export async function resolvePlanningData(
  userId: string,
  taskId: string,
): Promise<PlanningContextData> {
  const { closure, header } = await resolveClosureWithHeader(
    userId,
    taskId,
    "planning",
  );
  return { ...closure, project: toProjectHeader(header) };
}

/**
 * Resolve a task row at the given depth plus its 1-hop detailed edges and
 * parent-project header. One read batch, plus one for connected-task
 * detail when edges exist. Shared substrate for the working and summary
 * resolvers.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param taskId - UUID of the task.
 * @param depth - Column projection for the task-row fetch.
 * @returns The task row, detailed edges, and header row (null when
 *   unjoinable).
 * @throws ForbiddenError When the caller cannot access the task.
 */
async function resolveTaskEdgesHeader(
  userId: string,
  taskId: string,
  depth: TaskFetchDepth,
): Promise<{
  task: TaskFull;
  detailedEdges: DetailedEdge[];
  header: HeaderRow | null;
}> {
  assertValidTaskId(taskId);
  const [taskRaw, edges, headerRows] = await withUserContextRead(
    userId,
    (db) => [
      taskForDepthStmt(db, taskId, depth),
      taskEdgesStmt(db, taskId),
      projectHeaderByTaskStmt(db, taskId),
    ],
  );
  const task = requireTaskRow(
    normalizeExecuteResult<TaskFullRawRow>(taskRaw),
    taskId,
  );
  const detailedEdges = await resolveDetailedEdges(userId, taskId, edges);
  return { task, detailedEdges, header: headerRows[0] ?? null };
}

/**
 * Resolve the working core's input: the full task row plus its 1-hop edges
 * and ancestor chain. One read batch, plus one for connected-task detail
 * when edges exist.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param taskId - UUID of the task.
 * @returns The task row, detailed edges, and ancestors.
 * @throws ForbiddenError When the caller cannot access the task.
 */
export async function resolveWorkingData(
  userId: string,
  taskId: string,
): Promise<WorkingContextData> {
  const { task, detailedEdges, header } = await resolveTaskEdgesHeader(
    userId,
    taskId,
    "working",
  );
  return { task, detailedEdges, ancestors: toAncestors(header) };
}

/** Exactly what `buildSummaryContext` reads. */
export type SummaryContextData = {
  /** Full task row (summary depth projection). */
  task: TaskFull;
  /** Connected 1-hop edges of every type with connected-task detail. */
  detailedEdges: DetailedEdge[];
  /** Parent project header, or null when the project is unjoinable. */
  project: ProjectHeader | null;
};

/**
 * Resolve the summary core's input: the summary-depth task row plus its
 * 1-hop edges and parent-project header. One read batch, plus one for
 * connected-task detail when edges exist.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param taskId - UUID of the task.
 * @returns The task row, detailed edges, and project header.
 * @throws ForbiddenError When the caller cannot access the task.
 */
export async function resolveSummaryData(
  userId: string,
  taskId: string,
): Promise<SummaryContextData> {
  const { task, detailedEdges, header } = await resolveTaskEdgesHeader(
    userId,
    taskId,
    "summary",
  );
  return { task, detailedEdges, project: toProjectHeader(header) };
}

/**
 * Resolve the review core's input: the dependency closure plus the parent
 * project header, fetched at `review` depth (implementationPlan,
 * executionRecord, and files all projected). Two read batches.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param taskId - UUID of the task.
 * @returns The closure plus project header.
 * @throws ForbiddenError When the caller cannot access the task.
 */
export async function resolveReviewData(
  userId: string,
  taskId: string,
): Promise<PlanningContextData> {
  const { closure, header } = await resolveClosureWithHeader(
    userId,
    taskId,
    "review",
  );
  return { ...closure, project: toProjectHeader(header) };
}

/**
 * Resolve the full {@link ContextBundle} for a task, sharing every lookup
 * across the three cores: the closure batch plus the task's edges in one
 * read batch, then one secondaries batch (dep tasks, downstream summaries,
 * connected-task detail) skipped when the task is isolated. Fetches at
 * `agent` depth, the column superset of the agent, planning, and working
 * cores.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param taskId - UUID of the task.
 * @returns The resolved bundle feeding all three context cores.
 * @throws ForbiddenError When the caller cannot access the task.
 */
export async function resolveContextBundle(
  userId: string,
  taskId: string,
): Promise<ContextBundle> {
  assertValidTaskId(taskId);
  const results = await withUserContextRead(userId, (db) => [
    ...closureBatch(db, taskId, "agent"),
    taskEdgesStmt(db, taskId),
  ]);
  const { task, deps, downstream, upstreamEdgeNotes } = decodeClosureCore(
    taskId,
    results,
  );
  const header = results[4][0] ?? null;
  const edges = results[5];

  const connectedIds = connectedTaskIds(taskId, edges);
  const needsSecondaries =
    closureHasSecondaries(deps, downstream) || connectedIds.length > 0;

  let depTasks: DependencyTaskInfo[] = [];
  let downstreamSummaries: DownstreamSummary[] = [];
  let downstreamEdgeNotes = new Map<string, string>();
  let detailedEdges: DetailedEdge[] = [];
  if (needsSecondaries) {
    const [depRows, summaryRows, tgtNotes, connectedRows] =
      await withUserContextRead(userId, (db) => [
        ...secondariesBatch(db, task.projectId, taskId, deps, downstream),
        connectedTaskInfoStmt(db, connectedIds),
      ]);
    depTasks = mapDependencyTaskRows(depRows);
    downstreamSummaries = mapTaskSummaryRows(summaryRows);
    downstreamEdgeNotes = mapEdgeNoteRows(tgtNotes);
    detailedEdges = assembleDetailedEdges(taskId, edges, connectedRows);
  }

  return {
    task,
    deps,
    downstream,
    upstreamEdgeNotes,
    depTasks,
    downstreamEdgeNotes,
    downstreamSummaries,
    project: toProjectHeader(header),
    detailedEdges,
    ancestors: toAncestors(header),
  };
}

/**
 * Project the header row to the {@link ProjectHeader} shape the planning
 * core renders.
 *
 * @param header - Header row from the closure batch, or null.
 * @returns Header without the ancestor-only id column, or null.
 */
function toProjectHeader(header: HeaderRow | null): ProjectHeader | null {
  if (!header) return null;
  return {
    title: header.title,
    description: header.description,
    identifier: header.identifier,
  };
}

/**
 * Derive the ancestor chain (always the parent project) from the header
 * row, matching the shape the interactive ancestor lookup produced.
 *
 * @param header - Header row from the closure batch, or null.
 * @returns Single-project ancestor chain, or empty when unjoinable.
 */
function toAncestors(header: HeaderRow | null): Ancestor[] {
  if (!header) return [];
  return [{ id: header.id, type: "project", title: header.title }];
}

/**
 * Fetch connected-task detail for a task's edges in one follow-up batch and
 * assemble the {@link DetailedEdge} projection. No edges, no batch.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param taskId - UUID of the anchor task.
 * @param edges - Edge rows from the first batch.
 * @returns Detailed edges (empty for an isolated task).
 */
async function resolveDetailedEdges(
  userId: string,
  taskId: string,
  edges: Parameters<typeof assembleDetailedEdges>[1],
): Promise<DetailedEdge[]> {
  if (edges.length === 0) return [];
  const ids = connectedTaskIds(taskId, edges);
  const [connectedRows] = await withUserContextRead(userId, (db) => [
    connectedTaskInfoStmt(db, ids),
  ]);
  return assembleDetailedEdges(taskId, edges, connectedRows);
}
