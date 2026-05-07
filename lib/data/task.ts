import "server-only";

import { and, asc, desc, eq, gt, gte, ilike, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, tasks, taskEdges, type NewTask } from "@/lib/db/schema";
import { acquireProjectLock } from "@/lib/db/raw/acquire-project-lock";
import type { Decision, HistoryEntry, TaskStatus } from "@/lib/types";
import {
  asIdentifier,
  composeTaskRef,
  enrichWithTaskRef,
} from "@/lib/graph/identifier";
import { buildEffectiveDepGraph } from "@/lib/graph/effective-deps";
import { normalizeTags } from "@/lib/graph/tag-similarity";
import { ProjectNotFoundError } from "@/lib/graph/errors";
import { formatTaskMarkdownFields } from "@/lib/markdown/format";
import type { AuthContext } from "@/lib/auth/context";
import {
  assertProjectAccess,
  assertTaskAccess,
  ForbiddenError,
} from "@/lib/auth/authorization";
import {
  decodeOrderCursor,
  encodeOrderCursor,
  type Cursor,
} from "@/lib/data/cursor";
import type { TaskFull, TaskSlim } from "@/lib/data/views";
import { dbEvents } from "@/lib/events";

/** Emit a change event to all connected SSE clients via the in-memory event bus. */
function notifyChange() {
  dbEvents.emit("change", "*");
}

/**
 * Build a timestamped history entry.
 * @param entry - Partial entry without id/date.
 * @returns Complete history entry with generated id and current date.
 */
function makeHistoryEntry(
  entry: Omit<HistoryEntry, "id" | "date">,
): HistoryEntry {
  return {
    ...entry,
    id: crypto.randomUUID(),
    date: new Date().toISOString(),
  };
}

/**
 * Append a history entry to a task's history array.
 * @param taskId - UUID of the task.
 * @param entry - The history entry to append.
 */
export async function appendTaskHistory(
  taskId: string,
  entry: HistoryEntry,
): Promise<void> {
  await db
    .update(tasks)
    .set({
      history: sql`${tasks.history} || ${JSON.stringify([entry])}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));
}

// ---------------------------------------------------------------------------
// Single-entity queries
// ---------------------------------------------------------------------------

/**
 * Fetch the full task row plus the composed `taskRef`. Membership-gated.
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns Full task row with composed `taskRef`.
 * @throws ForbiddenError when the caller is not a member of the task's team.
 */
export async function getTaskFull(
  ctx: AuthContext,
  taskId: string,
): Promise<TaskFull> {
  const task = await assertTaskAccess(taskId, ctx);

  const [proj] = await db
    .select({ identifier: projects.identifier })
    .from(projects)
    .where(eq(projects.id, task.projectId))
    .limit(1);
  if (!proj) {
    throw new Error(
      `Task ${task.id} references missing project ${task.projectId}`,
    );
  }
  const taskRef = composeTaskRef(asIdentifier(proj.identifier), task.sequenceNumber);

  return { ...task, taskRef };
}

/**
 * Fetch the slim task view for listing surfaces.
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns Slim task view.
 * @throws ForbiddenError when the caller is not a member of the task's team.
 */
export async function getTaskSlim(
  ctx: AuthContext,
  taskId: string,
): Promise<TaskSlim> {
  const full = await getTaskFull(ctx, taskId);
  return {
    id: full.id,
    taskRef: full.taskRef,
    title: full.title,
    status: full.status,
    tags: full.tags,
    category: full.category,
    order: full.order,
  };
}

// ---------------------------------------------------------------------------
// List queries
// ---------------------------------------------------------------------------

/**
 * Fetch all tasks for a project, ordered by `order`.
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns Ordered array of tasks.
 */
export async function getProjectTasks(ctx: AuthContext, projectId: string) {
  await assertProjectAccess(projectId, ctx);
  return listProjectTasks(projectId);
}

/**
 * Fetch all tasks for a project, ordered by `order`. Internal helper —
 * caller must assert project access before invoking. Used by context
 * assemblers that have already authorized the parent project.
 *
 * @param projectId - UUID of the project.
 * @returns Ordered array of tasks.
 */
export async function listProjectTasks(projectId: string) {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(tasks.order));
}

export type { TaskSlim } from "@/lib/data/views";

/**
 * Fetch slim task list for a project (id, title, status, tags, order only).
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns Ordered array of slim tasks with composed taskRef.
 */
export async function getProjectTasksSlim(
  ctx: AuthContext,
  projectId: string,
): Promise<TaskSlim[]> {
  const { project } = await assertProjectAccess(projectId, ctx);

  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      tags: tasks.tags,
      category: tasks.category,
      order: tasks.order,
      sequenceNumber: tasks.sequenceNumber,
    })
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(tasks.order));

  return enrichWithTaskRef(rows, asIdentifier(project.identifier)).map((t) => ({
    id: t.id,
    taskRef: t.taskRef,
    title: t.title,
    status: t.status,
    tags: t.tags,
    category: t.category,
    order: t.order,
  }));
}

// ---------------------------------------------------------------------------
// Task state derivation
// ---------------------------------------------------------------------------

/** Derived task state based on status + dependency readiness. */
export type TaskState =
  | "done"
  | "cancelled"
  | "in_progress"
  | "ready"
  | "plannable"
  | "blocked"
  | "draft";

/**
 * Derive the actionable state for a single task using effective deps.
 *
 * Cancelled tasks short-circuit. For active tasks, dep readiness is checked
 * against the *effective* dependency set — cancelled middles are walked
 * through, and the wall is the next active prerequisite.
 *
 * @param task - Task with status, description, and acceptanceCriteria.
 * @param graph - Effective dependency graph for the project.
 * @returns Derived TaskState.
 */
function deriveTaskState(
  task: {
    id: string;
    status: string;
    description: string;
    acceptanceCriteria: unknown;
  },
  graph: {
    activeTasks: Map<string, { status: string }>;
    effectiveDeps: Map<string, Set<string>>;
  },
): TaskState {
  if (task.status === "done") return "done";
  if (task.status === "cancelled") return "cancelled";
  if (task.status === "in_progress") return "in_progress";

  const deps = graph.effectiveDeps.get(task.id) ?? new Set<string>();
  let allDepsDone = true;
  for (const depId of deps) {
    if (graph.activeTasks.get(depId)?.status !== "done") {
      allDepsDone = false;
      break;
    }
  }

  if (task.status === "planned") {
    return allDepsDone ? "ready" : "blocked";
  }

  if (!allDepsDone) return "blocked";

  const hasDescription = task.description.trim().length > 0;
  const criteria = task.acceptanceCriteria as
    | { id: string; text: string; checked: boolean }[]
    | null;
  const hasCriteria = Array.isArray(criteria) && criteria.length > 0;

  return hasDescription && hasCriteria ? "plannable" : "draft";
}

/**
 * Derive states for a batch of tasks in one project. Internal helper —
 * caller is responsible for asserting project access first.
 *
 * Builds the effective dependency graph once and reuses it for every task in
 * the subset, so dep readiness reflects transitive blocking through cancelled
 * middles rather than just direct edges.
 *
 * @param projectId - UUID of the project.
 * @param taskSubset - Tasks to derive states for.
 * @returns Map of taskId → TaskState.
 */
export async function deriveTaskStates(
  projectId: string,
  taskSubset: {
    id: string;
    status: string;
    description: string;
    acceptanceCriteria: unknown;
  }[],
): Promise<Map<string, TaskState>> {
  const graph = await buildEffectiveDepGraph(projectId);
  const result = new Map<string, TaskState>();
  for (const task of taskSubset) {
    result.set(task.id, deriveTaskState(task, graph));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** A search result task. */
export type SearchResult = {
  id: string;
  taskRef: string;
  title: string;
  status: string;
  state: TaskState;
  tags: string[];
  category: string | null;
};

/** Match a full taskRef like "MYMR-83" (case-insensitive). */
const TASK_REF_PATTERN = /^([A-Z0-9]+)-(\d+)$/i;

/**
 * Search tasks by taskRef, title, or tags within a project.
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @param query - Optional search string.
 * @param tags - Optional exact tag filter (OR-within).
 * @returns Up to 20 matching tasks with derived state.
 */
export async function searchTasks(
  ctx: AuthContext,
  projectId: string,
  query?: string,
  tags?: string[],
): Promise<SearchResult[]> {
  const { project } = await assertProjectAccess(projectId, ctx);

  const trimmedQuery = query?.trim() ?? "";
  const tagFilter = normalizeTags(tags);
  if (trimmedQuery.length === 0 && tagFilter.length === 0) return [];

  const clauses = [eq(tasks.projectId, projectId)];

  if (trimmedQuery.length > 0) {
    const refMatch = trimmedQuery.match(TASK_REF_PATTERN);
    const seqClause =
      refMatch && refMatch[1].toUpperCase() === project.identifier
        ? eq(tasks.sequenceNumber, Number(refMatch[2]))
        : null;

    const pattern = `%${trimmedQuery}%`;
    const tagSubstring = sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${tasks.tags}) AS t WHERE t ILIKE ${pattern})`;
    const queryClause =
      seqClause ?? or(ilike(tasks.title, pattern), tagSubstring);
    if (queryClause) clauses.push(queryClause);
  }

  if (tagFilter.length > 0) {
    clauses.push(
      sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${tasks.tags}) AS t WHERE t IN ${tagFilter})`,
    );
  }

  const matchingTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      tags: tasks.tags,
      category: tasks.category,
      description: tasks.description,
      acceptanceCriteria: tasks.acceptanceCriteria,
      sequenceNumber: tasks.sequenceNumber,
      order: tasks.order,
    })
    .from(tasks)
    .where(and(...clauses));

  if (trimmedQuery.length > 0) {
    const lower = trimmedQuery.toLowerCase();
    matchingTasks.sort((a, b) => {
      const aLower = a.title.toLowerCase();
      const bLower = b.title.toLowerCase();
      const aTitle =
        aLower === lower
          ? 0
          : aLower.startsWith(lower)
            ? 1
            : aLower.includes(lower)
              ? 2
              : 3;
      const bTitle =
        bLower === lower
          ? 0
          : bLower.startsWith(lower)
            ? 1
            : bLower.includes(lower)
              ? 2
              : 3;
      return aTitle - bTitle;
    });
  } else {
    matchingTasks.sort((a, b) => a.order - b.order);
  }

  const trimmed = matchingTasks.slice(0, 20);
  const stateMap = await deriveTaskStates(projectId, trimmed);

  const identifier = asIdentifier(project.identifier);
  return enrichWithTaskRef(trimmed, identifier).map((t) => ({
    id: t.id,
    taskRef: t.taskRef,
    title: t.title,
    status: t.status,
    state: stateMap.get(t.id) ?? "draft",
    tags: t.tags,
    category: t.category,
  }));
}

// ---------------------------------------------------------------------------
// Paginated search
// ---------------------------------------------------------------------------

/** Page of search results with a cursor for the next slice. */
export type SearchResultPage = {
  rows: SearchResult[];
  nextCursor: Cursor | null;
};

/**
 * Paginated task search. Stable keyset ordering on `(order DESC, id DESC)`.
 * Relevance sort (used by the unpaginated {@link searchTasks}) is sacrificed
 * for stable pagination — results are ordered by task order position, not
 * title match quality.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @param opts - Filter and pagination options.
 * @returns Page of search results and cursor for the next page.
 */
export async function searchTasksPaged(
  ctx: AuthContext,
  projectId: string,
  opts: {
    query?: string;
    tags?: string[];
    limit?: number;
    cursor?: Cursor | string | null;
  } = {},
): Promise<SearchResultPage> {
  const { project } = await assertProjectAccess(projectId, ctx);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const after = decodeOrderCursor(opts.cursor);

  const trimmedQuery = opts.query?.trim() ?? "";
  const tagFilter = normalizeTags(opts.tags);

  const clauses = [eq(tasks.projectId, projectId)];

  if (trimmedQuery.length > 0) {
    const refMatch = trimmedQuery.match(TASK_REF_PATTERN);
    const seqClause =
      refMatch && refMatch[1].toUpperCase() === project.identifier
        ? eq(tasks.sequenceNumber, Number(refMatch[2]))
        : null;
    const pattern = `%${trimmedQuery}%`;
    const tagSubstring = sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${tasks.tags}) AS t WHERE t ILIKE ${pattern})`;
    const queryClause =
      seqClause ?? or(ilike(tasks.title, pattern), tagSubstring);
    if (queryClause) clauses.push(queryClause);
  }

  if (tagFilter.length > 0) {
    clauses.push(
      sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${tasks.tags}) AS t WHERE t IN ${tagFilter})`,
    );
  }

  const cursorClause = after
    ? sql`(${tasks.order} < ${after.order}
            OR (${tasks.order} = ${after.order} AND ${tasks.id} < ${after.id}))`
    : sql`TRUE`;

  const matchingTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      tags: tasks.tags,
      category: tasks.category,
      description: tasks.description,
      acceptanceCriteria: tasks.acceptanceCriteria,
      sequenceNumber: tasks.sequenceNumber,
      order: tasks.order,
    })
    .from(tasks)
    .where(and(...clauses, cursorClause))
    .orderBy(desc(tasks.order), desc(tasks.id))
    .limit(limit + 1);

  const hasMore = matchingTasks.length > limit;
  const trimmed = hasMore ? matchingTasks.slice(0, limit) : matchingTasks;
  const last = trimmed[trimmed.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeOrderCursor({ order: last.order, id: last.id })
      : null;

  if (trimmed.length === 0) return { rows: [], nextCursor: null };

  const stateMap = await deriveTaskStates(projectId, trimmed);
  const identifier = asIdentifier(project.identifier);
  const rows = enrichWithTaskRef(trimmed, identifier).map((t) => ({
    id: t.id,
    taskRef: t.taskRef,
    title: t.title,
    status: t.status,
    state: stateMap.get(t.id) ?? ("draft" as const),
    tags: t.tags,
    category: t.category,
  }));

  return { rows, nextCursor };
}

// ---------------------------------------------------------------------------
// Edge notes — internal helpers (caller asserted access already)
// ---------------------------------------------------------------------------

/**
 * Fetch edge notes for outgoing depends_on edges from a task. Internal —
 * caller must assert task access before invoking. The `projectId` filter
 * guarantees the connected (target) task is in the same project, so a
 * stale or hand-crafted edge to a task in another project cannot leak a
 * note into context output.
 * @param projectId - UUID of the project the source task belongs to.
 * @param taskId - UUID of the source task.
 * @returns Map of target task ID to edge note.
 */
export async function fetchEdgeNotesBySource(
  projectId: string,
  taskId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ targetTaskId: taskEdges.targetTaskId, note: taskEdges.note })
    .from(taskEdges)
    .innerJoin(tasks, eq(tasks.id, taskEdges.targetTaskId))
    .where(
      and(
        eq(taskEdges.sourceTaskId, taskId),
        eq(taskEdges.edgeType, "depends_on"),
        eq(tasks.projectId, projectId),
      ),
    );
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.note) map.set(r.targetTaskId, r.note);
  }
  return map;
}

/**
 * Fetch edge notes for incoming depends_on edges to a task. Internal —
 * caller must assert task access before invoking. See `fetchEdgeNotesBySource`
 * for the projectId-filter rationale.
 * @param projectId - UUID of the project the target task belongs to.
 * @param taskId - UUID of the target task.
 * @returns Map of source task ID to edge note.
 */
export async function fetchEdgeNotesByTarget(
  projectId: string,
  taskId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ sourceTaskId: taskEdges.sourceTaskId, note: taskEdges.note })
    .from(taskEdges)
    .innerJoin(tasks, eq(tasks.id, taskEdges.sourceTaskId))
    .where(
      and(
        eq(taskEdges.targetTaskId, taskId),
        eq(taskEdges.edgeType, "depends_on"),
        eq(tasks.projectId, projectId),
      ),
    );
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.note) map.set(r.sourceTaskId, r.note);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Batch task summaries — internal helper
// ---------------------------------------------------------------------------

/**
 * Fetch taskRef, title, status, and description for multiple tasks by ID.
 * Internal — caller must have already asserted access on the originating task.
 * The `projectId` filter is defense in depth: if a future caller passes an
 * id list that crosses projects, the SQL ignores out-of-project rows.
 * @param projectId - UUID of the project the tasks belong to.
 * @param taskIds - Array of task UUIDs.
 * @returns Array of task summaries with composed taskRef.
 */
export async function fetchTaskSummaries(
  projectId: string,
  taskIds: string[],
) {
  if (taskIds.length === 0) return [];
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      description: tasks.description,
      sequenceNumber: tasks.sequenceNumber,
      identifier: projects.identifier,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(eq(tasks.projectId, projectId), sql`${tasks.id} IN ${taskIds}`),
    );
  return rows.map((r) => ({
    id: r.id,
    taskRef: composeTaskRef(asIdentifier(r.identifier), r.sequenceNumber),
    title: r.title,
    status: r.status,
    description: r.description,
  }));
}

/** Dependency-task projection used by the agent / planning context assemblers. */
export type DependencyTaskInfo = {
  id: string;
  title: string;
  status: string;
  executionRecord: string | null;
  taskRef: string;
};

/**
 * Fetch dependency-task summaries with composed taskRef and execution record
 * for an id list scoped to one project. Internal helper for context
 * assemblers — caller asserted access on the originating task. The
 * `projectId` filter prevents stale or hand-crafted edges from leaking
 * cross-project rows into context output.
 *
 * @param projectId - UUID of the project the dependency tasks belong to.
 * @param taskIds - UUIDs of the dependency tasks.
 * @returns Dep-task projections including `executionRecord` and `taskRef`.
 */
export async function fetchDependencyTasks(
  projectId: string,
  taskIds: string[],
): Promise<DependencyTaskInfo[]> {
  if (taskIds.length === 0) return [];
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      executionRecord: tasks.executionRecord,
      sequenceNumber: tasks.sequenceNumber,
      identifier: projects.identifier,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(eq(tasks.projectId, projectId), sql`${tasks.id} IN ${taskIds}`),
    );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    executionRecord: r.executionRecord,
    taskRef: composeTaskRef(asIdentifier(r.identifier), r.sequenceNumber),
  }));
}

/** Sibling-task projection for the working-context view. */
export type SiblingTaskInfo = {
  id: string;
  taskRef: string;
  title: string;
  status: string;
};

/**
 * Fetch sibling tasks (same project, excluding the current task) with
 * composed taskRef. Internal helper for context assemblers — caller
 * asserted access on the parent task.
 *
 * @param projectId - UUID of the project.
 * @param excludeTaskId - UUID of the task to omit from the result.
 * @returns Sibling task projections.
 */
export async function fetchSiblingTasks(
  projectId: string,
  excludeTaskId: string,
): Promise<SiblingTaskInfo[]> {
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      sequenceNumber: tasks.sequenceNumber,
      identifier: projects.identifier,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      sql`${tasks.projectId} = ${projectId} AND ${tasks.id} != ${excludeTaskId}`,
    );
  return rows.map((r) => ({
    id: r.id,
    taskRef: composeTaskRef(asIdentifier(r.identifier), r.sequenceNumber),
    title: r.title,
    status: r.status,
  }));
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

/**
 * Fetch slim task rows for every task in a project. Used by graph
 * algorithms (`buildEffectiveDepGraph`) that only need a small slice.
 *
 * @param projectId - UUID of the project.
 * @returns Slim rows for every task in the project.
 */
export async function listTasksForGraph(projectId: string) {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      sequenceNumber: tasks.sequenceNumber,
      tags: tasks.tags,
    })
    .from(tasks)
    .where(eq(tasks.projectId, projectId));
}

// ---------------------------------------------------------------------------
// Task mutations
// ---------------------------------------------------------------------------

/** Input for createTask — sequenceNumber is always computed internally. */
export type CreateTaskInput = Omit<NewTask, "id" | "sequenceNumber">;

/**
 * Insert a new task under a project the caller has access to. The
 * project's team scope is verified by `assertProjectAccess` and inherited
 * by the new task — task team scope is never derived from the session.
 *
 * Uses a transaction-scoped PostgreSQL advisory lock keyed on the project UUID
 * to serialize concurrent task creation and prevent sequence_number collisions.
 * Computes order (append-to-end when unset) and sequenceNumber inside the lock.
 *
 * @param ctx - Resolved auth context.
 * @param data - Task fields. sequenceNumber assigned internally.
 * @returns Task summary with composed taskRef.
 */
export async function createTask(ctx: AuthContext, data: CreateTaskInput) {
  await assertProjectAccess(data.projectId, ctx);

  if (Array.isArray(data.acceptanceCriteria)) {
    data = {
      ...data,
      acceptanceCriteria: (data.acceptanceCriteria as unknown[]).map((c) => {
        if (typeof c === "string")
          return { id: crypto.randomUUID(), text: c, checked: false };
        const obj = c as Record<string, unknown>;
        return {
          id: (obj.id as string) ?? crypto.randomUUID(),
          text:
            (obj.text as string) ?? (obj.description as string) ?? String(c),
          checked: (obj.checked as boolean) ?? false,
        };
      }),
    };
  }

  if (Array.isArray(data.decisions)) {
    data = {
      ...data,
      decisions: (data.decisions as unknown[]).map((d) => {
        if (typeof d === "string") {
          return {
            id: crypto.randomUUID(),
            text: d,
            date: new Date().toISOString().slice(0, 10),
            source: "refinement" as const,
          };
        }
        const obj = d as Record<string, unknown>;
        return {
          id: (obj.id as string) ?? crypto.randomUUID(),
          text: (obj.text as string) ?? String(d),
          date: (obj.date as string) ?? new Date().toISOString().slice(0, 10),
          source: (obj.source as Decision["source"]) ?? "refinement",
        } as Decision;
      }),
    };
  }

  data = await formatTaskMarkdownFields(data);

  const result = await db.transaction(async (tx) => {
    await acquireProjectLock(tx, data.projectId);

    const [proj] = await tx
      .select({ identifier: projects.identifier })
      .from(projects)
      .where(eq(projects.id, data.projectId));
    if (!proj) throw new ProjectNotFoundError(data.projectId);

    const [maxRow] = await tx
      .select({
        maxOrder: sql<number>`COALESCE(MAX(${tasks.order}), -1)`,
        maxSeq: sql<number>`COALESCE(MAX(${tasks.sequenceNumber}), 0)`,
      })
      .from(tasks)
      .where(eq(tasks.projectId, data.projectId));

    const sequenceNumber = (maxRow?.maxSeq ?? 0) + 1;
    const order =
      data.order === undefined || data.order === 0
        ? (maxRow?.maxOrder ?? -1) + 1
        : data.order;

    const [task] = await tx
      .insert(tasks)
      .values({
        ...data,
        order,
        sequenceNumber,
        history: [
          makeHistoryEntry({
            type: "created",
            label: "Task created",
            description: `Task "${data.title}" created.`,
            actor: "ai",
          }),
        ],
      })
      .returning();

    return {
      id: task.id,
      title: task.title,
      projectId: task.projectId,
      order: task.order,
      sequenceNumber: task.sequenceNumber,
      taskRef: composeTaskRef(asIdentifier(proj.identifier), task.sequenceNumber),
    };
  });

  notifyChange();
  return result;
}

// ---------------------------------------------------------------------------
// Update task
// ---------------------------------------------------------------------------

/** Fields callers must not change via updateTask — managed internally or set on create. */
const PROTECTED_TASK_FIELDS = [
  "id",
  "projectId",
  "sequenceNumber",
  "history",
  "createdAt",
  "updatedAt",
] as const;

/**
 * Whitelist of fields callers may pass to {@link updateTask}. The strict type
 * prevents typed callers from supplying protected fields at compile time;
 * the runtime PROTECTED_TASK_FIELDS strip below is a belt-and-suspenders
 * defense against callers using `as any` or routing through `Record<string,
 * unknown>`.
 *
 * `decisions` and `acceptanceCriteria` are typed `unknown[]` because the
 * normalization below accepts strings or partial objects and shapes them
 * into the canonical {@link Decision}/{@link AcceptanceCriterion} forms.
 */
export type TaskUpdate = {
  title?: string;
  description?: string;
  status?: TaskStatus;
  category?: string | null;
  order?: number;
  executionRecord?: string | null;
  implementationPlan?: string | null;
  tags?: string[];
  files?: string[];
  decisions?: unknown[];
  acceptanceCriteria?: unknown[];
};

/**
 * Update a task and append a history entry. Protected fields (id, projectId,
 * sequenceNumber, history, createdAt, updatedAt) are stripped before the
 * write so a malformed input cannot reassign a task across projects or
 * forge timestamps.
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task to update.
 * @param input - Partial fields to update.
 * @param overwriteArrays - When true, replace array fields instead of appending.
 * @returns The updated row.
 */
export async function updateTask(
  ctx: AuthContext,
  taskId: string,
  input: TaskUpdate,
  overwriteArrays = false,
) {
  await assertTaskAccess(taskId, ctx);

  let changes: Record<string, unknown> = { ...input };
  for (const key of PROTECTED_TASK_FIELDS) {
    if (key in changes) delete changes[key];
  }

  if (Array.isArray(changes.acceptanceCriteria)) {
    changes.acceptanceCriteria = (
      changes.acceptanceCriteria as unknown[]
    ).map((c) => {
      if (typeof c === "string") {
        return { id: crypto.randomUUID(), text: c, checked: false };
      }
      const obj = c as Record<string, unknown>;
      return {
        id: (obj.id as string) ?? crypto.randomUUID(),
        text: (obj.text as string) ?? (obj.description as string) ?? String(c),
        checked: (obj.checked as boolean) ?? false,
      };
    });
  }

  if (Array.isArray(changes.decisions)) {
    changes.decisions = (changes.decisions as unknown[]).map((d) => {
      if (typeof d === "string") {
        return {
          id: crypto.randomUUID(),
          text: d,
          date: new Date().toISOString().slice(0, 10),
          source: "refinement",
        };
      }
      const obj = d as Record<string, unknown>;
      return {
        id: (obj.id as string) ?? crypto.randomUUID(),
        text: (obj.text as string) ?? String(d),
        date: (obj.date as string) ?? new Date().toISOString().slice(0, 10),
        source: (obj.source as string) ?? "refinement",
      };
    });
  }

  changes = await formatTaskMarkdownFields(changes);

  const updated = await db.transaction(async (tx) => {
    // Re-read the row under FOR UPDATE so the merge sees the committed
    // state from any concurrent updateTask. Without the lock, two callers
    // both reading from outside the tx would compute their merged arrays
    // against the same baseline and the second write would clobber the
    // first's contribution.
    const [current] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .for("update");
    if (!current) throw new ForbiddenError("Forbidden", "task", taskId);

    if (!overwriteArrays) {
      if (Array.isArray(changes.decisions)) {
        const existing = (current.decisions ?? []) as Record<string, unknown>[];
        const incoming = changes.decisions as Record<string, unknown>[];
        const incomingIds = new Set(incoming.map((c) => c.id));
        const incomingTexts = new Set(incoming.map((c) => c.text));
        changes.decisions = [
          ...existing.filter(
            (c) => !incomingIds.has(c.id) && !incomingTexts.has(c.text),
          ),
          ...incoming,
        ];
      }
      if (Array.isArray(changes.acceptanceCriteria)) {
        const existing = (current.acceptanceCriteria ?? []) as Record<
          string,
          unknown
        >[];
        const incoming = changes.acceptanceCriteria as Record<string, unknown>[];
        const incomingIds = new Set(incoming.map((c) => c.id));
        const incomingTexts = new Set(incoming.map((c) => c.text));
        changes.acceptanceCriteria = [
          ...existing.filter(
            (c) => !incomingIds.has(c.id) && !incomingTexts.has(c.text),
          ),
          ...incoming,
        ];
      }
      if (Array.isArray(changes.files)) {
        const existing = (current.files ?? []) as string[];
        const merged = new Set([...existing, ...(changes.files as string[])]);
        changes.files = [...merged];
      }
    }

    const isStatusChange =
      "status" in changes && current.status !== changes.status;
    const entry = makeHistoryEntry({
      type: isStatusChange ? "status_change" : "refined",
      label: isStatusChange
        ? `Status: ${current.status} → ${changes.status}`
        : "Task updated",
      description: `Updated task fields: ${Object.keys(changes).join(", ")}.`,
      actor: "ai",
    });

    const [row] = await tx
      .update(tasks)
      .set({
        ...changes,
        history: sql`${tasks.history} || ${JSON.stringify([entry])}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId))
      .returning();
    return row;
  });

  notifyChange();
  return updated;
}

// ---------------------------------------------------------------------------
// Delete task
// ---------------------------------------------------------------------------

/**
 * Delete a task and remove all referencing edges.
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task to delete.
 * @returns Deletion summary.
 */
export async function deleteTask(ctx: AuthContext, taskId: string) {
  await assertTaskAccess(taskId, ctx);

  const deletedEdges = await db
    .delete(taskEdges)
    .where(
      or(
        eq(taskEdges.sourceTaskId, taskId),
        eq(taskEdges.targetTaskId, taskId),
      ),
    )
    .returning({ id: taskEdges.id });

  await db.delete(tasks).where(eq(tasks.id, taskId));

  notifyChange();
  return {
    deleted: { id: taskId },
    edgesRemoved: deletedEdges.length,
  };
}

// ---------------------------------------------------------------------------
// Delete task preview
// ---------------------------------------------------------------------------

/**
 * Preview what would be deleted without actually deleting.
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns Summary of the task and edge impact.
 */
export async function deleteTaskPreview(ctx: AuthContext, taskId: string) {
  const task = await assertTaskAccess(taskId, ctx);

  const edgeRows = await db
    .select({ id: taskEdges.id })
    .from(taskEdges)
    .where(
      or(
        eq(taskEdges.sourceTaskId, taskId),
        eq(taskEdges.targetTaskId, taskId),
      ),
    );

  return {
    task: { id: task.id, title: task.title },
    edgesRemoved: edgeRows.length,
  };
}

// ---------------------------------------------------------------------------
// Reorder task
// ---------------------------------------------------------------------------

/**
 * Update a task's order and shift siblings to make room.
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task to reorder.
 * @param newOrder - The desired order position.
 * @returns The updated task row.
 */
export async function reorderTask(
  ctx: AuthContext,
  taskId: string,
  newOrder: number,
) {
  const task = await assertTaskAccess(taskId, ctx);

  const oldOrder = task.order;
  if (oldOrder === newOrder) return task;

  if (newOrder > oldOrder) {
    await db
      .update(tasks)
      .set({ order: sql`${tasks.order} - 1` })
      .where(
        and(
          eq(tasks.projectId, task.projectId),
          gt(tasks.order, oldOrder),
          sql`${tasks.order} <= ${newOrder}`,
        ),
      );
  } else {
    await db
      .update(tasks)
      .set({ order: sql`${tasks.order} + 1` })
      .where(
        and(
          eq(tasks.projectId, task.projectId),
          gte(tasks.order, newOrder),
          lt(tasks.order, oldOrder),
        ),
      );
  }

  const [updated] = await db
    .update(tasks)
    .set({ order: newOrder, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
    .returning();

  notifyChange();
  return updated;
}
