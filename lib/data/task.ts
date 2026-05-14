import "server-only";

import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  projects,
  tasks,
  taskEdges,
  taskAssignees,
  taskAcceptanceCriteria,
  taskDecisions,
  taskLinks,
  type NewTask,
  type TaskLink,
} from "@/lib/db/schema";
import { user, member } from "@/lib/db/auth-schema";
import { acquireProjectLock } from "@/lib/db/raw/acquire-project-lock";
import { fetchTaskFull } from "@/lib/db/raw/fetch-task-full";
import type {
  AcceptanceCriterion,
  Decision,
  HistoryEntry,
  TaskStatus,
  Priority,
  Estimate,
} from "@/lib/types";
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
import type {
  AssigneeRef,
  TaskFull,
  TaskLinkRef,
  TaskSlim,
} from "@/lib/data/views";
import { emitTaskEvent } from "@/lib/realtime/events";
import { classifyLink, MalformedLinkError } from "@/lib/links/classify";

/** Drizzle transaction handle alias for the helpers in this file. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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

/**
 * Normalize a criteria input array (strings or partial objects) into the
 * canonical `AcceptanceCriterion[]` shape, minting ids where missing.
 *
 * @param input - Caller-supplied criteria array; may carry strings or
 *   partial objects with optional `id` / `text` / `description` / `checked`.
 * @returns Canonical criteria array.
 */
function normalizeCriteria(input: unknown[]): AcceptanceCriterion[] {
  return input.map((c) => {
    if (typeof c === "string") {
      return { id: crypto.randomUUID(), text: c, checked: false };
    }
    const obj = c as Record<string, unknown>;
    return {
      id: (obj.id as string) ?? crypto.randomUUID(),
      text:
        (obj.text as string) ?? (obj.description as string) ?? String(c),
      checked: (obj.checked as boolean) ?? false,
    };
  });
}

/**
 * Normalize a decisions input array (strings or partial objects) into the
 * canonical `Decision[]` shape, minting ids and defaulting `source` /
 * `date` where missing.
 *
 * @param input - Caller-supplied decisions array.
 * @returns Canonical decisions array.
 */
function normalizeDecisions(input: unknown[]): Decision[] {
  return input.map((d) => {
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
      source: ((obj.source as Decision["source"]) ?? "refinement"),
    };
  });
}

/**
 * Materialize criteria state for a task. `replace` deletes every existing
 * row and inserts the supplied set; `append` deduplicates incoming entries
 * against the existing rows by id-OR-text (matching the legacy JSONB merge
 * semantics) and upserts at the next available `position`.
 *
 * Text dedup is race-safe under concurrent appends because
 * `UNIQUE (task_id, text)` is enforced at the DB level and the upsert
 * targets that constraint — two transactions inserting the same text with
 * different ids collapse to one row with the second writer's id and
 * metadata. Position is presentation-only with no unique constraint;
 * concurrent appends may land at the same position, broken deterministically
 * by `(position, id)` on read.
 *
 * @param tx - Drizzle transaction handle.
 * @param taskId - UUID of the parent task.
 * @param incoming - Caller-supplied criteria (already normalized).
 * @param mode - `replace` truncates the existing set; `append` upserts.
 */
async function applyCriteriaWrite(
  tx: Tx,
  taskId: string,
  incoming: AcceptanceCriterion[],
  mode: "append" | "replace",
): Promise<void> {
  if (mode === "replace") {
    await tx
      .delete(taskAcceptanceCriteria)
      .where(eq(taskAcceptanceCriteria.taskId, taskId));
    if (incoming.length > 0) {
      await tx.insert(taskAcceptanceCriteria).values(
        incoming.map((c, i) => ({
          id: c.id,
          taskId,
          text: c.text,
          checked: c.checked,
          position: i,
        })),
      );
    }
    return;
  }
  if (incoming.length === 0) return;

  const incomingIds = incoming.map((c) => c.id);
  const incomingTexts = incoming.map((c) => c.text);
  await tx
    .delete(taskAcceptanceCriteria)
    .where(
      and(
        eq(taskAcceptanceCriteria.taskId, taskId),
        or(
          inArray(taskAcceptanceCriteria.id, incomingIds),
          inArray(taskAcceptanceCriteria.text, incomingTexts),
        ),
      ),
    );

  const [maxPosRow] = await tx
    .select({
      maxPos: sql<number>`COALESCE(MAX(${taskAcceptanceCriteria.position}), -1)`,
    })
    .from(taskAcceptanceCriteria)
    .where(eq(taskAcceptanceCriteria.taskId, taskId));
  const basePos = (maxPosRow?.maxPos ?? -1) + 1;

  await tx
    .insert(taskAcceptanceCriteria)
    .values(
      incoming.map((c, i) => ({
        id: c.id,
        taskId,
        text: c.text,
        checked: c.checked,
        position: basePos + i,
      })),
    )
    .onConflictDoUpdate({
      target: [taskAcceptanceCriteria.taskId, taskAcceptanceCriteria.text],
      set: {
        id: sql`EXCLUDED.id`,
        checked: sql`EXCLUDED.checked`,
        position: sql`EXCLUDED.position`,
        updatedAt: sql`NOW()`,
      },
    });
}

/**
 * Materialize decisions state for a task. Mirrors {@link applyCriteriaWrite}:
 * `replace` truncates and reinserts; `append` deduplicates by id-OR-text
 * and upserts at the next position. `UNIQUE (task_id, text)` enforces
 * race-safe text dedup at the DB level.
 *
 * @param tx - Drizzle transaction handle.
 * @param taskId - UUID of the parent task.
 * @param incoming - Caller-supplied decisions (already normalized).
 * @param mode - `replace` truncates the existing set; `append` upserts.
 */
async function applyDecisionsWrite(
  tx: Tx,
  taskId: string,
  incoming: Decision[],
  mode: "append" | "replace",
): Promise<void> {
  if (mode === "replace") {
    await tx
      .delete(taskDecisions)
      .where(eq(taskDecisions.taskId, taskId));
    if (incoming.length > 0) {
      await tx.insert(taskDecisions).values(
        incoming.map((d, i) => ({
          id: d.id,
          taskId,
          text: d.text,
          source: d.source,
          decisionDate: d.date,
          position: i,
        })),
      );
    }
    return;
  }
  if (incoming.length === 0) return;

  const incomingIds = incoming.map((d) => d.id);
  const incomingTexts = incoming.map((d) => d.text);
  await tx
    .delete(taskDecisions)
    .where(
      and(
        eq(taskDecisions.taskId, taskId),
        or(
          inArray(taskDecisions.id, incomingIds),
          inArray(taskDecisions.text, incomingTexts),
        ),
      ),
    );

  const [maxPosRow] = await tx
    .select({
      maxPos: sql<number>`COALESCE(MAX(${taskDecisions.position}), -1)`,
    })
    .from(taskDecisions)
    .where(eq(taskDecisions.taskId, taskId));
  const basePos = (maxPosRow?.maxPos ?? -1) + 1;

  await tx
    .insert(taskDecisions)
    .values(
      incoming.map((d, i) => ({
        id: d.id,
        taskId,
        text: d.text,
        source: d.source,
        decisionDate: d.date,
        position: basePos + i,
      })),
    )
    .onConflictDoUpdate({
      target: [taskDecisions.taskId, taskDecisions.text],
      set: {
        id: sql`EXCLUDED.id`,
        source: sql`EXCLUDED.source`,
        decisionDate: sql`EXCLUDED.decision_date`,
        position: sql`EXCLUDED.position`,
        updatedAt: sql`NOW()`,
      },
    });
}

/**
 * Fetch the criteria projection for a task, ordered by position.
 *
 * UNCHECKED: this function performs NO authorization. The caller must
 * assert task access first. The `Unchecked` suffix is the contract — do
 * not strip it when wrapping or re-exporting.
 *
 * @param taskId - UUID of the task.
 * @returns Ordered array of criteria (empty when none exist).
 */
export async function fetchCriteriaUnchecked(
  taskId: string,
): Promise<AcceptanceCriterion[]> {
  return db
    .select({
      id: taskAcceptanceCriteria.id,
      text: taskAcceptanceCriteria.text,
      checked: taskAcceptanceCriteria.checked,
    })
    .from(taskAcceptanceCriteria)
    .where(eq(taskAcceptanceCriteria.taskId, taskId))
    .orderBy(asc(taskAcceptanceCriteria.position));
}

/**
 * Fetch the decisions projection for a task, ordered by position. Maps
 * `decision_date` back to the public `date` field.
 *
 * UNCHECKED: caller must assert task access first.
 *
 * @param taskId - UUID of the task.
 * @returns Ordered array of decisions (empty when none exist).
 */
export async function fetchDecisionsUnchecked(
  taskId: string,
): Promise<Decision[]> {
  const rows = await db
    .select({
      id: taskDecisions.id,
      text: taskDecisions.text,
      source: taskDecisions.source,
      date: taskDecisions.decisionDate,
    })
    .from(taskDecisions)
    .where(eq(taskDecisions.taskId, taskId))
    .orderBy(asc(taskDecisions.position));
  return rows;
}

/**
 * Batch-fetch criteria keyed by task id. Mirrors {@link fetchAssigneesByTaskUnchecked}.
 *
 * UNCHECKED: caller must assert access on every supplied taskId.
 *
 * @param taskIds - UUIDs to fetch criteria for.
 * @returns Map of taskId -> AcceptanceCriterion[]; missing tasks omitted.
 */
export async function fetchCriteriaByTaskUnchecked(
  taskIds: string[],
): Promise<Map<string, AcceptanceCriterion[]>> {
  const result = new Map<string, AcceptanceCriterion[]>();
  if (taskIds.length === 0) return result;
  const rows = await db
    .select({
      taskId: taskAcceptanceCriteria.taskId,
      id: taskAcceptanceCriteria.id,
      text: taskAcceptanceCriteria.text,
      checked: taskAcceptanceCriteria.checked,
    })
    .from(taskAcceptanceCriteria)
    .where(inArray(taskAcceptanceCriteria.taskId, taskIds))
    .orderBy(asc(taskAcceptanceCriteria.position));
  for (const r of rows) {
    const list = result.get(r.taskId) ?? [];
    list.push({ id: r.id, text: r.text, checked: r.checked });
    result.set(r.taskId, list);
  }
  return result;
}

/**
 * Batch-fetch decisions keyed by task id.
 *
 * UNCHECKED: caller must assert access on every supplied taskId.
 *
 * @param taskIds - UUIDs to fetch decisions for.
 * @returns Map of taskId -> Decision[]; missing tasks omitted.
 */
export async function fetchDecisionsByTaskUnchecked(
  taskIds: string[],
): Promise<Map<string, Decision[]>> {
  const result = new Map<string, Decision[]>();
  if (taskIds.length === 0) return result;
  const rows = await db
    .select({
      taskId: taskDecisions.taskId,
      id: taskDecisions.id,
      text: taskDecisions.text,
      source: taskDecisions.source,
      date: taskDecisions.decisionDate,
    })
    .from(taskDecisions)
    .where(inArray(taskDecisions.taskId, taskIds))
    .orderBy(asc(taskDecisions.position));
  for (const r of rows) {
    const list = result.get(r.taskId) ?? [];
    list.push({ id: r.id, text: r.text, source: r.source, date: r.date });
    result.set(r.taskId, list);
  }
  return result;
}

/**
 * SQL expression: `hasCriteria` boolean as a correlated `EXISTS` semi-join
 * keyed on `(task_id, position)`. Postgres short-circuits on the first
 * matching row per task — no global `GROUP BY` scan of the child table.
 *
 * Factory: returns a fresh expression each call so drizzle's planner
 * always reconstructs the SQL fragment within the enclosing query scope
 * (avoids stale binding from module-level reuse).
 *
 * Inline at SELECT sites: `hasCriteria: hasCriteriaExpr()`.
 */
export function hasCriteriaExpr() {
  return sql<boolean>`EXISTS (SELECT 1 FROM "task_acceptance_criteria" "tac" WHERE "tac"."task_id" = "tasks"."id")`;
}

// ---------------------------------------------------------------------------
// Single-entity queries
// ---------------------------------------------------------------------------

/**
 * Fetch the full task row plus the composed `taskRef`, assignees, criteria,
 * decisions, and links. Membership-gated.
 *
 * Single round-trip: a raw SQL query joins `tasks` to `projects` and folds
 * `task_assignees`, `task_acceptance_criteria`, `task_decisions`, and
 * `task_links` into JSON-aggregated subqueries. Replaces the previous
 * three-query approach (`assertTaskAccess` row + `projects` lookup +
 * parallel assignees/links fetches) that became necessary once
 * criteria/decisions moved out of the `tasks` row in MYMR-136.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns Full task row with composed `taskRef`, assignees, criteria,
 *   decisions, and links.
 * @throws ForbiddenError when the caller is not a member of the task's team.
 */
export async function getTaskFull(
  ctx: AuthContext,
  taskId: string,
): Promise<TaskFull> {
  await assertTaskAccess(taskId, ctx);
  const rows = await fetchTaskFull(db, taskId);
  if (rows.length === 0) {
    throw new Error(
      `getTaskFull: task ${taskId} disappeared after access check`,
    );
  }
  const r = rows[0];
  const taskRef = composeTaskRef(
    asIdentifier(r.project_identifier),
    r.sequence_number,
  );
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    sequenceNumber: r.sequence_number,
    description: r.description,
    status: r.status as TaskStatus,
    order: r.order,
    category: r.category,
    implementationPlan: r.implementation_plan,
    executionRecord: r.execution_record,
    tags: r.tags ?? [],
    priority: r.priority as Priority | null,
    estimate: r.estimate as Estimate | null,
    files: r.files ?? [],
    history: (r.history ?? []) as HistoryEntry[],
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at),
    taskRef,
    assignees: r.assignees ?? [],
    acceptanceCriteria: r.acceptance_criteria ?? [],
    decisions: (r.decisions ?? []).map((d) => ({
      ...d,
      source: d.source as Decision["source"],
    })),
    links: (r.links ?? []).map((l) => ({
      id: l.id,
      kind: l.kind,
      url: l.url,
      label: l.label,
      createdAt: new Date(l.createdAt),
    })),
  };
}

/**
 * Fetch the assignee projection (userId + name + email) for a task,
 * joined to `neon_auth.user` and ordered by name.
 *
 * UNCHECKED: this function performs NO authorization. The caller is
 * responsible for asserting task access (`assertTaskAccess`) before
 * invoking. Calling without an upstream check leaks assignee identity
 * cross-team. The `Unchecked` suffix is the contract — do not strip
 * it when wrapping or re-exporting.
 *
 * @param taskId - UUID of the task.
 * @returns Ordered array of assignee refs (empty when nobody is assigned).
 */
export async function fetchAssigneesUnchecked(taskId: string): Promise<AssigneeRef[]> {
  return db
    .select({
      userId: taskAssignees.userId,
      name: user.name,
      email: user.email,
    })
    .from(taskAssignees)
    .innerJoin(user, eq(user.id, taskAssignees.userId))
    .where(eq(taskAssignees.taskId, taskId))
    .orderBy(asc(user.name));
}

/**
 * Fetch assignee projections for a batch of task ids. Returns a map
 * keyed by taskId for easy zipping with a parallel task list.
 *
 * UNCHECKED: this function performs NO authorization. The caller is
 * responsible for asserting access on every supplied taskId (typically
 * via `assertProjectAccess` on the parent project) before invoking.
 * Calling without an upstream check leaks assignee identity cross-team.
 * The `Unchecked` suffix is the contract — do not strip it when
 * wrapping or re-exporting.
 *
 * @param taskIds - UUIDs to fetch assignees for.
 * @returns Map of taskId -> AssigneeRef[]; missing tasks omitted.
 */
export async function fetchAssigneesByTaskUnchecked(
  taskIds: string[],
): Promise<Map<string, AssigneeRef[]>> {
  const result = new Map<string, AssigneeRef[]>();
  if (taskIds.length === 0) return result;
  const rows = await db
    .select({
      taskId: taskAssignees.taskId,
      userId: taskAssignees.userId,
      name: user.name,
      email: user.email,
    })
    .from(taskAssignees)
    .innerJoin(user, eq(user.id, taskAssignees.userId))
    .where(sql`${taskAssignees.taskId} IN ${taskIds}`)
    .orderBy(asc(user.name));
  for (const r of rows) {
    const list = result.get(r.taskId) ?? [];
    list.push({ userId: r.userId, name: r.name, email: r.email });
    result.set(r.taskId, list);
  }
  return result;
}

/**
 * Fetch the link projection (id, kind, url, label, createdAt) for a task,
 * ordered by createdAt ascending.
 *
 * UNCHECKED: this function performs NO authorization. The caller is
 * responsible for asserting task access (`assertTaskAccess`) before
 * invoking. The `Unchecked` suffix is the contract — do not strip it
 * when wrapping or re-exporting.
 *
 * @param taskId - UUID of the task.
 * @returns Ordered array of link refs (empty when no links exist).
 */
export async function fetchLinksUnchecked(taskId: string): Promise<TaskLinkRef[]> {
  return db
    .select({
      id: taskLinks.id,
      kind: taskLinks.kind,
      url: taskLinks.url,
      label: taskLinks.label,
      createdAt: taskLinks.createdAt,
    })
    .from(taskLinks)
    .where(eq(taskLinks.taskId, taskId))
    .orderBy(asc(taskLinks.createdAt));
}

/**
 * SQL expression: `assigneeCount` as a correlated `COUNT(*)` keyed on the
 * `(task_id, user_id)` PK leading column. Per-row scalar subquery; the
 * planner uses an index-only count.
 *
 * Factory: returns a fresh expression each call. See {@link hasCriteriaExpr}.
 */
export function assigneeCountExpr() {
  return sql<number>`(SELECT COUNT(*) FROM "task_assignees" "ta_ac" WHERE "ta_ac"."task_id" = "tasks"."id")::int`;
}

/**
 * SQL expression: `assigneeUserIds` as a correlated `array_agg` keyed on
 * the `(task_id, user_id)` PK. Returns an empty `uuid[]` when no assignees
 * exist — never `NULL` — so callers can iterate without a null guard.
 *
 * Factory: returns a fresh expression each call. See {@link hasCriteriaExpr}.
 */
export function assigneeUserIdsExpr() {
  return sql<string[]>`COALESCE((SELECT array_agg("ta_au"."user_id" ORDER BY "ta_au"."user_id") FROM "task_assignees" "ta_au" WHERE "ta_au"."task_id" = "tasks"."id"), '{}'::uuid[])`;
}

/**
 * Fetch the slim task view for listing surfaces. Issues a slim projection
 * with an `assigneeCountSubquery` LEFT JOIN; does not pull criteria,
 * decisions, history, files, or links — listing surfaces never render
 * those fields and the bandwidth saving is meaningful on the workspace
 * canvas and search-result paths.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns Slim task view.
 * @throws ForbiddenError when the caller is not a member of the task's team.
 */
export async function getTaskSlim(
  ctx: AuthContext,
  taskId: string,
): Promise<TaskSlim> {
  await assertTaskAccess(taskId, ctx);
  const [row] = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      tags: tasks.tags,
      category: tasks.category,
      priority: tasks.priority,
      estimate: tasks.estimate,
      order: tasks.order,
      sequenceNumber: tasks.sequenceNumber,
      identifier: projects.identifier,
      assigneeCount: assigneeCountExpr(),
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!row) {
    throw new ForbiddenError("Forbidden", "task", taskId);
  }
  return {
    id: row.id,
    taskRef: composeTaskRef(asIdentifier(row.identifier), row.sequenceNumber),
    title: row.title,
    status: row.status,
    tags: row.tags,
    category: row.category,
    priority: row.priority,
    estimate: row.estimate,
    assigneeCount: row.assigneeCount,
    order: row.order,
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
      priority: tasks.priority,
      estimate: tasks.estimate,
      order: tasks.order,
      sequenceNumber: tasks.sequenceNumber,
      assigneeCount: assigneeCountExpr(),
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
    priority: t.priority,
    estimate: t.estimate,
    assigneeCount: t.assigneeCount,
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
  | "in_review"
  | "ready"
  | "plannable"
  | "blocked"
  | "draft";

/** Slim shape needed to derive a state — matches what the slim payload
 *  carries, so the server can compute states without re-fetching `description`
 *  and `acceptanceCriteria` columns just to recompute trim+length. */
export type TaskStateInput = {
  id: string;
  status: string;
  hasDescription: boolean;
  hasCriteria: boolean;
};

/**
 * Derive the actionable state for a single task using effective deps.
 *
 * Cancelled tasks short-circuit. For active tasks the dep set is the
 * *effective* one — cancelled middles are walked through, and the wall is
 * the next non-cancelled prerequisite.
 *
 * Iron-law gate: both `plannable` and `ready` require every effective dep
 * to be `done`. A draft becomes `plannable` only when its prerequisites
 * have actually shipped — we don't plan against unshipped interfaces because
 * the propagation rules in `lifecycle.md` only hold for shipped work.
 *
 * @param task - Slim shape: id, status, plus pre-computed
 *   `hasDescription` / `hasCriteria` booleans the slim payload already
 *   carries (avoids re-fetching the heavy text columns).
 * @param graph - Effective dependency graph for the project.
 * @returns Derived TaskState.
 */
function deriveTaskState(
  task: TaskStateInput,
  graph: {
    activeTasks: Map<string, { status: string }>;
    effectiveDeps: Map<string, Set<string>>;
  },
): TaskState {
  if (task.status === "done") return "done";
  if (task.status === "cancelled") return "cancelled";
  if (task.status === "in_progress") return "in_progress";
  if (task.status === "in_review") return "in_review";

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

  return task.hasDescription && task.hasCriteria ? "plannable" : "draft";
}

/**
 * Batch state derivation against the slim payload shape — the path the UI
 * fetches via `getProjectGraphSlim`. Avoids selecting `description` and
 * `acceptanceCriteria` from the database just to compute boolean flags;
 * the slim query already projects them.
 *
 * @param projectId - UUID of the project.
 * @param taskSubset - Tasks in `TaskStateInput` shape.
 * @returns Map of taskId → TaskState.
 */
export async function deriveTaskStatesSlim(
  projectId: string,
  taskSubset: TaskStateInput[],
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
  priority: Priority | null;
  estimate: Estimate | null;
  assigneeCount: number;
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

  // Push relevance ranking + LIMIT 20 into SQL so the DB never returns a
  // multi-thousand-row match set for a project the planner could trim
  // upstream. The CASE bands mirror the previous JS sort exactly.
  const lower = trimmedQuery.toLowerCase();
  const rankExpr =
    trimmedQuery.length > 0
      ? sql<number>`CASE
          WHEN LOWER(${tasks.title}) = ${lower} THEN 0
          WHEN LOWER(${tasks.title}) LIKE ${lower + "%"} THEN 1
          WHEN LOWER(${tasks.title}) LIKE ${"%" + lower + "%"} THEN 2
          ELSE 3
        END`
      : sql<number>`0`;

  const trimmed = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      tags: tasks.tags,
      category: tasks.category,
      priority: tasks.priority,
      estimate: tasks.estimate,
      hasDescription: sql<boolean>`length(btrim(${tasks.description})) > 0`,
      hasCriteria: hasCriteriaExpr(),
      sequenceNumber: tasks.sequenceNumber,
      order: tasks.order,
      assigneeCount: assigneeCountExpr(),
    })
    .from(tasks)
    .where(and(...clauses))
    .orderBy(rankExpr, asc(tasks.order))
    .limit(20);
  const stateMap = await deriveTaskStatesSlim(
    projectId,
    trimmed.map((t) => ({
      id: t.id,
      status: t.status,
      hasDescription: t.hasDescription,
      hasCriteria: t.hasCriteria,
    })),
  );

  const identifier = asIdentifier(project.identifier);
  return enrichWithTaskRef(trimmed, identifier).map((t) => ({
    id: t.id,
    taskRef: t.taskRef,
    title: t.title,
    status: t.status,
    state: stateMap.get(t.id) ?? "draft",
    tags: t.tags,
    category: t.category,
    priority: t.priority,
    estimate: t.estimate,
    assigneeCount: t.assigneeCount,
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
      priority: tasks.priority,
      estimate: tasks.estimate,
      hasDescription: sql<boolean>`length(btrim(${tasks.description})) > 0`,
      hasCriteria: hasCriteriaExpr(),
      sequenceNumber: tasks.sequenceNumber,
      order: tasks.order,
      assigneeCount: assigneeCountExpr(),
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

  const stateMap = await deriveTaskStatesSlim(
    projectId,
    trimmed.map((t) => ({
      id: t.id,
      status: t.status,
      hasDescription: t.hasDescription,
      hasCriteria: t.hasCriteria,
    })),
  );
  const identifier = asIdentifier(project.identifier);
  const rows = enrichWithTaskRef(trimmed, identifier).map((t) => ({
    id: t.id,
    taskRef: t.taskRef,
    title: t.title,
    status: t.status,
    state: stateMap.get(t.id) ?? ("draft" as const),
    tags: t.tags,
    category: t.category,
    priority: t.priority,
    estimate: t.estimate,
    assigneeCount: t.assigneeCount,
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
export type CreateTaskInput = Omit<NewTask, "id" | "sequenceNumber"> & {
  /**
   * Optional initial assignee user ids. Each must be a member of the
   * project's owning team; the data layer rejects non-members. Order
   * within the array is not preserved (the junction has no ordering
   * column).
   */
  assigneeIds?: string[];
  /**
   * Optional PR URL. Sugar: upserts a `task_links` row with kind derived
   * from {@link classifyLink} inside the same transaction as the task
   * insert. Not a column on `tasks`; stripped before the typed insert.
   */
  prUrl?: string | null;
  /**
   * Optional initial acceptance criteria. After MYMR-136 these live in
   * `task_acceptance_criteria`, not on `tasks`. The field is accepted on
   * input so the restore path (`StructureView.tsx`) and MCP create handler
   * can pass strings or partial objects; the data layer normalizes and
   * writes the child table inside the same transaction. Stripped before
   * the typed insert into `tasks`.
   */
  acceptanceCriteria?: unknown[];
  /**
   * Optional initial decisions. Parallel of `acceptanceCriteria` — accepts
   * strings or partial `Decision` shapes, normalized and written to
   * `task_decisions` inside the same transaction. Stripped before the
   * typed insert into `tasks`.
   */
  decisions?: unknown[];
};

/**
 * Verify every supplied user id is a member of the given project's
 * owning team. Run inside the same transaction as the assignee write
 * so a concurrent membership revoke cannot slip past.
 *
 * @param tx - Drizzle transaction handle.
 * @param projectId - UUID of the project the task belongs to.
 * @param userIds - Caller-supplied assignee ids.
 * @throws ForbiddenError naming the first non-member id.
 */
async function assertAssigneesInTeam(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  projectId: string,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const [proj] = await tx
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!proj) throw new ProjectNotFoundError(projectId);
  const dedup = [...new Set(userIds)];
  const rows = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.organizationId, proj.organizationId),
        sql`${member.userId} IN ${dedup}`,
      ),
    );
  const found = new Set(rows.map((r) => r.userId));
  const missing = dedup.find((id) => !found.has(id));
  if (missing) {
    throw new ForbiddenError(
      `User '${missing}' is not a member of the task's team.`,
      "team",
      missing,
    );
  }
}

/**
 * Materialize assignee state for a task. `replace` deletes existing
 * rows and inserts the supplied set; `append` adds the supplied ids
 * without touching existing rows (no-op duplicates via
 * `onConflictDoNothing`). Caller must have already verified team
 * membership for the supplied ids.
 *
 * @param tx - Drizzle transaction handle.
 * @param taskId - UUID of the task.
 * @param incoming - Caller-supplied user ids.
 * @param mode - `append` (default) or `replace`.
 */
async function setTaskAssignees(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  taskId: string,
  incoming: string[],
  mode: "append" | "replace",
): Promise<void> {
  const dedup = [...new Set(incoming)];
  if (mode === "replace") {
    await tx.delete(taskAssignees).where(eq(taskAssignees.taskId, taskId));
    if (dedup.length > 0) {
      await tx
        .insert(taskAssignees)
        .values(dedup.map((userId) => ({ taskId, userId })));
    }
    return;
  }
  if (dedup.length === 0) return;
  await tx
    .insert(taskAssignees)
    .values(dedup.map((userId) => ({ taskId, userId })))
    .onConflictDoNothing();
}

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

  const normalizedCriteria = Array.isArray(data.acceptanceCriteria)
    ? normalizeCriteria(data.acceptanceCriteria)
    : undefined;
  const normalizedDecisions = Array.isArray(data.decisions)
    ? normalizeDecisions(data.decisions)
    : undefined;

  // formatTaskMarkdownFields walks acceptanceCriteria/decisions when present,
  // so feed it the normalized arrays before the split so the text-format pass
  // still runs on every criterion / decision body.
  const formatInput: Record<string, unknown> = { ...data };
  if (normalizedCriteria) formatInput.acceptanceCriteria = normalizedCriteria;
  if (normalizedDecisions) formatInput.decisions = normalizedDecisions;
  const formatted = await formatTaskMarkdownFields(formatInput);

  const formattedCriteria = Array.isArray(formatted.acceptanceCriteria)
    ? (formatted.acceptanceCriteria as AcceptanceCriterion[])
    : undefined;
  const formattedDecisions = Array.isArray(formatted.decisions)
    ? (formatted.decisions as Decision[])
    : undefined;

  // acceptanceCriteria, decisions, assigneeIds, and prUrl are not columns on
  // `tasks`; strip before the typed insert so the row spread does not poison
  // the values clause. Junction / child-table writes happen later inside the
  // same transaction.
  const {
    assigneeIds,
    prUrl,
    acceptanceCriteria: _ac,
    decisions: _dec,
    ...taskFields
  } = formatted as CreateTaskInput;
  void _ac;
  void _dec;

  if (typeof prUrl === "string") {
    try {
      classifyLink(prUrl);
    } catch (e) {
      if (e instanceof MalformedLinkError) {
        throw new ForbiddenError("Invalid prUrl", "task", data.projectId);
      }
      throw e;
    }
  }

  const result = await db.transaction(async (tx) => {
    await acquireProjectLock(tx, taskFields.projectId);

    const [proj] = await tx
      .select({ identifier: projects.identifier })
      .from(projects)
      .where(eq(projects.id, taskFields.projectId));
    if (!proj) throw new ProjectNotFoundError(taskFields.projectId);

    const [maxRow] = await tx
      .select({
        maxOrder: sql<number>`COALESCE(MAX(${tasks.order}), -1)`,
        maxSeq: sql<number>`COALESCE(MAX(${tasks.sequenceNumber}), 0)`,
      })
      .from(tasks)
      .where(eq(tasks.projectId, taskFields.projectId));

    const sequenceNumber = (maxRow?.maxSeq ?? 0) + 1;
    const order =
      taskFields.order === undefined || taskFields.order === 0
        ? (maxRow?.maxOrder ?? -1) + 1
        : taskFields.order;

    const [task] = await tx
      .insert(tasks)
      .values({
        ...taskFields,
        order,
        sequenceNumber,
        history: [
          makeHistoryEntry({
            type: "created",
            label: "Task created",
            description: `Task "${taskFields.title}" created.`,
            actor: "ai",
          }),
        ],
      })
      .returning();

    if (assigneeIds && assigneeIds.length > 0) {
      await assertAssigneesInTeam(tx, taskFields.projectId, assigneeIds);
      await setTaskAssignees(tx, task.id, assigneeIds, "replace");
    }

    if (formattedCriteria && formattedCriteria.length > 0) {
      await applyCriteriaWrite(tx, task.id, formattedCriteria, "replace");
    }
    if (formattedDecisions && formattedDecisions.length > 0) {
      await applyDecisionsWrite(tx, task.id, formattedDecisions, "replace");
    }

    if (typeof prUrl === "string" && prUrl.length > 0) {
      const classified = classifyLink(prUrl);
      await tx
        .insert(taskLinks)
        .values({
          taskId: task.id,
          kind: classified.kind,
          url: classified.url,
          label: classified.label,
          createdBy: ctx.userId,
        })
        .onConflictDoNothing({
          target: [taskLinks.taskId, taskLinks.url],
        });
    }

    return {
      id: task.id,
      title: task.title,
      projectId: task.projectId,
      order: task.order,
      sequenceNumber: task.sequenceNumber,
      taskRef: composeTaskRef(asIdentifier(proj.identifier), task.sequenceNumber),
    };
  });

  emitTaskEvent(result.projectId, result.id);
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
  priority?: Priority | null;
  estimate?: Estimate | null;
  order?: number;
  executionRecord?: string | null;
  implementationPlan?: string | null;
  tags?: string[];
  files?: string[];
  decisions?: unknown[];
  acceptanceCriteria?: unknown[];
  assigneeIds?: string[];
  /**
   * Sugar field: upserts a `task_links` row with kind derived from
   * {@link classifyLink}. `null` deletes any existing `pull_request` link
   * on this task. `undefined` (omitted) leaves links untouched. Not a
   * column on `tasks`; stripped before the typed row update.
   */
  prUrl?: string | null;
};

/** Update result enriches the raw `Task` row with the post-write criteria
 * and decisions so callers that consult them (e.g. tool-handlers'
 * completion-protocol hint checks) see the same shape they saw on the
 * JSONB-storage path. Empty arrays when none exist; the fields are still
 * always present on a non-no-op update. */
export type UpdateTaskResult = typeof tasks.$inferSelect & {
  acceptanceCriteria: AcceptanceCriterion[];
  decisions: Decision[];
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
 * @returns The updated row with post-write criteria and decisions joined in.
 *   On a pure no-op (assigneeIds=[] in append mode and nothing else),
 *   criteria/decisions still come from the live tables.
 */
export async function updateTask(
  ctx: AuthContext,
  taskId: string,
  input: TaskUpdate,
  overwriteArrays = false,
): Promise<UpdateTaskResult> {
  await assertTaskAccess(taskId, ctx);

  let changes: Record<string, unknown> = { ...input };
  for (const key of PROTECTED_TASK_FIELDS) {
    if (key in changes) delete changes[key];
  }
  // assigneeIds writes the junction table, not the tasks row. Pull it
  // out so the typed `tx.update(tasks).set(...)` does not see an
  // unknown column. Empty array in append mode is a definitional no-op
  // (matches decisions/files merge semantics: empty incoming ↦
  // unchanged), so normalize to `undefined` and skip both the junction
  // write and the history-description entry below.
  const rawAssigneeIds =
    "assigneeIds" in changes ? (changes.assigneeIds as string[]) : undefined;
  delete changes.assigneeIds;
  const assigneeIds =
    rawAssigneeIds !== undefined &&
    rawAssigneeIds.length === 0 &&
    !overwriteArrays
      ? undefined
      : rawAssigneeIds;

  // prUrl writes the `task_links` junction, not the tasks row. Pull it
  // out so the typed update never sees it. `undefined` ↦ no link write,
  // `null` ↦ delete pull_request links, string ↦ upsert.
  const hasPrUrl = "prUrl" in changes;
  const prUrl = hasPrUrl ? (changes.prUrl as string | null) : undefined;
  delete changes.prUrl;
  if (hasPrUrl && typeof prUrl === "string") {
    try {
      classifyLink(prUrl);
    } catch (e) {
      if (e instanceof MalformedLinkError) {
        throw new ForbiddenError("Invalid prUrl", "task", taskId);
      }
      throw e;
    }
  }

  // acceptanceCriteria and decisions write child tables, not the tasks row.
  // Pull them out before the typed update; normalize for downstream writes.
  const rawCriteria =
    "acceptanceCriteria" in changes
      ? (changes.acceptanceCriteria as unknown[])
      : undefined;
  delete changes.acceptanceCriteria;
  const rawDecisions =
    "decisions" in changes ? (changes.decisions as unknown[]) : undefined;
  delete changes.decisions;
  const normalizedCriteria = rawCriteria
    ? normalizeCriteria(rawCriteria)
    : undefined;
  const normalizedDecisions = rawDecisions
    ? normalizeDecisions(rawDecisions)
    : undefined;

  // Markdown-format the criteria/decisions text alongside the row's own
  // text fields so the formatter still runs on every body.
  const formatInput: Record<string, unknown> = { ...changes };
  if (normalizedCriteria) formatInput.acceptanceCriteria = normalizedCriteria;
  if (normalizedDecisions) formatInput.decisions = normalizedDecisions;
  const formatted = await formatTaskMarkdownFields(formatInput);
  const formattedCriteria = Array.isArray(formatted.acceptanceCriteria)
    ? (formatted.acceptanceCriteria as AcceptanceCriterion[])
    : undefined;
  const formattedDecisions = Array.isArray(formatted.decisions)
    ? (formatted.decisions as Decision[])
    : undefined;
  changes = { ...formatted };
  delete changes.acceptanceCriteria;
  delete changes.decisions;

  let wasNoOp = false;
  const updated = await db.transaction(async (tx) => {
    // After MYMR-136 the row-level INSERT/UPDATE/DELETE on the child tables
    // is atomic per row via MVCC + ON CONFLICT (id) DO UPDATE, so the old
    // `FOR UPDATE` row lock that serialized concurrent merges is no longer
    // required. A plain SELECT is sufficient for the no-op short-circuit
    // and the history-row baseline.
    const [current] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));
    if (!current) throw new ForbiddenError("Forbidden", "task", taskId);

    // After normalization above, an `assigneeIds: []` in default-append
    // mode collapses to `assigneeIds === undefined`. If that was the
    // only field on the call AND nothing else needs writing (no
    // assignee write, no prUrl write, no criteria/decisions write), the
    // call is a pure no-op: skip the tasks-row bump, the empty history
    // entry, and the downstream realtime emit.
    if (
      Object.keys(changes).length === 0 &&
      assigneeIds === undefined &&
      !hasPrUrl &&
      formattedCriteria === undefined &&
      formattedDecisions === undefined
    ) {
      wasNoOp = true;
      return current;
    }

    if (!overwriteArrays && Array.isArray(changes.files)) {
      const existing = (current.files ?? []) as string[];
      const merged = new Set([...existing, ...(changes.files as string[])]);
      changes.files = [...merged];
    }

    const isStatusChange =
      "status" in changes && current.status !== changes.status;
    const fieldList = [
      ...Object.keys(changes),
      ...(assigneeIds !== undefined ? ["assigneeIds"] : []),
      ...(formattedCriteria !== undefined ? ["acceptanceCriteria"] : []),
      ...(formattedDecisions !== undefined ? ["decisions"] : []),
      ...(hasPrUrl ? ["prUrl"] : []),
    ];
    const entry = makeHistoryEntry({
      type: isStatusChange ? "status_change" : "refined",
      label: isStatusChange
        ? `Status: ${current.status} → ${changes.status}`
        : "Task updated",
      description: `Updated task fields: ${fieldList.join(", ")}.`,
      actor: "ai",
    });

    let row = current;
    if (Object.keys(changes).length > 0) {
      const [updatedRow] = await tx
        .update(tasks)
        .set({
          ...changes,
          history: sql`${tasks.history} || ${JSON.stringify([entry])}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId))
        .returning();
      row = updatedRow;
    } else {
      // No `tasks` row column changed; still append the history entry and
      // bump updated_at so the cache validator advances on this turn.
      const [updatedRow] = await tx
        .update(tasks)
        .set({
          history: sql`${tasks.history} || ${JSON.stringify([entry])}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId))
        .returning();
      row = updatedRow;
    }

    if (formattedCriteria !== undefined) {
      await applyCriteriaWrite(
        tx,
        taskId,
        formattedCriteria,
        overwriteArrays ? "replace" : "append",
      );
    }
    if (formattedDecisions !== undefined) {
      await applyDecisionsWrite(
        tx,
        taskId,
        formattedDecisions,
        overwriteArrays ? "replace" : "append",
      );
    }

    if (assigneeIds !== undefined) {
      await assertAssigneesInTeam(tx, current.projectId, assigneeIds);
      await setTaskAssignees(
        tx,
        taskId,
        assigneeIds,
        overwriteArrays ? "replace" : "append",
      );
    }

    if (hasPrUrl) {
      if (typeof prUrl !== "string" || prUrl.length === 0) {
        await tx
          .delete(taskLinks)
          .where(
            and(eq(taskLinks.taskId, taskId), eq(taskLinks.kind, "pull_request")),
          );
      } else {
        const classified = classifyLink(prUrl);
        await tx
          .insert(taskLinks)
          .values({
            taskId,
            kind: classified.kind,
            url: classified.url,
            label: classified.label,
            createdBy: ctx.userId,
          })
          .onConflictDoNothing({
            target: [taskLinks.taskId, taskLinks.url],
          });
      }
    }
    return row;
  });

  // Reflect a prUrl- or criteria/decisions-only call (no other field
  // changes) as a meaningful realtime event so detail surfaces see the
  // change arrive.
  if (
    !wasNoOp ||
    hasPrUrl ||
    formattedCriteria !== undefined ||
    formattedDecisions !== undefined
  ) {
    emitTaskEvent(updated.projectId, taskId);
  }
  // Surface the post-update criteria/decisions on the returned row so
  // callers that read `result.acceptanceCriteria` / `result.decisions`
  // (e.g. tool-handlers' completion-protocol hint checks on status
  // transitions to done/in_review/cancelled) see the freshest state.
  //
  // Skip both fetches when this update neither wrote a child table nor
  // changed status. A pure title/description/tags/files update has no
  // consumer of the post-state criteria, so paying two RTTs there is
  // waste on every refinement call.
  const wroteChildren =
    formattedCriteria !== undefined || formattedDecisions !== undefined;
  const statusChanged = typeof input.status === "string";
  const refetchNeeded = wroteChildren || statusChanged;
  const [postCriteria, postDecisions] = refetchNeeded
    ? await Promise.all([
        fetchCriteriaUnchecked(taskId),
        fetchDecisionsUnchecked(taskId),
      ])
    : [[], []];
  return Object.assign(updated, {
    acceptanceCriteria: postCriteria,
    decisions: postDecisions,
  });
}

// ---------------------------------------------------------------------------
// Delete task
// ---------------------------------------------------------------------------

/**
 * Delete a task and remove all referencing edges.
 *
 * Bumps the parent project's `updated_at` after the deletion so the
 * conditional-GET validator (`max(updated_at)` across project + tasks +
 * edges) strictly increases. Without this, deleting the most-recently
 * touched task would shrink the validator and produce a spurious 304 on
 * the next graph fetch — the UI would never see the deletion land. The
 * three writes run in a single transaction so concurrent readers either
 * see the pre- or post-delete state, never an in-between.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task to delete.
 * @returns Deletion summary.
 */
export async function deleteTask(ctx: AuthContext, taskId: string) {
  const task = await assertTaskAccess(taskId, ctx);

  const deletedEdges = await db.transaction(async (tx) => {
    const removed = await tx
      .delete(taskEdges)
      .where(
        or(
          eq(taskEdges.sourceTaskId, taskId),
          eq(taskEdges.targetTaskId, taskId),
        ),
      )
      .returning({ id: taskEdges.id });

    await tx.delete(tasks).where(eq(tasks.id, taskId));

    await tx
      .update(projects)
      .set({ updatedAt: new Date() })
      .where(eq(projects.id, task.projectId));

    return removed;
  });

  emitTaskEvent(task.projectId, taskId);
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
// Task links (add / remove)
// ---------------------------------------------------------------------------

/**
 * Add a URL to the task's links. Membership-gated; the URL is parsed by
 * {@link classifyLink} so the same kind/label derivation feeds the UI
 * path and the MCP `prUrl` sugar path. Idempotent: a second add of the
 * same URL on the same task returns the existing row.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @param url - URL to attach.
 * @returns The new link row, or the existing row when the URL was a duplicate.
 * @throws {ForbiddenError} When the caller cannot access the task or the URL is malformed.
 */
export async function addTaskLink(
  ctx: AuthContext,
  taskId: string,
  url: string,
): Promise<TaskLink> {
  const task = await assertTaskAccess(taskId, ctx);
  let classified;
  try {
    classified = classifyLink(url);
  } catch (e) {
    if (e instanceof MalformedLinkError) {
      throw new ForbiddenError("Invalid url", "task", taskId);
    }
    throw e;
  }

  const result = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(taskLinks)
      .values({
        taskId,
        kind: classified.kind,
        url: classified.url,
        label: classified.label,
        createdBy: ctx.userId,
      })
      .onConflictDoNothing({
        target: [taskLinks.taskId, taskLinks.url],
      })
      .returning();

    let row = inserted;
    if (!row) {
      // Conflict: surface the existing row so the UI shows the duplicate
      // gracefully instead of toggling between empty and present states.
      const [existing] = await tx
        .select()
        .from(taskLinks)
        .where(and(eq(taskLinks.taskId, taskId), eq(taskLinks.url, classified.url)))
        .limit(1);
      if (!existing) throw new Error("Link insert reported conflict but no row exists");
      row = existing;
    }

    await tx
      .update(tasks)
      .set({ updatedAt: new Date() })
      .where(eq(tasks.id, taskId));
    return row;
  });

  emitTaskEvent(task.projectId, taskId);
  return result;
}

/**
 * Remove a single link by id. Access is checked via the link's parent
 * task; the caller does not need to pass the taskId. Missing link ids
 * surface as `ForbiddenError` to avoid enumerating link ids cross-team.
 *
 * @param ctx - Resolved auth context.
 * @param linkId - UUID of the `task_links` row to remove.
 * @returns The id of the deleted link.
 * @throws {ForbiddenError} When the link is missing or the caller cannot access the parent task.
 */
export async function removeTaskLink(
  ctx: AuthContext,
  linkId: string,
): Promise<{ id: string }> {
  const [link] = await db
    .select()
    .from(taskLinks)
    .where(eq(taskLinks.id, linkId))
    .limit(1);
  if (!link) throw new ForbiddenError("Forbidden", "task", linkId);
  const task = await assertTaskAccess(link.taskId, ctx);

  await db.transaction(async (tx) => {
    await tx.delete(taskLinks).where(eq(taskLinks.id, linkId));
    await tx
      .update(tasks)
      .set({ updatedAt: new Date() })
      .where(eq(tasks.id, link.taskId));
  });

  emitTaskEvent(task.projectId, link.taskId);
  return { id: linkId };
}

/**
 * Update a link's URL in place. Re-classifies the new URL so `kind` and
 * `label` reflect the new shape; preserves `id`, `createdAt`, `createdBy`,
 * and `metadata` so the audit trail survives an edit. Same access gate
 * as {@link removeTaskLink}: missing or cross-team `linkId` surfaces as
 * `ForbiddenError`. A new URL that collides with another link on the
 * same task raises `ForbiddenError` (mapped from the unique constraint
 * pre-check) so the UI can flash a duplicate-link message.
 *
 * @param ctx - Resolved auth context.
 * @param linkId - UUID of the `task_links` row to update.
 * @param url - New URL for the link.
 * @returns The updated link row.
 * @throws {ForbiddenError} When the link is missing, the caller cannot
 *   access the parent task, the URL is malformed, or the new URL collides
 *   with another link on the same task.
 */
export async function updateTaskLink(
  ctx: AuthContext,
  linkId: string,
  url: string,
): Promise<TaskLink> {
  const [link] = await db
    .select()
    .from(taskLinks)
    .where(eq(taskLinks.id, linkId))
    .limit(1);
  if (!link) throw new ForbiddenError("Forbidden", "task", linkId);
  const task = await assertTaskAccess(link.taskId, ctx);

  let classified;
  try {
    classified = classifyLink(url);
  } catch (e) {
    if (e instanceof MalformedLinkError) {
      throw new ForbiddenError("Invalid url", "task", link.taskId);
    }
    throw e;
  }

  if (classified.url !== link.url) {
    const [conflict] = await db
      .select({ id: taskLinks.id })
      .from(taskLinks)
      .where(
        and(
          eq(taskLinks.taskId, link.taskId),
          eq(taskLinks.url, classified.url),
          ne(taskLinks.id, linkId),
        ),
      )
      .limit(1);
    if (conflict) {
      throw new ForbiddenError("Duplicate url", "task", link.taskId);
    }
  }

  const result = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(taskLinks)
      .set({
        kind: classified.kind,
        url: classified.url,
        label: classified.label,
      })
      .where(eq(taskLinks.id, linkId))
      .returning();
    await tx
      .update(tasks)
      .set({ updatedAt: new Date() })
      .where(eq(tasks.id, link.taskId));
    return updated;
  });

  emitTaskEvent(task.projectId, link.taskId);
  return result;
}

