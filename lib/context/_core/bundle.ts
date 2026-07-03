import "server-only";

import {
  cancelledDepRecordsStmt,
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
  relatedEdgesStmt,
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
import { isTerminalStatus } from "@/lib/types";
import { CLOSURE_DEPTH } from "@/lib/context/parts";

/**
 * Thrown by {@link resolveRecordData} when the fetched task row is not
 * terminal — the retrospective record bundle only exists for done/cancelled
 * tasks. Guards the gap between the route's access-gate status read and the
 * resolver's own row fetch (a concurrent reopen between the two would
 * otherwise render an active task with completion/cancellation framing).
 */
export class RecordNotTerminalError extends Error {
  /**
   * @param taskId - UUID of the task whose row was not terminal.
   */
  constructor(taskId: string) {
    super(`Task ${taskId} is not done or cancelled; no record bundle exists`);
    this.name = "RecordNotTerminalError";
  }
}

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
  /** 1-hop `relates_to` edges with connected-task detail (non-blocking). */
  related: DetailedEdge[];
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

/** Exactly what {@link buildReviewContextFrom} reads. */
export type ReviewContextData = DependencyClosureData & {
  /** Parent project header, or null when the project is unjoinable. */
  project: ProjectHeader | null;
};

/**
 * Exactly what {@link buildRecordContextFrom} reads. The retrospective
 * bundle renders no upstream data, so the record resolver never walks the
 * dependency chain or fetches dep summaries.
 */
export type RecordContextData = {
  /** Task row at `record` depth. */
  task: TaskFull;
  /** Parent project header, or null when the project is unjoinable. */
  project: ProjectHeader | null;
  /** Active dependents within 2 effective hops, with effective depth. */
  downstream: { id: string; depth: number }[];
  /** Downstream-task summaries (taskRef, title, status). */
  downstreamSummaries: DownstreamSummary[];
  /** Incoming depends_on edge notes, keyed by dependent id. */
  downstreamEdgeNotes: Map<string, string>;
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

/** Header row produced by `projectHeaderByTaskStmt`. */
type HeaderRow = ProjectHeader & { id: string };

/**
 * Build the closure-core batch shared by every closure resolver: the
 * depth-projected task row (whose empty result is the 404 signal — RLS
 * hides rows the caller cannot access), both effective-dependency walks,
 * the outgoing edge notes, and the 1-hop `relates_to` edges. Every
 * statement is keyed on `taskId` alone (project scope derives in SQL), so
 * the whole set rides ONE read batch before the task row has been seen.
 *
 * @param db - Read statement-building handle.
 * @param taskId - UUID of the task.
 * @param depth - Column projection for the task-row fetch.
 * @returns Tuple of five lazy statements.
 */
function closureCoreBatch(db: ReadConn, taskId: string, depth: TaskFetchDepth) {
  return [
    taskForDepthStmt(db, taskId, depth),
    effectiveDepChainStmt(db, taskId, CLOSURE_DEPTH),
    effectiveDownstreamStmt(db, taskId, CLOSURE_DEPTH),
    edgeNotesBySourceStmt(db, taskId),
    relatedEdgesStmt(db, taskId),
  ] as const;
}

/**
 * {@link closureCoreBatch} plus the parent-project header, for resolvers
 * that render the header (planning, review). The agent path runs the core
 * batch alone — it never reads the header.
 *
 * @param db - Read statement-building handle.
 * @param taskId - UUID of the task.
 * @param depth - Column projection for the task-row fetch.
 * @returns Tuple of six lazy statements; header rows are position 5.
 */
function closureBatch(db: ReadConn, taskId: string, depth: TaskFetchDepth) {
  return [
    ...closureCoreBatch(db, taskId, depth),
    projectHeaderByTaskStmt(db, taskId, true),
  ] as const;
}

/** Positional results of a {@link closureCoreBatch} run. */
type ClosureCoreResults = ReadResults<ReturnType<typeof closureCoreBatch>>;

/** Raw `relates_to` edge rows from the closure-core batch. */
type RelatedEdgeRows = ClosureCoreResults[4];

/** Decoded closure core: task row, dependency walks, outgoing notes. */
type ClosureCore = {
  task: TaskFull;
  deps: { id: string; depth: number }[];
  downstream: { id: string; depth: number }[];
  upstreamEdgeNotes: Map<string, string>;
  relatedEdges: RelatedEdgeRows;
};

/**
 * Decode the closure-core positions of a batch result tuple: map the task
 * row (throwing the 404-shaped ForbiddenError when RLS hides it), normalize
 * the dependency walks (coercing each effective depth — the recursive CTE
 * aggregates it as bigint, which arrives as a string on the wire), and fold
 * the outgoing edge notes. Accepts any batch that begins with the
 * {@link closureCoreBatch} statements so wider batches (header, edges)
 * decode without rebuilding tuples.
 *
 * @param taskId - UUID of the task the batch targeted.
 * @param results - Batch results whose first five positions are the core.
 * @returns Task, walks, outgoing notes, and raw `relates_to` edges.
 * @throws ForbiddenError when the task row is not visible to the caller.
 */
function decodeClosureCore(
  taskId: string,
  results: readonly [...ClosureCoreResults, ...unknown[]],
): ClosureCore {
  const [taskRaw, depRaw, downRaw, srcNotes, relatedEdges] = results;
  const task = requireTaskRow(
    normalizeExecuteResult<TaskFullRawRow>(taskRaw),
    taskId,
  );
  const deps = normalizeExecuteResult<{ id: string; depth: number | string }>(
    depRaw,
  ).map((r) => ({ id: r.id, depth: Number(r.depth) }));
  const downstream = normalizeExecuteResult<{
    id: string;
    depth: number | string;
  }>(downRaw).map((r) => ({ id: r.id, depth: Number(r.depth) }));
  return {
    task,
    deps,
    downstream,
    upstreamEdgeNotes: mapEdgeNoteRows(srcNotes),
    relatedEdges,
  };
}

/**
 * The single skip rule for the closure-secondaries batch: secondaries are
 * only worth a round-trip when a dependency walk returned ids or a
 * `relates_to` edge needs its connected task hydrated.
 *
 * @param deps - Active prerequisite ids from the closure walk.
 * @param downstream - Active dependent ids from the closure walk.
 * @param relatedEdges - Raw `relates_to` edge rows from the core batch.
 * @returns True when a secondaries batch has rows to fetch.
 */
function closureHasSecondaries(
  deps: { id: string }[],
  downstream: { id: string }[],
  relatedEdges: readonly unknown[],
): boolean {
  return deps.length > 0 || downstream.length > 0 || relatedEdges.length > 0;
}

/**
 * Build the closure-secondaries statements: dependency-task summaries,
 * downstream summaries, incoming edge notes, and connected-task detail for
 * the `relates_to` edges. Single source for every secondaries consumer
 * (agent, planning, review) so they cannot drift.
 *
 * @param db - Read statement-building handle.
 * @param projectId - UUID of the task's project (from the closure task row).
 * @param taskId - UUID of the task.
 * @param deps - Active prerequisite ids.
 * @param downstream - Active dependent ids.
 * @param relatedEdges - Raw `relates_to` edge rows from the core batch.
 * @param withDownstreamDescriptions - Whether downstream summaries select
 *   the `description` column. Only the planning core renders it.
 * @returns Tuple of four lazy statements.
 */
function secondariesBatch(
  db: ReadConn,
  projectId: string,
  taskId: string,
  deps: { id: string }[],
  downstream: { id: string }[],
  relatedEdges: RelatedEdgeRows,
  withDownstreamDescriptions: boolean,
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
      withDownstreamDescriptions,
    ),
    edgeNotesByTargetStmt(db, taskId),
    connectedTaskInfoStmt(db, connectedTaskIds(taskId, relatedEdges)),
  ] as const;
}

/**
 * Fetch the closure secondaries (dependency-task summaries, downstream
 * summaries, incoming edge notes, and related-task detail) in one read
 * batch, skipped entirely when the closure and the `relates_to` set are
 * both empty.
 *
 * @param userId - Authenticated user id.
 * @param projectId - UUID of the task's project (from the closure task row).
 * @param taskId - UUID of the task.
 * @param deps - Active prerequisite ids.
 * @param downstream - Active dependent ids.
 * @param relatedEdges - Raw `relates_to` edge rows from the core batch.
 * @param withDownstreamDescriptions - Whether downstream summaries select
 *   the `description` column.
 * @returns Dep-task summaries, downstream summaries, incoming notes, and
 *   assembled `relates_to` detailed edges.
 */
async function resolveClosureSecondaries(
  userId: string,
  projectId: string,
  taskId: string,
  deps: { id: string }[],
  downstream: { id: string }[],
  relatedEdges: RelatedEdgeRows,
  withDownstreamDescriptions: boolean,
): Promise<
  [
    DependencyTaskInfo[],
    DownstreamSummary[],
    Map<string, string>,
    DetailedEdge[],
  ]
> {
  if (!closureHasSecondaries(deps, downstream, relatedEdges)) {
    return [[], [], new Map(), []];
  }
  const [depRows, summaryRows, tgtNotes, relatedInfoRows] =
    await withUserContextRead(userId, (db) =>
      secondariesBatch(
        db,
        projectId,
        taskId,
        deps,
        downstream,
        relatedEdges,
        withDownstreamDescriptions,
      ),
    );
  return [
    mapDependencyTaskRows(depRows),
    mapTaskSummaryRows(summaryRows),
    mapEdgeNoteRows(tgtNotes),
    assembleDetailedEdges(taskId, relatedEdges, relatedInfoRows),
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
  return finishClosure(
    userId,
    taskId,
    decodeClosureCore(taskId, results),
    false,
  );
}

/**
 * Run the closure batch and secondaries, returning the closure plus the
 * parent-project header row. Internal substrate for the header-rendering
 * closure resolvers (review).
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
    false,
  );
  return { closure, header: results[5][0] ?? null };
}

/**
 * Fetch the closure secondaries for a decoded core and assemble the full
 * {@link DependencyClosureData}. Shared tail of the agent and
 * header-rendering closure resolvers.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param taskId - UUID of the task.
 * @param core - Decoded closure-core rows.
 * @param withDownstreamDescriptions - Whether downstream summaries select
 *   the `description` column.
 * @returns The resolved closure.
 */
async function finishClosure(
  userId: string,
  taskId: string,
  core: ClosureCore,
  withDownstreamDescriptions: boolean,
): Promise<DependencyClosureData> {
  const { relatedEdges, ...coreData } = core;
  const [depTasks, downstreamSummaries, downstreamEdgeNotes, related] =
    await resolveClosureSecondaries(
      userId,
      core.task.projectId,
      taskId,
      core.deps,
      core.downstream,
      relatedEdges,
      withDownstreamDescriptions,
    );
  return {
    ...coreData,
    depTasks,
    downstreamEdgeNotes,
    downstreamSummaries,
    related,
  };
}

/**
 * Resolve the dependency closure plus the parent project header and the
 * direct cancelled deps with execution records ("Abandoned Approaches"),
 * the planning core's full input. Two read batches: the closure batch with
 * header, then a secondaries batch that always runs — the cancelled-dep
 * statement rides it unconditionally because direct cancelled deps are
 * transparent to the effective-dep walk and so never appear in the closure.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param taskId - UUID of the task.
 * @returns The closure plus project header and abandoned deps.
 * @throws ForbiddenError When the caller cannot access the task.
 */
export async function resolvePlanningData(
  userId: string,
  taskId: string,
): Promise<PlanningContextData> {
  assertValidTaskId(taskId);
  const results = await withUserContextRead(userId, (db) =>
    closureBatch(db, taskId, "planning"),
  );
  const core = decodeClosureCore(taskId, results);
  const { relatedEdges, ...coreData } = core;
  const header = results[5][0] ?? null;
  const [depRows, summaryRows, tgtNotes, relatedInfoRows, cancelledRows] =
    await withUserContextRead(userId, (db) => [
      ...secondariesBatch(
        db,
        core.task.projectId,
        taskId,
        core.deps,
        core.downstream,
        relatedEdges,
        true,
      ),
      cancelledDepRecordsStmt(db, core.task.projectId, taskId),
    ]);
  return {
    ...coreData,
    depTasks: mapDependencyTaskRows(depRows),
    downstreamSummaries: mapTaskSummaryRows(summaryRows),
    downstreamEdgeNotes: mapEdgeNoteRows(tgtNotes),
    related: assembleDetailedEdges(taskId, relatedEdges, relatedInfoRows),
    abandonedDeps: mapDependencyTaskRows(cancelledRows),
    project: toProjectHeader(header),
  };
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
      // Neither the working hierarchy (id/title) nor the summary parent
      // (title) renders the project description — skip its egress.
      projectHeaderByTaskStmt(db, taskId, false),
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
): Promise<ReviewContextData> {
  const { closure, header } = await resolveClosureWithHeader(
    userId,
    taskId,
    "review",
  );
  return { ...closure, project: toProjectHeader(header) };
}

/**
 * Resolve the record core's input: the `record`-depth task row, the
 * downstream walk, and the parent project header in one read batch, plus
 * one batch for downstream summaries and incoming edge notes when
 * dependents exist. The retrospective bundle renders nothing upstream, so
 * the dependency-chain walk, dep summaries (and their execution records),
 * and outgoing edge notes are never fetched on this path.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param taskId - UUID of the task.
 * @returns The record input.
 * @throws ForbiddenError When the caller cannot access the task.
 * @throws RecordNotTerminalError When the fetched row is not done/cancelled.
 */
export async function resolveRecordData(
  userId: string,
  taskId: string,
): Promise<RecordContextData> {
  assertValidTaskId(taskId);
  const [taskRaw, downRaw, headerRows] = await withUserContextRead(
    userId,
    (db) => [
      taskForDepthStmt(db, taskId, "record"),
      effectiveDownstreamStmt(db, taskId, CLOSURE_DEPTH),
      projectHeaderByTaskStmt(db, taskId, true),
    ],
  );
  const task = requireTaskRow(
    normalizeExecuteResult<TaskFullRawRow>(taskRaw),
    taskId,
  );
  if (!isTerminalStatus(task.status as string)) {
    throw new RecordNotTerminalError(taskId);
  }
  const downstream = normalizeExecuteResult<{
    id: string;
    depth: number | string;
  }>(downRaw).map((r) => ({ id: r.id, depth: Number(r.depth) }));
  const [downstreamSummaries, downstreamEdgeNotes] =
    await resolveDownstreamSecondaries(
      userId,
      task.projectId,
      taskId,
      downstream,
    );
  return {
    task,
    project: toProjectHeader(headerRows[0] ?? null),
    downstream,
    downstreamSummaries,
    downstreamEdgeNotes,
  };
}

/**
 * Fetch downstream summaries (no descriptions) and incoming edge notes in
 * one read batch, skipped entirely when the downstream walk is empty.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param projectId - UUID of the task's project.
 * @param taskId - UUID of the task.
 * @param downstream - Active dependent ids from the downstream walk.
 * @returns Downstream summaries and incoming notes.
 */
async function resolveDownstreamSecondaries(
  userId: string,
  projectId: string,
  taskId: string,
  downstream: { id: string }[],
): Promise<[DownstreamSummary[], Map<string, string>]> {
  if (downstream.length === 0) return [[], new Map()];
  const [summaryRows, tgtNotes] = await withUserContextRead(userId, (db) => [
    taskSummariesStmt(
      db,
      projectId,
      downstream.map((d) => d.id),
      false,
    ),
    edgeNotesByTargetStmt(db, taskId),
  ]);
  return [mapTaskSummaryRows(summaryRows), mapEdgeNoteRows(tgtNotes)];
}

/** Discriminated resolver output for the MCP `agent` depth. */
export type AgentBundleData =
  | { kind: "agent"; data: AgentContextData }
  | { kind: "record"; data: RecordContextData };

/**
 * Resolve the MCP `agent` depth input in two read batches, dispatching on
 * the task's status: active tasks get the agent closure, `done` /
 * `cancelled` tasks get the retrospective record input. Status is read
 * from the agent-depth closure core (the dominant active path stays
 * header-free and batch-identical to {@link resolveDependencyClosure});
 * for terminal tasks the core's task row and downstream walk are reused —
 * the `agent` projection selects `implementationPlan` as `"active-only"`,
 * so a terminal row arrives with the plan already `NULL`, exactly like the
 * `record` projection — while the second batch fetches only what the
 * record bundle renders (slim downstream summaries, incoming notes,
 * project header) and always runs because the header is unconditionally
 * rendered.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param taskId - UUID of the task.
 * @returns The agent closure, or the record input for terminal tasks.
 * @throws ForbiddenError When the caller cannot access the task.
 */
export async function resolveAgentBundleData(
  userId: string,
  taskId: string,
): Promise<AgentBundleData> {
  assertValidTaskId(taskId);
  const results = await withUserContextRead(userId, (db) =>
    closureCoreBatch(db, taskId, "agent"),
  );
  const core = decodeClosureCore(taskId, results);
  if (!isTerminalStatus(core.task.status as string)) {
    return {
      kind: "agent",
      data: await finishClosure(userId, taskId, core, false),
    };
  }
  const [summaryRows, tgtNotes, headerRows] = await withUserContextRead(
    userId,
    (db) => [
      taskSummariesStmt(
        db,
        core.task.projectId,
        core.downstream.map((d) => d.id),
        false,
      ),
      edgeNotesByTargetStmt(db, taskId),
      projectHeaderByTaskStmt(db, taskId, true),
    ],
  );
  return {
    kind: "record",
    data: {
      task: core.task,
      project: toProjectHeader(headerRows[0] ?? null),
      downstream: core.downstream,
      downstreamSummaries: mapTaskSummaryRows(summaryRows),
      downstreamEdgeNotes: mapEdgeNoteRows(tgtNotes),
    },
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
