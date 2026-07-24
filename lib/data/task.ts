import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  executeRaw,
  normalizeExecuteResult,
  taskProjectScopeSql,
  uuidArray,
  type Conn,
  type ReadConn,
} from "@/lib/db/raw";
import { dbClockStamp } from "@/lib/db/clock";
import { withUserContext, withUserContextRead, type Tx } from "@/lib/db/rls";
import {
  projects,
  tasks,
  taskEdges,
  taskAssignees,
  taskAcceptanceCriteria,
  taskDecisions,
  taskLinks,
  type NewTask,
  type Task,
  type Project,
  type TaskLink,
} from "@/lib/db/schema";
import { acquireProjectLock } from "@/lib/db/raw/acquire-project-lock";
import {
  taskFieldsStmt,
  taskFullStmt,
  type TaskFieldName,
  type TaskFieldsRawRow,
  type TaskFullRawRow,
} from "@/lib/db/raw/fetch-task-full";
import { fetchTaskChildren } from "@/lib/db/raw/fetch-task-children";
import type {
  AcceptanceCriterion,
  Decision,
  TaskStatus,
  Priority,
  Estimate,
} from "@/lib/types";
import {
  asIdentifier,
  composeTaskRef,
  enrichWithTaskRef,
  type Identifier,
  type TaskRef,
} from "@/lib/graph/identifier";
import {
  buildEffectiveDepGraph,
  buildEffectiveDepGraphFrom,
  type EffectiveDepGraph,
} from "@/lib/graph/effective-deps";
import { projectDependsOnEdgesStmt } from "@/lib/data/edge";
import { projectAccessGateStmt } from "@/lib/data/access";
import {
  insertActivityEvents,
  diffCriteria,
  diffDecisions,
  diffAssignees,
  type ActivityEventInput,
} from "@/lib/data/activity";
import { fetchMyTaskDepStats } from "@/lib/db/raw/fetch-my-task-dep-stats";
import { normalizeTags } from "@/lib/graph/tag-similarity";
import {
  ProjectArchivedError,
  ProjectNotFoundError,
  SearchCriteriaRequiredError,
  TaskLimitError,
  UnknownCategoryError,
} from "@/lib/graph/errors";
import { formatTaskMarkdownFields } from "@/lib/markdown/format";
import { parseEnvInt } from "@/lib/config/env";
import type { ActorDescriptor, AuthContext } from "@/lib/auth/context";
import {
  assertProjectAccessTx,
  assertProjectGateRows,
  assertTaskAccessTx,
  assertValidProjectId,
  assertValidTaskId,
  firstRowOrForbidden,
  ForbiddenError,
  isUuid,
} from "@/lib/auth/authorization";
import {
  decodeCursor,
  decodeOrderCursor,
  encodeCursor,
  encodeOrderCursor,
  type Cursor,
} from "@/lib/data/cursor";
import type {
  AssigneeRef,
  MyTask,
  TaskFull,
  TaskFullWithEdges,
  TaskLinkRef,
  TaskSlim,
} from "@/lib/data/views";
import { edgeRefColumns } from "@/lib/data/edge-columns";
import { projectColor } from "@/lib/ui/project-color";
import {
  assigneeSetChanged,
  classifyTaskRowChanges,
  taskSlimPatchFromRow,
} from "@/lib/data/task-clock";
import { emitTaskEvent } from "@/lib/realtime/events";
import {
  classifyLink,
  MalformedLinkError,
  type ClassifiedLink,
} from "@/lib/links/classify";

/**
 * Compute one discrete activity event per changed task field. Scalars compare
 * by value; tags diff per element. Unchanged fields produce nothing.
 *
 * @param projectId - Owning project id.
 * @param taskId - Task being updated.
 * @param current - The row before the update.
 * @param changes - The partial column changes being applied.
 * @returns Discrete events to insert for this update.
 */
export function diffTaskChanges(
  projectId: string,
  taskId: string,
  current: Task,
  changes: Partial<Task>,
): ActivityEventInput[] {
  const events: ActivityEventInput[] = [];
  const base = { projectId, taskId };

  if (changes.title !== undefined && changes.title !== current.title) {
    events.push({
      ...base,
      type: "title_changed",
      summary: `renamed to "${changes.title}"`,
    });
  }
  if (
    changes.description !== undefined &&
    changes.description !== current.description
  ) {
    events.push({
      ...base,
      type: "description_changed",
      summary: "updated the description",
    });
  }
  if (changes.status !== undefined && changes.status !== current.status) {
    events.push({
      ...base,
      type: "status_changed",
      summary: `moved to ${changes.status}`,
      metadata: { from: current.status, to: changes.status },
    });
  }
  if (changes.priority !== undefined && changes.priority !== current.priority) {
    events.push({
      ...base,
      type: "priority_changed",
      summary: changes.priority
        ? `set priority to ${changes.priority}`
        : "cleared priority",
      metadata: { from: current.priority, to: changes.priority },
    });
  }
  if (changes.estimate !== undefined && changes.estimate !== current.estimate) {
    events.push({
      ...base,
      type: "estimate_changed",
      summary:
        changes.estimate != null
          ? `set estimate to ${changes.estimate}`
          : "cleared estimate",
      metadata: { from: current.estimate, to: changes.estimate },
    });
  }
  if (changes.category !== undefined && changes.category !== current.category) {
    events.push({
      ...base,
      type: "category_changed",
      summary: changes.category
        ? `set category to ${changes.category}`
        : "cleared category",
      metadata: { from: current.category, to: changes.category },
    });
  }
  if (
    changes.implementationPlan !== undefined &&
    changes.implementationPlan !== current.implementationPlan
  ) {
    events.push({
      ...base,
      type: "plan_set",
      summary: "updated the implementation plan",
    });
  }
  if (
    changes.executionRecord !== undefined &&
    changes.executionRecord !== current.executionRecord
  ) {
    events.push({
      ...base,
      type: "record_set",
      summary: "updated the execution record",
    });
  }
  if (changes.order !== undefined && changes.order !== current.order) {
    // `order` is an internal sort position, never rendered as a transition,
    // so no `metadata` is stored (would be dead egress on every reorder).
    events.push({
      ...base,
      type: "moved",
      summary: "reordered the task",
    });
  }
  if (changes.tags !== undefined) {
    const before = new Set(current.tags);
    const after = new Set(changes.tags);
    for (const tag of changes.tags) {
      if (!before.has(tag))
        events.push({
          ...base,
          type: "tag_added",
          summary: `added tag ${tag}`,
          targetRef: tag,
        });
    }
    for (const tag of current.tags) {
      if (!after.has(tag))
        events.push({
          ...base,
          type: "tag_removed",
          summary: `removed tag ${tag}`,
          targetRef: tag,
        });
    }
  }
  if (
    changes.files !== undefined &&
    JSON.stringify(changes.files) !== JSON.stringify(current.files)
  ) {
    events.push({
      ...base,
      type: "files_changed",
      summary: "updated linked files",
    });
  }
  return events;
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
      text: (obj.text as string) ?? (obj.description as string) ?? String(c),
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
export function normalizeDecisions(input: unknown[]): Decision[] {
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
      source: (obj.source as Decision["source"]) ?? "refinement",
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

  // Inline `MAX(position)` as a scalar subquery on each VALUES row to skip
  // the standalone SELECT round-trip. All rows in one INSERT see the same
  // post-DELETE snapshot, so positions stay monotonic across the batch.
  await tx
    .insert(taskAcceptanceCriteria)
    .values(
      incoming.map((c, i) => ({
        id: c.id,
        taskId,
        text: c.text,
        checked: c.checked,
        position: sql<number>`(SELECT COALESCE(MAX("position"), -1) FROM "task_acceptance_criteria" WHERE "task_id" = ${taskId}::uuid) + ${i + 1}`,
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
    await tx.delete(taskDecisions).where(eq(taskDecisions.taskId, taskId));
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

  // Inline `MAX(position)` as a scalar subquery to skip the standalone
  // SELECT round-trip. Mirrors {@link applyCriteriaWrite}.
  await tx
    .insert(taskDecisions)
    .values(
      incoming.map((d, i) => ({
        id: d.id,
        taskId,
        text: d.text,
        source: d.source,
        decisionDate: d.date,
        position: sql<number>`(SELECT COALESCE(MAX("position"), -1) FROM "task_decisions" WHERE "task_id" = ${taskId}::uuid) + ${i + 1}`,
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
 * Batch-fetch criteria keyed by task id. Mirrors {@link fetchAssigneesByTaskUnchecked}.
 *
 * UNCHECKED: caller must assert access on every supplied taskId.
 *
 * @param taskIds - UUIDs to fetch criteria for.
 * @param conn - RLS-scoped {@link Conn} from an active `withUserContext` frame.
 * @returns Map of taskId -> AcceptanceCriterion[]; missing tasks omitted.
 */
export async function fetchCriteriaByTaskUnchecked(
  taskIds: string[],
  conn: Conn,
): Promise<Map<string, AcceptanceCriterion[]>> {
  const result = new Map<string, AcceptanceCriterion[]>();
  if (taskIds.length === 0) return result;
  const rows = await conn
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
 * @param conn - RLS-scoped {@link Conn} from an active `withUserContext` frame.
 * @returns Map of taskId -> Decision[]; missing tasks omitted.
 */
export async function fetchDecisionsByTaskUnchecked(
  taskIds: string[],
  conn: Conn,
): Promise<Map<string, Decision[]>> {
  const result = new Map<string, Decision[]>();
  if (taskIds.length === 0) return result;
  const rows = await conn
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
 * One read batch: the access gate plus a raw SQL statement that joins
 * `tasks` to `projects` and folds `task_assignees`,
 * `task_acceptance_criteria`, `task_decisions`, and `task_links` into
 * JSON-aggregated subqueries.
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
  assertValidTaskId(taskId);
  const [fullRaw] = await withUserContextRead(ctx.userId, (read) => [
    taskFullStmt(read, taskId),
  ]);
  return requireTaskRow(
    normalizeExecuteResult<TaskFullRawRow>(fullRaw),
    taskId,
  );
}

/**
 * Read exactly the requested task fields in one RLS-scoped round trip. The
 * MCP `piyaz_get fields=[...]` path: only the requested columns are
 * egressed; identity columns and `updated_at` always ride along for ref
 * composition and `ifUpdatedAt` preconditions. RLS hides rows the caller
 * cannot access, so an empty result is 404-shaped like {@link getTaskFull}.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @param fields - Field names to project.
 * @returns The raw field-projected row.
 * @throws ForbiddenError when no row is visible to the caller.
 */
export async function getTaskFields(
  ctx: AuthContext,
  taskId: string,
  fields: readonly TaskFieldName[],
): Promise<TaskFieldsRawRow> {
  assertValidTaskId(taskId);
  const [raw] = await withUserContextRead(ctx.userId, (read) => [
    taskFieldsStmt(read, taskId, fields),
  ]);
  const [row] = normalizeExecuteResult<TaskFieldsRawRow>(raw);
  if (!row) throw new ForbiddenError("Forbidden", "task", taskId);
  return row;
}

/**
 * Map the rows of a task fetch to {@link TaskFull}, failing closed when no
 * row is visible. RLS hides rows the caller cannot access, so an empty
 * result means missing task or cross-team access — both 404-shaped.
 *
 * @param rows - Raw rows from `taskFullStmt` or `taskForDepthStmt`.
 * @param taskId - UUID of the task, for the error payload.
 * @returns The mapped {@link TaskFull}.
 * @throws ForbiddenError when no row is visible to the caller.
 */
export function requireTaskRow(
  rows: TaskFullRawRow[],
  taskId: string,
): TaskFull {
  return mapTaskFullRow(firstRowOrForbidden("task", taskId, rows));
}

/**
 * Slim membership-gated lookup of a task's `projectId`. Routes through the
 * {@link assertTaskAccessTx} gate, which both authorizes the caller and
 * returns `projectId` in one slim row, with no full-task read. Used by the
 * conditional-GET validator on the context bundle endpoint so the HEAD/304
 * path never pays for the full task.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns The task's `projectId`.
 * @throws ForbiddenError when the caller cannot access the task.
 */
export async function getTaskProjectId(
  ctx: AuthContext,
  taskId: string,
): Promise<string> {
  return withUserContext(ctx.userId, async (tx) => {
    const gate = await assertTaskAccessTx(tx, taskId);
    return gate.projectId;
  });
}

/**
 * Map a {@link TaskFullRawRow} to the camelCase {@link TaskFull} shape,
 * composing `taskRef` and narrowing the decision `source` union. Shared by
 * {@link requireTaskRow} consumers so the full and depth-projected surfaces
 * map identically.
 *
 * @param r - Raw row from `taskFullStmt` or `taskForDepthStmt`.
 * @returns The mapped {@link TaskFull}.
 */
function mapTaskFullRow(r: TaskFullRawRow): TaskFull {
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
    createdAt:
      r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    updatedAt:
      r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at),
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
 * A task's connected edges in the slim `note`-carrying shape the detail
 * relationships list renders, as a lazy batch statement. RLS scopes the
 * rows to edges whose endpoints are both member-visible. Performs no
 * authorization itself — batch alongside a task-row statement whose empty
 * result is the 404 signal.
 *
 * @param read - Read statement-building handle.
 * @param taskId - UUID of the task (matched on either endpoint).
 * @returns Lazy select yielding {@link TaskEdgeRef} rows.
 */
function taskEdgeRefsStmt(read: ReadConn, taskId: string) {
  return read
    .select(edgeRefColumns)
    .from(taskEdges)
    .where(
      or(
        eq(taskEdges.sourceTaskId, taskId),
        eq(taskEdges.targetTaskId, taskId),
      ),
    );
}

/**
 * {@link getTaskFull} plus the task's connected edges, in one read batch.
 * Only the task-detail endpoint renders relationships, so `getTaskFull`
 * stays lean and this variant layers the edge statement on for that single
 * caller.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns Full task row plus connected edges (slim + `note`).
 * @throws ForbiddenError when the caller is not a member of the task's team.
 */
export async function getTaskFullWithEdges(
  ctx: AuthContext,
  taskId: string,
): Promise<TaskFullWithEdges> {
  assertValidTaskId(taskId);
  const [fullRaw, edges] = await withUserContextRead(ctx.userId, (read) => [
    taskFullStmt(read, taskId),
    taskEdgeRefsStmt(read, taskId),
  ]);
  const full = requireTaskRow(
    normalizeExecuteResult<TaskFullRawRow>(fullRaw),
    taskId,
  );
  return { ...full, edges };
}

/**
 * Fetch the assignee projection (userId + name + email) for a task,
 * routed through the `task_assignees_visible` SECURITY DEFINER function
 * so `app_user` can read `piyaz_auth.user` under the Option-B lockdown.
 *
 * UNCHECKED: the SDF itself re-checks caller membership of the task's
 * org, but the upstream `assertTaskAccess` is still the contract. The
 * `Unchecked` suffix is the contract — do not strip it when wrapping or
 * re-exporting.
 *
 * @param taskId - UUID of the task.
 * @param conn - Drizzle client or transaction handle. Callers running
 *   under a `withUserContext` transaction should pass the active `tx`
 *   so the read participates in the same RLS-scoped frame (the SDF
 *   reads `app.user_id` from the GUC).
 * @returns Ordered array of assignee refs (empty when nobody is assigned).
 */
export async function fetchAssigneesUnchecked(
  taskId: string,
  conn: Conn,
): Promise<AssigneeRef[]> {
  const rows = await executeRaw<{
    user_id: string;
    name: string;
    email: string;
  }>(
    conn,
    sql`SELECT user_id, name, email FROM public.task_assignees_visible(${taskId}::uuid) ORDER BY name`,
  );
  return rows.map((r) => ({ userId: r.user_id, name: r.name, email: r.email }));
}

/**
 * Fetch assignee projections for a batch of task ids in one round-trip
 * via `LATERAL public.task_assignees_visible(...)`. Returns a map keyed
 * by taskId for easy zipping with a parallel task list.
 *
 * UNCHECKED: per-task membership is enforced by the SDF, but the upstream
 * `assertProjectAccess` is still the contract. The `Unchecked` suffix is
 * the contract — do not strip it when wrapping or re-exporting.
 *
 * @param taskIds - UUIDs to fetch assignees for.
 * @param conn - Drizzle client or transaction handle. Callers running
 *   under a `withUserContext` transaction should pass the active `tx`.
 * @returns Map of taskId -> AssigneeRef[]; missing tasks omitted.
 */
export async function fetchAssigneesByTaskUnchecked(
  taskIds: string[],
  conn: Conn,
): Promise<Map<string, AssigneeRef[]>> {
  const result = new Map<string, AssigneeRef[]>();
  if (taskIds.length === 0) return result;
  const rows = await executeRaw<{
    task_id: string;
    user_id: string;
    name: string;
    email: string;
  }>(
    conn,
    sql`
      SELECT t.task_id, a.user_id, a.name, a.email
      FROM unnest(${uuidArray(taskIds)}) AS t(task_id)
      CROSS JOIN LATERAL public.task_assignees_visible(t.task_id) a
      ORDER BY a.name
    `,
  );
  for (const r of rows) {
    const list = result.get(r.task_id) ?? [];
    list.push({ userId: r.user_id, name: r.name, email: r.email });
    result.set(r.task_id, list);
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
 * @param conn - RLS-scoped {@link Conn} from an active `withUserContext` frame.
 * @returns Ordered array of link refs (empty when no links exist).
 */
export async function fetchLinksUnchecked(
  taskId: string,
  conn: Conn,
): Promise<TaskLinkRef[]> {
  return conn
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
  return sql<
    string[]
  >`COALESCE((SELECT array_agg("ta_au"."user_id" ORDER BY "ta_au"."user_id") FROM "task_assignees" "ta_au" WHERE "ta_au"."task_id" = "tasks"."id"), '{}'::uuid[])`;
}

/**
 * Fetch the slim task view for listing surfaces. Issues a slim projection
 * with an `assigneeCountSubquery` LEFT JOIN; does not pull criteria,
 * decisions, files, or links — listing surfaces never render
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
  const [row] = await withUserContext(ctx.userId, async (tx) => {
    await assertTaskAccessTx(tx, taskId);
    return tx
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
  });
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
 * Overview rows for every task in a project, as a lazy batch statement.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project.
 * @returns Lazy select yielding overview rows for every project task.
 */
export function projectTasksForOverviewStmt(read: ReadConn, projectId: string) {
  return read
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      sequenceNumber: tasks.sequenceNumber,
      order: tasks.order,
      tags: tasks.tags,
      category: tasks.category,
      priority: tasks.priority,
      estimate: tasks.estimate,
      description: sql<string>`substring(${tasks.description} from 1 for 101)`,
    })
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
  const { project, rows } = await withUserContext(ctx.userId, async (tx) => {
    const { project } = await assertProjectAccessTx(tx, projectId);
    const rows = await tx
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
    return { project, rows };
  });

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
 * State-derivation variant taking a precomputed `allDepsDone` flag, so
 * `listMyTasks` can reuse the iron-law gate without building a project graph.
 *
 * @param task - Slim state input (status + hasDescription + hasCriteria).
 * @param allDepsDone - Whether every direct dependency is done or
 *   cancelled. Callers that have no upstream edges should pass `true`.
 * @returns Derived TaskState.
 */
function deriveTaskStateWithDepsDone(
  task: Pick<TaskStateInput, "status" | "hasDescription" | "hasCriteria">,
  allDepsDone: boolean,
): TaskState {
  if (task.status === "done") return "done";
  if (task.status === "cancelled") return "cancelled";
  if (task.status === "in_progress") return "in_progress";
  if (task.status === "in_review") return "in_review";
  if (task.status === "planned") return allDepsDone ? "ready" : "blocked";
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
 * @param conn - RLS-scoped {@link Conn} from an active `withUserContext` frame.
 * @returns Map of taskId → TaskState.
 */
export async function deriveTaskStatesSlim(
  projectId: string,
  taskSubset: TaskStateInput[],
  conn: Conn,
): Promise<Map<string, TaskState>> {
  const graph = await buildEffectiveDepGraph(projectId, conn);
  return deriveTaskStatesFrom(graph, taskSubset);
}

/**
 * Derive per-task workflow states from a pre-built effective dependency
 * graph. Pure counterpart of {@link deriveTaskStatesSlim} for callers that
 * resolved the graph substrate in a read batch.
 *
 * @param graph - Effective dependency graph for the project.
 * @param taskSubset - Tasks to derive states for.
 * @returns Map of task id to derived state.
 */
export function deriveTaskStatesFrom(
  graph: EffectiveDepGraph,
  taskSubset: TaskStateInput[],
): Map<string, TaskState> {
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
export const TASK_REF_PATTERN = /^([A-Z0-9]+)-(\d+)$/i;

/** Filter options for {@link searchTasks} and {@link searchTasksRead}. */
export type SearchTasksOpts = {
  /** Optional search string (taskRef, title, or tag substring). */
  query?: string;
  /** Optional exact tag filter (OR-within). */
  tags?: string[];
  /** Optional exact project-category filter (AND-narrows); unknown values match nothing. */
  category?: string;
};

/**
 * Search tasks by taskRef, title, tags, or category within a project.
 * Prefer {@link searchTasksRead} when the caller already holds a
 * `withUserContext` frame.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @param opts - Filter options.
 * @returns Up to 20 matching tasks with derived state.
 * @throws ForbiddenError on missing or cross-team project.
 */
export async function searchTasks(
  ctx: AuthContext,
  projectId: string,
  opts: SearchTasksOpts = {},
): Promise<SearchResult[]> {
  const project = await getSearchProjectGate(ctx.userId, projectId);
  return searchTasksRead(ctx.userId, project, opts);
}

/** The slice of {@link Project} that {@link searchTasksRead} reads. */
export type SearchTasksProject = Pick<
  Project,
  "id" | "identifier" | "categories"
>;

/**
 * Resolve the project access gate for a search in one read batch. Shared
 * by {@link searchTasks} and the MCP search tool, whose category
 * validation needs the project's `categories` before the search batch.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param projectId - UUID of the project.
 * @returns The authorized project slice.
 * @throws ForbiddenError on missing or cross-team project.
 */
export async function getSearchProjectGate(
  userId: string,
  projectId: string,
): Promise<SearchTasksProject> {
  assertValidProjectId(projectId);
  const [gateRows] = await withUserContextRead(userId, (read) => [
    projectAccessGateStmt(read, projectId),
  ]);
  return assertProjectGateRows(projectId, gateRows);
}

/** Trimmed, normalized search filters; null when every filter is empty. */
type SearchFilters = {
  trimmedQuery: string;
  tagFilter: string[];
  trimmedCategory: string;
};

/**
 * Trim and normalize the search options.
 *
 * @param opts - Caller-supplied filter options.
 * @returns Normalized filters, or null when nothing filters.
 */
function normalizeSearchFilters(opts: SearchTasksOpts): SearchFilters | null {
  const trimmedQuery = opts.query?.trim() ?? "";
  const tagFilter = normalizeTags(opts.tags);
  const trimmedCategory = opts.category?.trim() ?? "";
  if (
    trimmedQuery.length === 0 &&
    tagFilter.length === 0 &&
    trimmedCategory.length === 0
  ) {
    return null;
  }
  return { trimmedQuery, tagFilter, trimmedCategory };
}

/**
 * Build the ranked, filtered search select as a lazy batch statement.
 *
 * @param read - Read statement-building handle.
 * @param project - Pre-resolved project slice (caller already authorized).
 * @param filters - Normalized search filters.
 * @returns Lazy select yielding up to 20 ranked task rows.
 */
function searchTasksStmt(
  read: ReadConn,
  project: SearchTasksProject,
  filters: SearchFilters,
) {
  const { trimmedQuery, tagFilter, trimmedCategory } = filters;
  const lower = trimmedQuery.toLowerCase();
  const rankExpr =
    trimmedQuery.length > 0
      ? sql<number>`CASE
          WHEN LOWER(${tasks.title}) = ${lower} THEN 0
          WHEN LOWER(${tasks.title}) LIKE ${lower + "%"} THEN 1
          WHEN LOWER(${tasks.title}) LIKE ${"%" + lower + "%"} THEN 2
          ELSE 3
        END`
      : null;

  const clauses = [eq(tasks.projectId, project.id)];

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

  if (trimmedCategory.length > 0) {
    clauses.push(eq(tasks.category, trimmedCategory));
  }

  // Inlining a literal `0` in ORDER BY is parsed as a positional column
  // reference, not a constant — Postgres rejects it with 42P10.
  const orderByCols = rankExpr
    ? [rankExpr, asc(tasks.order)]
    : [asc(tasks.order)];
  return read
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
    .orderBy(...orderByCols)
    .limit(20);
}

/**
 * {@link searchTasks} on a pre-resolved project, over one read batch: the
 * ranked search select plus the project's graph substrate (tasks and
 * edges) so derived states compute without an interactive transaction.
 *
 * The caller MUST have gated `project.id` (e.g. via
 * {@link getSearchProjectGate}). RLS still gates every row read, so a
 * missing gate never bypasses authorization — it would only mute the
 * explicit `Forbidden` error path.
 *
 * @param userId - Authenticated user id (RLS scope).
 * @param project - Pre-resolved project slice (caller already authorized).
 * @param opts - Filter options.
 * @returns Up to 20 matching tasks with derived state.
 */
export async function searchTasksRead(
  userId: string,
  project: SearchTasksProject,
  opts: SearchTasksOpts = {},
): Promise<SearchResult[]> {
  const filters = normalizeSearchFilters(opts);
  if (!filters) return [];

  const [trimmedRows, graphTasks, dependsOnEdges] = await withUserContextRead(
    userId,
    (read) => [
      searchTasksStmt(read, project, filters),
      listTasksForGraphStmt(read, project.id),
      projectDependsOnEdgesStmt(read, project.id),
    ],
  );
  const graph = buildEffectiveDepGraphFrom(graphTasks, dependsOnEdges);
  const stateMap = deriveTaskStatesFrom(
    graph,
    trimmedRows.map((t) => ({
      id: t.id,
      status: t.status,
      hasDescription: t.hasDescription,
      hasCriteria: t.hasCriteria,
    })),
  );

  const identifier = asIdentifier(project.identifier);
  return enrichWithTaskRef(trimmedRows, identifier).map((t) => ({
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
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const after = decodeOrderCursor(opts.cursor);

  const trimmedQuery = opts.query?.trim() ?? "";
  const tagFilter = normalizeTags(opts.tags);

  const cursorClause = after
    ? sql`(${tasks.order} < ${after.order}
            OR (${tasks.order} = ${after.order} AND ${tasks.id} < ${after.id}))`
    : sql`TRUE`;

  const { project, trimmed, nextCursor, stateMap } = await withUserContext(
    ctx.userId,
    async (tx) => {
      const { project } = await assertProjectAccessTx(tx, projectId);

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

      const matchingTasks = await tx
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
      const trimmedRows = hasMore
        ? matchingTasks.slice(0, limit)
        : matchingTasks;
      const last = trimmedRows[trimmedRows.length - 1];
      const cursor =
        hasMore && last
          ? encodeOrderCursor({ order: last.order, id: last.id })
          : null;

      if (trimmedRows.length === 0) {
        return {
          project,
          trimmed: trimmedRows,
          nextCursor: null,
          stateMap: null,
        };
      }

      const states = await deriveTaskStatesSlim(
        projectId,
        trimmedRows.map((t) => ({
          id: t.id,
          status: t.status,
          hasDescription: t.hasDescription,
          hasCriteria: t.hasCriteria,
        })),
        tx,
      );
      return {
        project,
        trimmed: trimmedRows,
        nextCursor: cursor,
        stateMap: states,
      };
    },
  );

  if (trimmed.length === 0 || !stateMap) {
    return { rows: [], nextCursor: null };
  }
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
// Cross-project search (command palette)
// ---------------------------------------------------------------------------

/** A search result returned by {@link searchTasksAcrossProjects}. */
export type CrossProjectSearchResult = {
  /** Task UUID. */
  id: string;
  /** Composed taskRef, e.g. `MYMR-191`. */
  taskRef: string;
  /** Task title. */
  title: string;
  /** Task lifecycle status. */
  status: string;
  /** Owning project UUID — drives the deep link. */
  projectId: string;
  /** Owning project identifier (prefix shown in the taskRef). */
  projectIdentifier: string;
  /** Owning project title — shown as the project crumb in the palette row. */
  projectTitle: string;
  /** Owning team UUID. */
  organizationId: string;
};

/**
 * Cross-project task search for the ⌘K palette. Bounded by
 * `current_user_orgs()` (defense-in-depth over RLS).
 *
 * Per-token OR match: `tasks.title`, any `tasks.tags` value,
 * `projects.title`, `projects.identifier` (all case-insensitive substring),
 * and `tasks.sequence_number` for digit-only tokens. Tokens AND-join.
 * Full taskRef (`MYMR-191`) short-circuits to one row; partial (`MYMR-`)
 * falls through and surfaces every task in the project.
 *
 * Ordered by rank → `tasks.order` → `tasks.id` (stable tie-breaker).
 *
 * @param ctx - Resolved auth context.
 * @param query - Search string.
 * @param opts - Optional limit (1-25, default 10).
 * @returns Up to `opts.limit` matching tasks with project crumb metadata.
 */
export async function searchTasksAcrossProjects(
  ctx: AuthContext,
  query: string,
  opts: { limit?: number } = {},
): Promise<CrossProjectSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const lower = trimmed.toLowerCase();
  const rankExpr = sql<number>`CASE
      WHEN LOWER(${tasks.title}) = ${lower} THEN 0
      WHEN LOWER(${tasks.title}) LIKE ${lower + "%"} THEN 1
      WHEN LOWER(${tasks.title}) LIKE ${"%" + lower + "%"} THEN 2
      ELSE 3
    END`;

  return withUserContext(ctx.userId, async (tx) => {
    const orgRows = await executeRaw<{ org_id: string }>(
      tx,
      sql`SELECT org_id FROM public.current_user_orgs()`,
    );
    const orgIds = orgRows.map((r) => r.org_id);
    if (orgIds.length === 0) return [];

    const clauses = [inArray(projects.organizationId, orgIds)];

    const refMatch = trimmed.match(TASK_REF_PATTERN);
    if (refMatch) {
      // taskRef short-circuit — match exact project identifier + sequence.
      // No fallback to title substring when the pattern matches, so a query
      // like "FOO-1" that doesn't resolve returns empty rather than confusing.
      clauses.push(eq(projects.identifier, refMatch[1].toUpperCase()));
      clauses.push(eq(tasks.sequenceNumber, Number(refMatch[2])));
    } else {
      // Tokenize on whitespace and dashes so "auth bug" AND-matches both
      // tokens in any order, and partial taskRefs like "MYMR-" surface
      // every task in that project. Each token must match somewhere:
      // task title, any tag, project title, project identifier, or
      // (numeric tokens only) sequence number.
      const tokens = trimmed.split(/[\s-]+/).filter((t) => t.length > 0);
      if (tokens.length === 0) return [];
      for (const token of tokens) {
        const pattern = `%${token}%`;
        const orClauses = [
          ilike(tasks.title, pattern),
          sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${tasks.tags}) AS t WHERE t ILIKE ${pattern})`,
          ilike(projects.title, pattern),
          ilike(projects.identifier, pattern),
        ];
        if (/^\d+$/.test(token)) {
          orClauses.push(eq(tasks.sequenceNumber, Number(token)));
        }
        const tokenClause = or(...orClauses);
        if (tokenClause) clauses.push(tokenClause);
      }
    }

    const rows = await tx
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        sequenceNumber: tasks.sequenceNumber,
        projectId: tasks.projectId,
        projectIdentifier: projects.identifier,
        projectTitle: projects.title,
        organizationId: projects.organizationId,
      })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(...clauses))
      .orderBy(rankExpr, asc(tasks.order), asc(tasks.id))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      taskRef: composeTaskRef(
        asIdentifier(row.projectIdentifier),
        row.sequenceNumber,
      ),
      title: row.title,
      status: row.status,
      projectId: row.projectId,
      projectIdentifier: row.projectIdentifier,
      projectTitle: row.projectTitle,
      organizationId: row.organizationId,
    }));
  });
}

// ---------------------------------------------------------------------------
// MCP search (cross-project + project-scoped, keyset on updated_at)
// ---------------------------------------------------------------------------

/** Filter and pagination options for {@link searchTasksForMcp}. */
export type McpSearchOpts = {
  /** Free-text match on taskRef, title, or tags. */
  query?: string;
  /** Project UUID; present selects project-scoped mode (adds derived `state`). */
  projectId?: string;
  /** Lifecycle statuses to include (OR-within). */
  status?: string[];
  /** Priorities to include (OR-within). */
  priority?: string[];
  /** Assignee user UUID, or the literal `me` (mapped to the caller). */
  assignee?: string;
  /** Exact project-category filter. */
  category?: string;
  /** Exact tags; every tag must be present on the task (AND-within). */
  tags?: string[];
  /** Page size, clamped to 1..50 (default 20). */
  limit?: number;
  /** Opaque `(updated_at, id)` cursor from a previous page. */
  cursor?: Cursor | string | null;
};

/**
 * A search result row. `state` is present only in project-scoped mode, where
 * the effective dependency graph is available; cross-project rows omit it.
 */
export type McpSearchItem = {
  id: string;
  taskRef: string;
  title: string;
  status: string;
  priority: Priority | null;
  estimate: Estimate | null;
  category: string | null;
  tags: string[];
  updatedAt: Date;
  state?: TaskState;
};

/** A page of {@link McpSearchItem}s with a cursor for the next slice. */
export type McpSearchPage = {
  items: McpSearchItem[];
  nextCursor: Cursor | null;
};

/** Row columns shared by both search modes, before taskRef composition. */
type McpSearchRow = {
  id: string;
  title: string;
  status: string;
  priority: Priority | null;
  estimate: Estimate | null;
  category: string | null;
  tags: string[];
  sequenceNumber: number;
  updatedAt: Date;
};

const MCP_SEARCH_DEFAULT_LIMIT = 20;
const MCP_SEARCH_MAX_LIMIT = 50;

/**
 * Whether the caller supplied at least one search criterion.
 *
 * @param opts - Caller-supplied search options.
 * @returns True when any of query/status/priority/assignee/category/tags is set.
 */
function hasAnySearchCriterion(opts: McpSearchOpts): boolean {
  return Boolean(
    opts.query?.trim() ||
      opts.status?.length ||
      opts.priority?.length ||
      opts.assignee ||
      opts.category?.trim() ||
      opts.tags?.length,
  );
}

/**
 * Build the mode-independent filter clauses (status, priority, assignee,
 * category, tags). The `me` assignee literal maps to the caller's id. Exact
 * tags AND-narrow: every tag must be present on the task.
 *
 * @param opts - Caller-supplied search options.
 * @param userId - Caller's id, for the `me` assignee mapping.
 * @returns Drizzle `where` clauses to AND into the query.
 */
function mcpScalarFilterClauses(opts: McpSearchOpts, userId: string): SQL[] {
  const clauses: SQL[] = [];
  if (opts.status?.length) {
    clauses.push(inArray(tasks.status, opts.status as TaskStatus[]));
  }
  if (opts.priority?.length) {
    clauses.push(inArray(tasks.priority, opts.priority as Priority[]));
  }
  if (opts.assignee) {
    const assigneeId = opts.assignee === "me" ? userId : opts.assignee;
    clauses.push(
      sql`EXISTS (SELECT 1 FROM "task_assignees" "ta_f" WHERE "ta_f"."task_id" = "tasks"."id" AND "ta_f"."user_id" = ${assigneeId})`,
    );
  }
  const category = opts.category?.trim();
  if (category) clauses.push(eq(tasks.category, category));
  for (const tag of normalizeTags(opts.tags)) {
    clauses.push(
      sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${tasks.tags}) AS t WHERE t = ${tag})`,
    );
  }
  return clauses;
}

/**
 * Cross-project `query` clauses: the ref short-circuit and tokenized OR match
 * from {@link searchTasksAcrossProjects}, over the org-bounded `tasks JOIN
 * projects` set. Empty when `trimmed` is empty.
 *
 * @param trimmed - Trimmed query string.
 * @returns Drizzle `where` clauses to AND into the query.
 */
function crossProjectQueryClauses(trimmed: string): SQL[] {
  if (trimmed.length === 0) return [];
  const refMatch = trimmed.match(TASK_REF_PATTERN);
  if (refMatch) {
    return [
      eq(projects.identifier, refMatch[1].toUpperCase()),
      eq(tasks.sequenceNumber, Number(refMatch[2])),
    ];
  }
  const clauses: SQL[] = [];
  for (const token of trimmed.split(/[\s-]+/).filter((t) => t.length > 0)) {
    const pattern = `%${token}%`;
    const orClauses = [
      ilike(tasks.title, pattern),
      sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${tasks.tags}) AS t WHERE t ILIKE ${pattern})`,
      ilike(projects.title, pattern),
      ilike(projects.identifier, pattern),
    ];
    if (/^\d+$/.test(token)) {
      orClauses.push(eq(tasks.sequenceNumber, Number(token)));
    }
    const tokenClause = or(...orClauses);
    if (tokenClause) clauses.push(tokenClause);
  }
  return clauses;
}

/**
 * Project-scoped `query` clause: the ref short-circuit and title/tag substring
 * match from {@link searchTasksPaged}, over a single known project.
 *
 * @param trimmed - Trimmed query string.
 * @param projectIdentifier - The scoped project's identifier prefix.
 * @returns A single `where` clause, or null when `trimmed` is empty.
 */
function projectScopedQueryClause(
  trimmed: string,
  projectIdentifier: string,
): SQL | null {
  if (trimmed.length === 0) return null;
  const refMatch = trimmed.match(TASK_REF_PATTERN);
  if (refMatch && refMatch[1].toUpperCase() === projectIdentifier) {
    return eq(tasks.sequenceNumber, Number(refMatch[2]));
  }
  const pattern = `%${trimmed}%`;
  const tagSubstring = sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${tasks.tags}) AS t WHERE t ILIKE ${pattern})`;
  return or(ilike(tasks.title, pattern), tagSubstring) ?? null;
}

/**
 * Compose a search row into an {@link McpSearchItem}. Attaches `state` only
 * when the caller resolved one (project-scoped mode).
 *
 * @param row - The selected task row.
 * @param identifier - The row's project identifier for taskRef composition.
 * @param state - Derived workflow state, or undefined in cross-project mode.
 * @returns The composed search item.
 */
function toMcpSearchItem(
  row: McpSearchRow,
  identifier: Identifier,
  state?: TaskState,
): McpSearchItem {
  const item: McpSearchItem = {
    id: row.id,
    taskRef: composeTaskRef(identifier, row.sequenceNumber),
    title: row.title,
    status: row.status,
    priority: row.priority,
    estimate: row.estimate,
    category: row.category,
    tags: row.tags,
    updatedAt: row.updatedAt,
  };
  if (state) item.state = state;
  return item;
}

/**
 * The `(updated_at, id)` keyset seek clause for the search page. Compares on a
 * millisecond-truncated `updated_at` so a `Date`-precision cursor matches the
 * microsecond-precision column at a page boundary (same idiom as
 * `listProjectsSlim`).
 *
 * @param cursor - Decoded cursor position, or null for the first page.
 * @param updatedAtMs - The millisecond-truncated `updated_at` expression.
 * @returns The seek clause (`TRUE` on the first page).
 */
function mcpSearchCursorClause(
  cursor: { updatedAt: Date; id: string } | null,
  updatedAtMs: SQL,
): SQL {
  if (!cursor) return sql`TRUE`;
  const afterIso = cursor.updatedAt.toISOString();
  return sql`(${updatedAtMs} < ${afterIso}::timestamptz
      OR (${updatedAtMs} = ${afterIso}::timestamptz AND ${tasks.id} < ${cursor.id}))`;
}

/**
 * Cross-project search (default mode). Org-bounded via `current_user_orgs()`
 * for defense-in-depth over RLS, keyset-paginated on `(updated_at DESC, id
 * DESC)`. Rows omit `state` (no per-project effective graph resolved here).
 *
 * @param ctx - Resolved auth context.
 * @param opts - Search options (already criterion-checked by the caller).
 * @returns A page of items plus the next cursor.
 */
async function searchMcpCrossProject(
  ctx: AuthContext,
  opts: McpSearchOpts,
): Promise<McpSearchPage> {
  const limit = Math.min(
    Math.max(opts.limit ?? MCP_SEARCH_DEFAULT_LIMIT, 1),
    MCP_SEARCH_MAX_LIMIT,
  );
  const after = decodeCursor(opts.cursor);
  const updatedAtMs = sql`date_trunc('milliseconds', ${tasks.updatedAt})`;

  return withUserContext(ctx.userId, async (tx) => {
    const orgRows = await executeRaw<{ org_id: string }>(
      tx,
      sql`SELECT org_id FROM public.current_user_orgs()`,
    );
    const orgIds = orgRows.map((r) => r.org_id);
    if (orgIds.length === 0) return { items: [], nextCursor: null };

    const clauses: SQL[] = [
      inArray(projects.organizationId, orgIds),
      ...crossProjectQueryClauses(opts.query?.trim() ?? ""),
      ...mcpScalarFilterClauses(opts, ctx.userId),
    ];

    const rows = await tx
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        priority: tasks.priority,
        estimate: tasks.estimate,
        category: tasks.category,
        tags: tasks.tags,
        sequenceNumber: tasks.sequenceNumber,
        updatedAt: tasks.updatedAt,
        projectIdentifier: projects.identifier,
      })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(...clauses, mcpSearchCursorClause(after, updatedAtMs)))
      .orderBy(desc(updatedAtMs), desc(tasks.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((row) =>
      toMcpSearchItem(row, asIdentifier(row.projectIdentifier)),
    );
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ updatedAt: new Date(last.updatedAt), id: last.id })
        : null;
    return { items, nextCursor };
  });
}

/**
 * Project-scoped search. Same filter set as {@link searchMcpCrossProject} over
 * one authorized project, keyset-paginated on `(updated_at DESC, id DESC)`.
 * Rows carry derived `state` via {@link deriveTaskStatesSlim}.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project to scope to.
 * @param opts - Search options (already criterion-checked by the caller).
 * @returns A page of items (with `state`) plus the next cursor.
 * @throws ForbiddenError on missing or cross-team project.
 * @throws UnknownCategoryError when `opts.category` is not one of the project's
 *   known categories.
 */
async function searchMcpProjectScoped(
  ctx: AuthContext,
  projectId: string,
  opts: McpSearchOpts,
): Promise<McpSearchPage> {
  const limit = Math.min(
    Math.max(opts.limit ?? MCP_SEARCH_DEFAULT_LIMIT, 1),
    MCP_SEARCH_MAX_LIMIT,
  );
  const after = decodeCursor(opts.cursor);
  const updatedAtMs = sql`date_trunc('milliseconds', ${tasks.updatedAt})`;

  return withUserContext(ctx.userId, async (tx) => {
    const { project } = await assertProjectAccessTx(tx, projectId);
    const identifier = asIdentifier(project.identifier);

    const category = opts.category?.trim();
    if (
      category &&
      project.categories.length > 0 &&
      !project.categories.includes(category)
    ) {
      throw new UnknownCategoryError(category, project.categories);
    }

    const queryClause = projectScopedQueryClause(
      opts.query?.trim() ?? "",
      project.identifier,
    );
    const clauses: SQL[] = [
      eq(tasks.projectId, projectId),
      ...(queryClause ? [queryClause] : []),
      ...mcpScalarFilterClauses(opts, ctx.userId),
    ];

    const rows = await tx
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        priority: tasks.priority,
        estimate: tasks.estimate,
        category: tasks.category,
        tags: tasks.tags,
        sequenceNumber: tasks.sequenceNumber,
        updatedAt: tasks.updatedAt,
        hasDescription: sql<boolean>`length(btrim(${tasks.description})) > 0`,
        hasCriteria: hasCriteriaExpr(),
      })
      .from(tasks)
      .where(and(...clauses, mcpSearchCursorClause(after, updatedAtMs)))
      .orderBy(desc(updatedAtMs), desc(tasks.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    if (page.length === 0) return { items: [], nextCursor: null };

    const stateMap = await deriveTaskStatesSlim(
      projectId,
      page.map((t) => ({
        id: t.id,
        status: t.status,
        hasDescription: t.hasDescription,
        hasCriteria: t.hasCriteria,
      })),
      tx,
    );

    const items = page.map((row) =>
      toMcpSearchItem(row, identifier, stateMap.get(row.id) ?? "draft"),
    );
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ updatedAt: new Date(last.updatedAt), id: last.id })
        : null;
    return { items, nextCursor };
  });
}

/**
 * Filtered task search for the MCP surface. Cross-project by default (org-
 * bounded), or project-scoped when `opts.projectId` is set (adds derived
 * `state`). Supports query, status, priority, assignee (`me` → caller),
 * category, and exact-tag filters, keyset-paginated on `(updated_at DESC, id
 * DESC)`.
 *
 * @param ctx - Resolved auth context.
 * @param opts - Filter and pagination options.
 * @returns A page of items plus the next cursor (null on the last page).
 * @throws SearchCriteriaRequiredError when no criterion is supplied.
 * @throws ForbiddenError on a missing or cross-team `projectId`.
 * @throws UnknownCategoryError when `category` is not one of the project's
 *   known categories.
 */
export async function searchTasksForMcp(
  ctx: AuthContext,
  opts: McpSearchOpts,
): Promise<McpSearchPage> {
  if (!hasAnySearchCriterion(opts)) {
    throw new SearchCriteriaRequiredError();
  }
  return opts.projectId
    ? searchMcpProjectScoped(ctx, opts.projectId, opts)
    : searchMcpCrossProject(ctx, opts);
}

/**
 * Bounded by `current_user_orgs()` for defense-in-depth over RLS.
 * Tie-break on `tasks.id` asc for stable output across calls.
 */
export async function listMyTasks(ctx: AuthContext): Promise<MyTask[]> {
  return withUserContext(ctx.userId, async (tx) => {
    const orgRows = await executeRaw<{ org_id: string }>(
      tx,
      sql`SELECT org_id FROM public.current_user_orgs()`,
    );
    const orgIds = orgRows.map((r) => r.org_id);
    if (orgIds.length === 0) return [];

    const rows = await tx
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        category: tasks.category,
        tags: tasks.tags,
        priority: tasks.priority,
        estimate: tasks.estimate,
        order: tasks.order,
        sequenceNumber: tasks.sequenceNumber,
        updatedAt: tasks.updatedAt,
        hasDescription: sql<boolean>`length(btrim(${tasks.description})) > 0`,
        hasCriteria: hasCriteriaExpr(),
        projectId: tasks.projectId,
        projectIdentifier: projects.identifier,
        projectTitle: projects.title,
      })
      .from(taskAssignees)
      .innerJoin(tasks, eq(tasks.id, taskAssignees.taskId))
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(
        and(
          eq(taskAssignees.userId, ctx.userId),
          inArray(projects.organizationId, orgIds),
        ),
      )
      .orderBy(desc(tasks.updatedAt), asc(tasks.id));

    if (rows.length === 0) return [];

    // Batched per-anchor direct-dependency counts in a single round-trip,
    // keyed on the user's assigned task ids — direct `depends_on` edges
    // only, matching the workspace structure view's `buildDepsMap`.
    const stats = await fetchMyTaskDepStats(
      tx,
      rows.map((r) => r.id),
    );

    return rows.map((row) => {
      const rowStats = stats.get(row.id);
      // Defensive defaults; no-edge anchors already return zeroed stats.
      const upstreamCount = rowStats?.upstreamCount ?? 0;
      const downstreamCount = rowStats?.downstreamCount ?? 0;
      const allDepsDone = rowStats?.allDepsDone ?? true;
      const blockerSeq = rowStats?.blockerSequenceNumber ?? null;

      const projectIdentifier = asIdentifier(row.projectIdentifier);
      const state = deriveTaskStateWithDepsDone(
        {
          status: row.status,
          hasDescription: row.hasDescription,
          hasCriteria: row.hasCriteria,
        },
        allDepsDone,
      );

      const blockedBy =
        blockerSeq === null
          ? null
          : composeTaskRef(projectIdentifier, blockerSeq);

      return {
        id: row.id,
        taskRef: composeTaskRef(projectIdentifier, row.sequenceNumber),
        title: row.title,
        status: row.status,
        state,
        category: row.category,
        tags: row.tags,
        priority: row.priority,
        estimate: row.estimate,
        order: row.order,
        updatedAt: row.updatedAt,
        hasDescription: row.hasDescription,
        hasCriteria: row.hasCriteria,
        project: {
          id: row.projectId,
          identifier: row.projectIdentifier,
          title: row.projectTitle,
          color: projectColor(row.projectIdentifier),
        },
        upstreamCount,
        downstreamCount,
        blockedBy,
      };
    });
  });
}

// ---------------------------------------------------------------------------
// Edge notes — internal helpers (caller asserted access already)
// ---------------------------------------------------------------------------

/** Row shape shared by the two edge-note batch statements. */
type EdgeNoteRow = { taskId: string; note: string };

/**
 * Outgoing depends_on edge notes as a lazy batch statement. The connected
 * task's project filter derives from the source task's own row. Build the
 * note map from the rows with {@link mapEdgeNoteRows}.
 *
 * @param read - Read statement-building handle.
 * @param taskId - UUID of the source task.
 * @returns Lazy select yielding `{ taskId, note }` rows keyed by
 *   prerequisite id.
 */
export function edgeNotesBySourceStmt(read: ReadConn, taskId: string) {
  return read
    .select({ taskId: taskEdges.targetTaskId, note: taskEdges.note })
    .from(taskEdges)
    .innerJoin(tasks, eq(tasks.id, taskEdges.targetTaskId))
    .where(
      and(
        eq(taskEdges.sourceTaskId, taskId),
        eq(taskEdges.edgeType, "depends_on"),
        eq(tasks.projectId, taskProjectScopeSql(taskId)),
      ),
    );
}

/**
 * Incoming depends_on edge notes as a lazy batch statement. See
 * {@link edgeNotesBySourceStmt}.
 *
 * @param read - Read statement-building handle.
 * @param taskId - UUID of the target task.
 * @returns Lazy select yielding `{ taskId, note }` rows keyed by
 *   dependent id.
 */
export function edgeNotesByTargetStmt(read: ReadConn, taskId: string) {
  return read
    .select({ taskId: taskEdges.sourceTaskId, note: taskEdges.note })
    .from(taskEdges)
    .innerJoin(tasks, eq(tasks.id, taskEdges.sourceTaskId))
    .where(
      and(
        eq(taskEdges.targetTaskId, taskId),
        eq(taskEdges.edgeType, "depends_on"),
        eq(tasks.projectId, taskProjectScopeSql(taskId)),
      ),
    );
}

/**
 * Fold edge-note rows into the connected-task-id → note map the context
 * cores consume, dropping empty notes.
 *
 * @param rows - Rows from an edge-note batch statement.
 * @returns Map of connected task id to non-empty note.
 */
export function mapEdgeNoteRows(
  rows: readonly EdgeNoteRow[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.note) map.set(r.taskId, r.note);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Batch task summaries — internal helper
// ---------------------------------------------------------------------------

/** Row shape shared by the summary / dependency-task batch statements. */
type TaskSummaryRow = {
  id: string;
  title: string;
  status: string;
  description?: string;
  executionRecord?: string | null;
  sequenceNumber: number;
  identifier: string;
};

/**
 * Slim task summaries for an id list, as a lazy batch statement. `ANY` over a typed
 * uuid array keeps the statement valid for an empty id list (zero rows),
 * unlike `IN ()`. Map the rows with {@link mapTaskSummaryRows}.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project the tasks belong to.
 * @param taskIds - UUIDs of the tasks to summarize.
 * @param withDescription - Whether to select the `description` column. Only
 *   the planning bundle renders downstream descriptions; every other
 *   consumer passes false and pays no text egress (the column stays
 *   type-stable as an empty literal).
 * @returns Lazy select yielding summary rows.
 */
export function taskSummariesStmt(
  read: ReadConn,
  projectId: string,
  taskIds: readonly string[],
  withDescription: boolean,
) {
  return read
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      description: withDescription
        ? tasks.description
        : sql<string>`''`.as("description"),
      sequenceNumber: tasks.sequenceNumber,
      identifier: projects.identifier,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(tasks.projectId, projectId),
        sql`${tasks.id} = ANY(${uuidArray(taskIds)})`,
      ),
    );
}

/**
 * Map summary rows to the downstream-summary projection the context cores
 * consume, composing each `taskRef`.
 *
 * @param rows - Rows from {@link taskSummariesStmt}.
 * @returns Task summaries with composed `taskRef`.
 */
export function mapTaskSummaryRows(rows: readonly TaskSummaryRow[]) {
  return rows.map((r) => ({
    id: r.id,
    taskRef: composeTaskRef(asIdentifier(r.identifier), r.sequenceNumber),
    title: r.title,
    status: r.status,
    description: r.description ?? "",
  }));
}

/** Dependency-task projection used by the agent / planning context assemblers. */
export type DependencyTaskInfo = {
  id: string;
  title: string;
  status: string;
  executionRecord: string | null;
  taskRef: string;
  /** Earliest `pull_request` link URL, or null when the task has none. */
  prUrl: string | null;
};

/**
 * Correlated scalar subquery selecting a task's earliest `pull_request` link
 * URL — the same first-PR convention `LINKS_AGG` ordering gives
 * `links.find(kind === 'pull_request')` consumers.
 *
 * @returns SQL expression yielding the PR URL or null, aliased `pr_url`.
 */
function depPrUrlExpr() {
  return sql<string | null>`(
    SELECT ${taskLinks.url} FROM ${taskLinks}
    WHERE ${taskLinks.taskId} = ${tasks.id}
      AND ${taskLinks.kind} = 'pull_request'
    ORDER BY ${taskLinks.createdAt} ASC
    LIMIT 1
  )`.as("pr_url");
}

/**
 * Dependency-task summaries for an id list, as a lazy batch statement. `ANY` over a
 * typed uuid array keeps the statement valid for an empty id list. Map the
 * rows with {@link mapDependencyTaskRows}.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project the dependency tasks belong to.
 * @param taskIds - UUIDs of the dependency tasks.
 * @returns Lazy select yielding dependency-task rows.
 */
export function dependencyTasksStmt(
  read: ReadConn,
  projectId: string,
  taskIds: readonly string[],
) {
  return read
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      executionRecord: tasks.executionRecord,
      sequenceNumber: tasks.sequenceNumber,
      identifier: projects.identifier,
      prUrl: depPrUrlExpr(),
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(tasks.projectId, projectId),
        sql`${tasks.id} = ANY(${uuidArray(taskIds)})`,
      ),
    );
}

/**
 * Map dependency-task rows to {@link DependencyTaskInfo}, composing each
 * `taskRef`.
 *
 * @param rows - Rows from {@link dependencyTasksStmt}.
 * @returns Dep-task projections including `executionRecord` and `taskRef`.
 */
export function mapDependencyTaskRows(
  rows: readonly (TaskSummaryRow & {
    executionRecord: string | null;
    prUrl: string | null;
  })[],
): DependencyTaskInfo[] {
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    executionRecord: r.executionRecord,
    taskRef: composeTaskRef(asIdentifier(r.identifier), r.sequenceNumber),
    prUrl: r.prUrl,
  }));
}

/**
 * Direct cancelled prerequisites, as a lazy batch statement, for the
 * planning bundle's "Abandoned Approaches" section. Rationale-less
 * cancellations are included so an abandoned dep never vanishes from the
 * lens. Direct 1-hop `depends_on` targets only — the effective-dep walk
 * treats cancelled tasks as transparent, so they never appear in the
 * closure's `deps`. Map the rows with {@link mapDependencyTaskRows}.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project the task belongs to.
 * @param taskId - UUID of the planning task.
 * @returns Lazy select yielding cancelled-dep rows.
 */
export function cancelledDepRecordsStmt(
  read: ReadConn,
  projectId: string,
  taskId: string,
) {
  return read
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      executionRecord: tasks.executionRecord,
      sequenceNumber: tasks.sequenceNumber,
      identifier: projects.identifier,
      prUrl: depPrUrlExpr(),
    })
    .from(taskEdges)
    .innerJoin(tasks, eq(taskEdges.targetTaskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(taskEdges.sourceTaskId, taskId),
        eq(taskEdges.edgeType, "depends_on"),
        eq(tasks.projectId, projectId),
        eq(tasks.status, "cancelled"),
      ),
    );
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

/**
 * Fetch slim task rows for every task in a project. Used by graph
 * algorithms (`buildEffectiveDepGraph`) that only need a small slice.
 *
 * @param projectId - UUID of the project.
 * @param conn - RLS-scoped {@link Conn} from an active `withUserContext` frame.
 * @returns Slim rows for every task in the project.
 */
export async function listTasksForGraph(projectId: string, conn: Conn) {
  return conn
    .select(graphTaskColumns)
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(tasks.sequenceNumber));
}

/** Columns the dependency-graph builders read; one source for both paths. */
const graphTaskColumns = {
  id: tasks.id,
  title: tasks.title,
  status: tasks.status,
  sequenceNumber: tasks.sequenceNumber,
  tags: tasks.tags,
  priority: tasks.priority,
} as const;

/**
 * {@link listTasksForGraph} as a lazy batch statement.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project.
 * @returns Lazy select yielding slim graph rows for every project task.
 */
export function listTasksForGraphStmt(read: ReadConn, projectId: string) {
  return read
    .select(graphTaskColumns)
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(tasks.sequenceNumber));
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
   * Optional PR URL. Sugar: upserts a `task_links` row with kind forced to
   * `pull_request` ({@link classifyLink} validates the URL and derives the
   * label) inside the same transaction as the task insert. Not a column on
   * `tasks`; stripped before the typed insert.
   */
  prUrl?: string | null;
  /**
   * Optional initial acceptance criteria. These live in
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
 * @param organizationId - Owning team id when the caller already resolved it
 *   (e.g. from `assertProjectAccessTx`); skips the project lookup.
 * @throws ForbiddenError with a generic message and no `resourceId` if any
 *   supplied id is not a team member. Per-id details are deliberately
 *   withheld so the error cannot be used as a membership oracle.
 */
export async function assertAssigneesInTeam(
  tx: Tx,
  projectId: string,
  userIds: string[],
  organizationId?: string,
): Promise<void> {
  if (userIds.length === 0) return;
  let orgId = organizationId;
  if (!orgId) {
    const [proj] = await tx
      .select({ organizationId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!proj) throw new ProjectNotFoundError(projectId);
    orgId = proj.organizationId;
  }
  const dedup = [...new Set(userIds)];
  const rows = await executeRaw<{ user_id: string }>(
    tx,
    sql`SELECT user_id FROM public.org_member_user_ids_visible(${orgId}::uuid, ${uuidArray(dedup)})`,
  );
  const found = new Set(rows.map((r) => r.user_id));
  const allInTeam = dedup.every((id) => found.has(id));
  if (!allInTeam) {
    throw new ForbiddenError(
      "One or more assignees are not members of this team.",
      "team",
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
export async function setTaskAssignees(
  tx: Tx,
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

/** A caller-computed sequence/order/identifier allocation for one task row. */
export type TaskAllocation = {
  sequenceNumber: number;
  order: number;
  identifier: string;
};

/** Summary of a created task; `taskRef` is composed from the allocation. */
export type CreatedTaskSummary = {
  id: string;
  title: string;
  projectId: string;
  order: number;
  sequenceNumber: number;
  taskRef: TaskRef;
};

/**
 * Normalize and format a create-task payload before any transaction opens:
 * mint criteria/decision ids, markdown-format text bodies (and each criterion
 * / decision body), and pre-validate `prUrl`. Shared by `createTask` and the
 * batch path so the work runs exactly once per item.
 *
 * @param data - Raw create-task input.
 * @returns The input with normalized/formatted criteria, decisions, and text.
 * @throws ForbiddenError when `prUrl` is a malformed link.
 */
export async function prepareCreateTaskInput(
  data: CreateTaskInput,
): Promise<CreateTaskInput> {
  const normalizedCriteria = Array.isArray(data.acceptanceCriteria)
    ? normalizeCriteria(data.acceptanceCriteria)
    : undefined;
  const normalizedDecisions = Array.isArray(data.decisions)
    ? normalizeDecisions(data.decisions)
    : undefined;

  const formatInput: Record<string, unknown> = { ...data };
  if (normalizedCriteria) formatInput.acceptanceCriteria = normalizedCriteria;
  if (normalizedDecisions) formatInput.decisions = normalizedDecisions;
  const formatted = (await formatTaskMarkdownFields(
    formatInput,
  )) as CreateTaskInput;

  if (typeof formatted.prUrl === "string") {
    try {
      classifyLink(formatted.prUrl);
    } catch (e) {
      if (e instanceof MalformedLinkError) {
        throw new ForbiddenError("Invalid prUrl", "task", data.projectId);
      }
      throw e;
    }
  }
  return formatted;
}

/**
 * Insert one task row plus its child records inside an existing RLS-scoped
 * transaction, using a caller-computed allocation. The composable seam shared
 * by `createTask` (single) and `createTasksBatch`. `data` MUST already be
 * normalized/formatted via {@link prepareCreateTaskInput}, and any
 * `assigneeIds` MUST already be membership-checked via
 * {@link assertAssigneesInTeam}; the allocation's sequence number and order
 * override any values on `data`.
 *
 * @param tx - Active RLS-scoped transaction handle.
 * @param actor - Resolved actor descriptor for activity attribution and the
 *   `created_by` column on any prUrl link.
 * @param data - Prepared create-task input (criteria/decisions normalized,
 *   text formatted, prUrl pre-validated, assignees pre-checked).
 * @param alloc - Allocated sequence number, order, and project identifier.
 * @param opts - When `deferActivity` is true, the `task_created` event is
 *   returned unwritten so the caller can batch the insert; otherwise it is
 *   written here.
 * @returns The created-task summary and the constructed `task_created` events.
 */
export async function createTaskTx(
  tx: Tx,
  actor: ActorDescriptor,
  data: CreateTaskInput,
  alloc: TaskAllocation,
  opts?: { deferActivity?: boolean },
): Promise<{ task: CreatedTaskSummary; events: ActivityEventInput[] }> {
  const formattedCriteria = Array.isArray(data.acceptanceCriteria)
    ? (data.acceptanceCriteria as AcceptanceCriterion[])
    : undefined;
  const formattedDecisions = Array.isArray(data.decisions)
    ? (data.decisions as Decision[])
    : undefined;

  // acceptanceCriteria, decisions, assigneeIds, and prUrl are not columns on
  // `tasks`; strip before the typed insert so the row spread does not poison
  // the values clause. Child-table writes happen below in the same transaction.
  const {
    assigneeIds,
    prUrl,
    acceptanceCriteria: _ac,
    decisions: _dec,
    ...taskFields
  } = data;
  void _ac;
  void _dec;

  const [task] = await tx
    .insert(tasks)
    .values({
      ...taskFields,
      order: alloc.order,
      sequenceNumber: alloc.sequenceNumber,
    })
    .returning();

  if (assigneeIds && assigneeIds.length > 0) {
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
        kind: "pull_request",
        url: classified.url,
        label: classified.label,
        createdBy: actor.userId,
      })
      .onConflictDoNothing({ target: [taskLinks.taskId, taskLinks.url] });
  }

  const events: ActivityEventInput[] = [
    {
      projectId: task.projectId,
      taskId: task.id,
      type: "task_created",
      summary: `created task "${task.title}"`,
    },
  ];
  if (!opts?.deferActivity) {
    await insertActivityEvents(tx, actor, events);
  }

  return {
    task: {
      id: task.id,
      title: task.title,
      projectId: task.projectId,
      order: task.order,
      sequenceNumber: task.sequenceNumber,
      taskRef: composeTaskRef(
        asIdentifier(alloc.identifier),
        task.sequenceNumber,
      ),
    },
    events,
  };
}

/**
 * Insert a new task under a project the caller has access to. The
 * project's team scope is verified by `assertProjectAccessTx` and inherited
 * by the new task — task team scope is never derived from the session.
 *
 * Uses a transaction-scoped PostgreSQL advisory lock keyed on the project UUID
 * to serialize concurrent task creation and prevent sequence_number collisions.
 * Computes order (append-to-end when unset) and sequenceNumber inside the lock.
 *
 * @param ctx - Resolved auth context.
 * @param data - Task fields. sequenceNumber assigned internally.
 * @returns Task summary with composed taskRef.
 * @throws ForbiddenError when the caller cannot access the project or an
 *   assigneeId is not a member of the project's team.
 * @throws ProjectNotFoundError when the project does not exist.
 * @throws TaskLimitError when the project's task cap is reached.
 */
export async function createTask(
  ctx: AuthContext,
  data: CreateTaskInput,
): Promise<CreatedTaskSummary> {
  const prepared = await prepareCreateTaskInput(data);

  const result = await withUserContext(ctx.userId, async (tx) => {
    const access = await assertProjectAccessTx(tx, prepared.projectId);
    if (prepared.assigneeIds && prepared.assigneeIds.length > 0) {
      await assertAssigneesInTeam(
        tx,
        prepared.projectId,
        prepared.assigneeIds,
        access.project.organizationId,
      );
    }
    await acquireProjectLock(tx, prepared.projectId);

    const [proj] = await tx
      .select({ identifier: projects.identifier })
      .from(projects)
      .where(eq(projects.id, prepared.projectId));
    if (!proj) throw new ProjectNotFoundError(prepared.projectId);

    const [maxRow] = await tx
      .select({
        maxOrder: sql<number>`COALESCE(MAX(${tasks.order}), -1)`,
        maxSeq: sql<number>`COALESCE(MAX(${tasks.sequenceNumber}), 0)`,
        taskCount: sql<number>`COUNT(*)`,
      })
      .from(tasks)
      .where(eq(tasks.projectId, prepared.projectId));

    const maxTasks = parseEnvInt(process.env.MAX_TASKS_PER_PROJECT, 50_000);
    if (Number(maxRow?.taskCount ?? 0) >= maxTasks) {
      throw new TaskLimitError(prepared.projectId, maxTasks);
    }

    const sequenceNumber = (maxRow?.maxSeq ?? 0) + 1;
    const order =
      prepared.order === undefined || prepared.order === 0
        ? (maxRow?.maxOrder ?? -1) + 1
        : prepared.order;

    const { task } = await createTaskTx(tx, ctx.actor, prepared, {
      sequenceNumber,
      order,
      identifier: proj.identifier,
    });
    return task;
  });

  emitTaskEvent(result.projectId, result.id, { metaChanged: true });
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

/**
 * Update result enriches the raw `Task` row with the post-write criteria
 * and decisions so callers that consult them (completion-protocol hint
 * checks in `lib/graph/tools/edit.ts`) see the same shape they saw on
 * the JSONB-storage path.
 *
 * Partial contract: `acceptanceCriteria` and `decisions` are the
 * freshly-fetched persisted state ONLY when `updateTask` wrote child
 * tables (criteria or decisions passed) or transitioned `status`. On any
 * other path (title / description / tags / files / assignees / prUrl
 * only), both fields are returned as `null` — the post-write refetch is
 * skipped to save a round-trip.
 *
 * `null` means "the field was not read or written on this update path;
 * consult `getTaskFull` if you need the current value". An empty array
 * means the refetch ran and the child table is genuinely empty.
 *
 * Read these fields ONLY when your call set one of:
 *   - `input.acceptanceCriteria`
 *   - `input.decisions`
 *   - `input.status`
 *
 * For any other caller, re-fetch via `getTaskFull(ctx, taskId)` instead.
 */
export type UpdateTaskResult = typeof tasks.$inferSelect & {
  acceptanceCriteria: AcceptanceCriterion[] | null;
  decisions: Decision[] | null;
};

/**
 * Apply a `prUrl` write inside an open transaction. `null` clears every
 * `pull_request` link; a URL guarantees a `pull_request`-kind link at that
 * URL: the kind is forced so non-GitHub/GitLab PR hosts satisfy the review
 * contract, and a same-URL link of another kind is converted in place,
 * keeping any user-authored label.
 * Other `pull_request` links are untouched — a task may carry several PRs.
 * A same-URL `pull_request` link makes the call an idempotent no-op.
 *
 * @param tx - Active RLS-scoped transaction.
 * @param taskId - Owning task id.
 * @param projectId - Owning project id for the event row.
 * @param classified - Classified link, or null to clear pull_request links.
 * @param createdBy - Caller id for the `created_by` column on inserts.
 * @returns The activity event, or null when nothing changed.
 */
export async function applyPrUrlTx(
  tx: Tx,
  taskId: string,
  projectId: string,
  classified: ClassifiedLink | null,
  createdBy: string,
): Promise<ActivityEventInput | null> {
  if (classified === null) {
    const deleted = await tx
      .delete(taskLinks)
      .where(
        and(eq(taskLinks.taskId, taskId), eq(taskLinks.kind, "pull_request")),
      )
      .returning({ id: taskLinks.id });
    return deleted.length > 0
      ? {
          projectId,
          taskId,
          type: "link_removed",
          summary: "removed the pull request link",
        }
      : null;
  }
  const [existing] = await tx
    .select({
      id: taskLinks.id,
      kind: taskLinks.kind,
      label: taskLinks.label,
    })
    .from(taskLinks)
    .where(and(eq(taskLinks.taskId, taskId), eq(taskLinks.url, classified.url)))
    .limit(1);
  if (existing?.kind === "pull_request") return null;
  if (existing) {
    await tx
      .update(taskLinks)
      .set({ kind: "pull_request" })
      .where(eq(taskLinks.id, existing.id));
    return {
      projectId,
      taskId,
      type: "link_updated",
      summary: `updated link to ${existing.label ?? classified.label ?? "pull request"}`,
      targetRef: classified.url,
    };
  }
  const [inserted] = await tx
    .insert(taskLinks)
    .values({
      taskId,
      kind: "pull_request",
      url: classified.url,
      label: classified.label,
      createdBy,
    })
    .onConflictDoNothing({ target: [taskLinks.taskId, taskLinks.url] })
    .returning({ id: taskLinks.id });
  return inserted
    ? {
        projectId,
        taskId,
        type: "link_added",
        summary: `linked ${classified.label ?? "pull request"}`,
        targetRef: classified.url,
      }
    : null;
}

/**
 * Update a task and emit `activity_events` for the changes. Protected fields
 * (id, projectId, sequenceNumber, createdAt, updatedAt) are stripped before
 * the write so a malformed input cannot reassign a task across projects or
 * forge timestamps.
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task to update.
 * @param input - Partial fields to update.
 * @param overwriteArrays - When true, replace array fields instead of appending.
 * @returns The updated row. `acceptanceCriteria` / `decisions` reflect the
 *   freshly-fetched persisted state ONLY when this call wrote child tables
 *   (criteria or decisions in `input`) or changed `status`. On any other
 *   path both fields are returned as `null` — see the `UpdateTaskResult`
 *   JSDoc for the full partial-contract notes.
 */
export async function updateTask(
  ctx: AuthContext,
  taskId: string,
  input: TaskUpdate,
  overwriteArrays = false,
): Promise<UpdateTaskResult> {
  let changes: Record<string, unknown> = { ...input };
  for (const key of PROTECTED_TASK_FIELDS) {
    if (key in changes) delete changes[key];
  }
  // assigneeIds writes the junction table, not the tasks row. Pull it
  // out so the typed `tx.update(tasks).set(...)` does not see an
  // unknown column. Empty array in append mode is a definitional no-op
  // (matches decisions/files merge semantics: empty incoming ↦
  // unchanged), so normalize to `undefined` and skip both the junction
  // write and the activity-event emission below.
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
  const wroteChildren =
    formattedCriteria !== undefined || formattedDecisions !== undefined;
  const statusChanged = typeof input.status === "string";
  const refetchNeeded = wroteChildren || statusChanged;
  const result = await withUserContext(ctx.userId, async (tx) => {
    await assertTaskAccessTx(tx, taskId);
    // FOR UPDATE serializes concurrent writers on the row: the slim
    // visibility gate compares `changes` against this baseline, and a
    // stale read could revert a concurrent slim write without moving the
    // meta clock, freezing the graph validator on a stale 304.
    const [current] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .for("update");
    if (!current) throw new ForbiddenError("Forbidden", "task", taskId);

    // After normalization above, an `assigneeIds: []` in default-append
    // mode collapses to `assigneeIds === undefined`. If that was the
    // only field on the call AND nothing else needs writing (no
    // assignee write, no prUrl write, no criteria/decisions write), the
    // call is a pure no-op: skip the tasks-row bump, the empty
    // activity-event emission, and the downstream realtime emit.
    if (
      Object.keys(changes).length === 0 &&
      assigneeIds === undefined &&
      !hasPrUrl &&
      formattedCriteria === undefined &&
      formattedDecisions === undefined
    ) {
      wasNoOp = true;
      return {
        row: current,
        criteriaResult: null,
        decisionsResult: null,
        metaChanged: false,
      };
    }

    if (!overwriteArrays && Array.isArray(changes.files)) {
      const existing = (current.files ?? []) as string[];
      const merged = new Set([...existing, ...(changes.files as string[])]);
      changes.files = [...merged];
    }

    let row = current;
    const rowClass = classifyTaskRowChanges(current, changes);
    if (Object.keys(changes).length > 0) {
      const [updatedRow] = await tx
        .update(tasks)
        .set({
          ...changes,
          updatedAt: dbClockStamp(),
        })
        .where(eq(tasks.id, taskId))
        .returning();
      row = updatedRow;
    } else {
      // No `tasks` row column changed; still bump updated_at so the cache
      // validator advances on this turn.
      const [updatedRow] = await tx
        .update(tasks)
        .set({
          updatedAt: dbClockStamp(),
        })
        .where(eq(tasks.id, taskId))
        .returning();
      row = updatedRow;
    }

    // Discrete activity: scalar/tag diff now, collection diffs after the
    // child-table writes below. Snapshot child + assignee state pre-write.
    const eventInputs: ActivityEventInput[] = diffTaskChanges(
      current.projectId,
      taskId,
      current,
      changes as Partial<Task>,
    );
    const childrenBefore =
      formattedCriteria !== undefined || formattedDecisions !== undefined
        ? await fetchTaskChildren(tx, taskId)
        : null;
    const assigneesBefore =
      assigneeIds !== undefined
        ? (
            await tx
              .select({ userId: taskAssignees.userId })
              .from(taskAssignees)
              .where(eq(taskAssignees.taskId, taskId))
          ).map((a) => a.userId)
        : null;

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

    let childrenAfter: Awaited<ReturnType<typeof fetchTaskChildren>> | null =
      null;
    if (childrenBefore) {
      childrenAfter = await fetchTaskChildren(tx, taskId);
      if (formattedCriteria !== undefined) {
        eventInputs.push(
          ...diffCriteria(
            current.projectId,
            taskId,
            (childrenBefore.acceptance_criteria ?? []).map((c) => ({
              id: c.id,
              text: c.text,
              checked: c.checked,
            })),
            (childrenAfter.acceptance_criteria ?? []).map((c) => ({
              id: c.id,
              text: c.text,
              checked: c.checked,
            })),
          ),
        );
      }
      if (formattedDecisions !== undefined) {
        eventInputs.push(
          ...diffDecisions(
            current.projectId,
            taskId,
            (childrenBefore.decisions ?? []).map((d) => ({
              id: d.id,
              text: d.text,
            })),
            (childrenAfter.decisions ?? []).map((d) => ({
              id: d.id,
              text: d.text,
            })),
          ),
        );
      }
    }
    let assigneesChanged = false;
    let assigneesAfter: string[] | null = null;
    if (assigneesBefore && assigneeIds !== undefined) {
      assigneesAfter = (
        await tx
          .select({ userId: taskAssignees.userId })
          .from(taskAssignees)
          .where(eq(taskAssignees.taskId, taskId))
      ).map((a) => a.userId);
      assigneesChanged = assigneeSetChanged(assigneesBefore, assigneesAfter);
      eventInputs.push(
        ...diffAssignees(
          current.projectId,
          taskId,
          assigneesBefore,
          assigneesAfter,
        ),
      );
    }

    if (hasPrUrl) {
      const event = await applyPrUrlTx(
        tx,
        taskId,
        current.projectId,
        typeof prUrl === "string" && prUrl.length > 0
          ? classifyLink(prUrl)
          : null,
        ctx.userId,
      );
      if (event) eventInputs.push(event);
    }

    if (eventInputs.length > 0) {
      await insertActivityEvents(tx, ctx.actor, eventInputs);
    }
    let criteriaResult: AcceptanceCriterion[] | null = null;
    let decisionsResult: Decision[] | null = null;
    if (refetchNeeded) {
      const children = childrenAfter ?? (await fetchTaskChildren(tx, taskId));
      criteriaResult = (children.acceptance_criteria ?? []).map((c) => ({
        id: c.id,
        text: c.text,
        checked: c.checked,
      }));
      decisionsResult = (children.decisions ?? []).map((d) => ({
        id: d.id,
        text: d.text,
        source: d.source as Decision["source"],
        date: d.date,
      }));
    }

    // Child-table writes land after the row update: a criteria-presence
    // flip changes the task's own derived state, so it counts as
    // state-affecting; an assignee-set change is slim-visible but
    // state-neutral, so it rides the patch.
    const criteriaPresenceFlipped =
      childrenBefore !== null &&
      childrenAfter !== null &&
      (childrenBefore.acceptance_criteria ?? []).length > 0 !==
        (childrenAfter.acceptance_criteria ?? []).length > 0;
    const metaChanged =
      rowClass.metaChanged || criteriaPresenceFlipped || assigneesChanged;
    const stateAffecting = rowClass.stateAffecting || criteriaPresenceFlipped;
    const patch =
      metaChanged && !stateAffecting
        ? {
            ...taskSlimPatchFromRow(row),
            ...(assigneesAfter !== null
              ? {
                  assigneeUserIds: assigneesAfter,
                  assigneeCount: assigneesAfter.length,
                }
              : {}),
          }
        : undefined;
    return { row, criteriaResult, decisionsResult, metaChanged, patch };
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
    emitTaskEvent(result.row.projectId, taskId, {
      metaChanged: result.metaChanged,
      updatedAt: result.row.updatedAt,
      ...(result.patch !== undefined ? { patch: result.patch } : {}),
    });
  }
  return Object.assign(result.row, {
    acceptanceCriteria: result.criteriaResult,
    decisions: result.decisionsResult,
  });
}

// ---------------------------------------------------------------------------
// Delete task
// ---------------------------------------------------------------------------

/**
 * Delete a task and remove all referencing edges.
 *
 * The parent project's `updated_at` bump (which keeps the conditional-GET
 * validator strictly increasing and the home-grid sort fresh) is owned by
 * the `tasks_touch_project_delete` trigger in `docker/rls-functions.sql`.
 * The writes run in a single transaction so concurrent readers either see
 * the pre- or post-delete state, never an in-between.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task to delete.
 * @returns Deletion summary.
 * @throws ProjectArchivedError when the parent project is archived (read-only).
 */
export async function deleteTask(ctx: AuthContext, taskId: string) {
  const { projectId, deletedEdges } = await withUserContext(
    ctx.userId,
    async (tx) => {
      const task = await assertTaskAccessTx(tx, taskId);
      if (task.projectStatus === "archived") {
        throw new ProjectArchivedError(task.projectIdentifier);
      }

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

      return { projectId: task.projectId, deletedEdges: removed };
    },
  );

  emitTaskEvent(projectId, taskId, { metaChanged: true });
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
  const { task, edgeRows } = await withUserContext(ctx.userId, async (tx) => {
    const task = await assertTaskAccessTx(tx, taskId);
    const edgeRows = await tx
      .select({ id: taskEdges.id })
      .from(taskEdges)
      .where(
        or(
          eq(taskEdges.sourceTaskId, taskId),
          eq(taskEdges.targetTaskId, taskId),
        ),
      );
    return { task, edgeRows };
  });

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
  let classified;
  try {
    classified = classifyLink(url);
  } catch (e) {
    if (e instanceof MalformedLinkError) {
      throw new ForbiddenError("Invalid url", "task", taskId);
    }
    throw e;
  }

  const { row, projectId, updatedAt } = await withUserContext(
    ctx.userId,
    async (tx) => {
      const task = await assertTaskAccessTx(tx, taskId);
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
          .where(
            and(
              eq(taskLinks.taskId, taskId),
              eq(taskLinks.url, classified.url),
            ),
          )
          .limit(1);
        if (!existing)
          throw new Error("Link insert reported conflict but no row exists");
        row = existing;
      }

      const [stamped] = await tx
        .update(tasks)
        .set({ updatedAt: dbClockStamp() })
        .where(eq(tasks.id, taskId))
        .returning({ updatedAt: tasks.updatedAt });
      if (!stamped) throw new ForbiddenError("Forbidden", "task", taskId);

      if (inserted) {
        await insertActivityEvents(tx, ctx.actor, [
          {
            projectId: task.projectId,
            taskId,
            type: "link_added",
            summary: `linked ${classified.label ?? classified.kind}`,
            targetRef: classified.url,
          },
        ]);
      }
      return { row, projectId: task.projectId, updatedAt: stamped.updatedAt };
    },
  );

  emitTaskEvent(projectId, taskId, { metaChanged: false, updatedAt });
  return row;
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
  if (!isUuid(linkId)) throw new ForbiddenError("Forbidden", "task", linkId);
  const result = await withUserContext(ctx.userId, async (tx) => {
    const [row] = await tx
      .select({
        linkId: taskLinks.id,
        taskId: taskLinks.taskId,
        projectId: tasks.projectId,
        url: taskLinks.url,
        label: taskLinks.label,
        kind: taskLinks.kind,
      })
      .from(taskLinks)
      .innerJoin(tasks, eq(tasks.id, taskLinks.taskId))
      .where(eq(taskLinks.id, linkId))
      .limit(1);
    if (!row) throw new ForbiddenError("Forbidden", "task", linkId);

    await tx.delete(taskLinks).where(eq(taskLinks.id, linkId));
    const [stamped] = await tx
      .update(tasks)
      .set({ updatedAt: dbClockStamp() })
      .where(eq(tasks.id, row.taskId))
      .returning({ updatedAt: tasks.updatedAt });
    if (!stamped) throw new ForbiddenError("Forbidden", "task", row.taskId);

    await insertActivityEvents(tx, ctx.actor, [
      {
        projectId: row.projectId,
        taskId: row.taskId,
        type: "link_removed",
        summary: `removed link ${row.label ?? row.kind}`,
        targetRef: row.url,
      },
    ]);
    return { ...row, updatedAt: stamped.updatedAt };
  });

  emitTaskEvent(result.projectId, result.taskId, {
    metaChanged: false,
    updatedAt: result.updatedAt,
  });
  return { id: result.linkId };
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
  if (!isUuid(linkId)) throw new ForbiddenError("Forbidden", "task", linkId);
  let classified;
  try {
    classified = classifyLink(url);
  } catch (e) {
    if (e instanceof MalformedLinkError) {
      throw new ForbiddenError("Invalid url", "task", linkId);
    }
    throw e;
  }

  const result = await withUserContext(ctx.userId, async (tx) => {
    const [row] = await tx
      .select({
        link: taskLinks,
        projectId: tasks.projectId,
      })
      .from(taskLinks)
      .innerJoin(tasks, eq(tasks.id, taskLinks.taskId))
      .where(eq(taskLinks.id, linkId))
      .limit(1);
    if (!row) throw new ForbiddenError("Forbidden", "task", linkId);

    if (classified.url !== row.link.url) {
      const [conflict] = await tx
        .select({ id: taskLinks.id })
        .from(taskLinks)
        .where(
          and(
            eq(taskLinks.taskId, row.link.taskId),
            eq(taskLinks.url, classified.url),
            ne(taskLinks.id, linkId),
          ),
        )
        .limit(1);
      if (conflict) {
        throw new ForbiddenError("Duplicate url", "task", row.link.taskId);
      }
    }

    const [updated] = await tx
      .update(taskLinks)
      .set({
        kind: classified.kind,
        url: classified.url,
        label: classified.label,
      })
      .where(eq(taskLinks.id, linkId))
      .returning();
    const [stamped] = await tx
      .update(tasks)
      .set({ updatedAt: dbClockStamp() })
      .where(eq(tasks.id, row.link.taskId))
      .returning({ updatedAt: tasks.updatedAt });
    if (!stamped)
      throw new ForbiddenError("Forbidden", "task", row.link.taskId);

    await insertActivityEvents(tx, ctx.actor, [
      {
        projectId: row.projectId,
        taskId: row.link.taskId,
        type: "link_updated",
        summary: `updated link to ${classified.label ?? classified.kind}`,
        targetRef: classified.url,
      },
    ]);
    return {
      updated,
      projectId: row.projectId,
      taskId: row.link.taskId,
      updatedAt: stamped.updatedAt,
    };
  });

  emitTaskEvent(result.projectId, result.taskId, {
    metaChanged: false,
    updatedAt: result.updatedAt,
  });
  return result.updated;
}
