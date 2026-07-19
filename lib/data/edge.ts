import "server-only";

import { and, eq, inArray, or, sql } from "drizzle-orm";
import { uuidArray, type Conn, type ReadConn } from "@/lib/db/raw";
import { withUserContext, withUserContextRead, type Tx } from "@/lib/db/rls";
import { projects, tasks, taskEdges, type NewTaskEdge } from "@/lib/db/schema";
import type { EdgeType } from "@/lib/types";
import { asIdentifier, composeTaskRef } from "@/lib/graph/identifier";
import { fetchDependencyChain } from "@/lib/db/raw/fetch-dependency-chain";
import { insertActivityEvents } from "@/lib/data/activity";
import { formatMarkdown } from "@/lib/markdown/format";
import type { AuthContext } from "@/lib/auth/context";
import {
  ForbiddenError,
  assertTaskAccessTx,
  assertTaskGateRows,
  assertValidTaskId,
  isUuid,
} from "@/lib/auth/authorization";
import { taskAccessGateStmt } from "@/lib/data/access";
import { emitEdgeMutation } from "@/lib/realtime/events";
import {
  CrossProjectEdgeError,
  DuplicateEdgeError,
  EdgeCycleError,
  ProjectArchivedError,
  SelfEdgeError,
} from "@/lib/graph/errors";

// ---------------------------------------------------------------------------
// Edge queries
// ---------------------------------------------------------------------------

/**
 * Look up an edge by (source, target, type) when the caller can access
 * both endpoints. Returns the row, or null when no such edge exists.
 * @param ctx - Resolved auth context.
 * @param sourceTaskId - UUID of the source task.
 * @param targetTaskId - UUID of the target task.
 * @param edgeType - Edge relationship type.
 * @throws ForbiddenError when either endpoint is cross-team.
 */
export async function findEdgeByNodes(
  ctx: AuthContext,
  sourceTaskId: string,
  targetTaskId: string,
  edgeType: EdgeType,
) {
  return withUserContext(ctx.userId, async (tx) => {
    await Promise.all([
      assertTaskAccessTx(tx, sourceTaskId),
      assertTaskAccessTx(tx, targetTaskId),
    ]);
    const [row] = await tx
      .select()
      .from(taskEdges)
      .where(
        and(
          eq(taskEdges.sourceTaskId, sourceTaskId),
          eq(taskEdges.targetTaskId, targetTaskId),
          eq(taskEdges.edgeType, edgeType),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * Fetch all edges where a task is source or target.
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns Array of edges.
 */
export async function getTaskEdges(ctx: AuthContext, taskId: string) {
  return withUserContext(ctx.userId, async (tx) => {
    await assertTaskAccessTx(tx, taskId);
    return tx
      .select()
      .from(taskEdges)
      .where(
        or(
          eq(taskEdges.sourceTaskId, taskId),
          eq(taskEdges.targetTaskId, taskId),
        ),
      );
  });
}

// ---------------------------------------------------------------------------
// Task edges with details
// ---------------------------------------------------------------------------

/** An edge with full connected task details. */
export type DetailedEdge = {
  edgeId: string;
  edgeType: EdgeType;
  direction: "outgoing" | "incoming";
  note: string;
  connectedTask: {
    id: string;
    taskRef: string;
    title: string;
    status: string;
  };
};

/**
 * Fetch all edges on a task with connected task titles and statuses. One
 * read batch for the gate plus the edge rows, and a second for the
 * connected-task detail when edges exist.
 *
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns Array of detailed edges.
 * @throws ForbiddenError when the caller cannot access the task.
 */
export async function getTaskEdgesDetailed(
  ctx: AuthContext,
  taskId: string,
): Promise<DetailedEdge[]> {
  assertValidTaskId(taskId);
  const [gateRows, edges] = await withUserContextRead(ctx.userId, (read) => [
    taskAccessGateStmt(read, taskId),
    taskEdgesStmt(read, taskId),
  ]);
  assertTaskGateRows(taskId, gateRows);
  if (edges.length === 0) return [];

  const ids = connectedTaskIds(taskId, edges);
  const [taskRows] = await withUserContextRead(ctx.userId, (read) => [
    connectedTaskInfoStmt(read, ids),
  ]);
  return assembleDetailedEdges(taskId, edges, taskRows);
}

/** Edge columns the detailed-edge assembly reads. */
type EdgeRow = {
  id: string;
  sourceTaskId: string;
  targetTaskId: string;
  edgeType: EdgeType;
  note: string;
};

/** Connected-task projection consumed by {@link assembleDetailedEdges}. */
type ConnectedTaskRow = {
  id: string;
  title: string;
  status: string;
  sequenceNumber: number;
  identifier: string;
};

/**
 * Distinct opposite-endpoint task ids for a task's edges.
 *
 * @param taskId - UUID of the anchor task.
 * @param edges - Edge rows touching the anchor.
 * @returns Connected task ids, deduplicated.
 */
export function connectedTaskIds(
  taskId: string,
  edges: readonly EdgeRow[],
): string[] {
  const ids = new Set<string>();
  for (const edge of edges) {
    ids.add(
      edge.sourceTaskId === taskId ? edge.targetTaskId : edge.sourceTaskId,
    );
  }
  return [...ids];
}

/**
 * All edges touching a task, as a lazy batch statement. Pair with
 * {@link connectedTaskInfoStmt} in a follow-up batch and assemble via
 * {@link assembleDetailedEdges}.
 *
 * @param read - Read statement-building handle.
 * @param taskId - UUID of the task (matched on either endpoint).
 * @returns Lazy select yielding full edge rows.
 */
export function taskEdgesStmt(read: ReadConn, taskId: string) {
  return read
    .select()
    .from(taskEdges)
    .where(
      or(
        eq(taskEdges.sourceTaskId, taskId),
        eq(taskEdges.targetTaskId, taskId),
      ),
    );
}

/**
 * The `relates_to` edges touching a task, as a lazy batch statement. The
 * closure resolvers batch this alongside the `depends_on` walks so agent and
 * planning bundles can render non-blocking relations; pair with
 * {@link connectedTaskInfoStmt} and assemble via
 * {@link assembleDetailedEdges}.
 *
 * @param read - Read statement-building handle.
 * @param taskId - UUID of the task (matched on either endpoint).
 * @returns Lazy select yielding edge rows.
 */
export function relatedEdgesStmt(read: ReadConn, taskId: string) {
  return read
    .select({
      id: taskEdges.id,
      sourceTaskId: taskEdges.sourceTaskId,
      targetTaskId: taskEdges.targetTaskId,
      edgeType: taskEdges.edgeType,
      note: taskEdges.note,
    })
    .from(taskEdges)
    .where(
      and(
        eq(taskEdges.edgeType, "relates_to"),
        or(
          eq(taskEdges.sourceTaskId, taskId),
          eq(taskEdges.targetTaskId, taskId),
        ),
      ),
    );
}

/**
 * Every edge touching any task in an id set, as a lazy batch statement. One
 * `ANY`-over-source OR `ANY`-over-target scan covers the whole frontier in a
 * single round-trip — the batch twin of {@link taskEdgesStmt} for the 2-hop
 * neighbors walk. `ANY` over a typed uuid array keeps it valid for an empty set.
 *
 * @param read - Read statement-building handle.
 * @param taskIds - Frontier task ids (matched on either endpoint).
 * @returns Lazy select yielding full edge rows.
 */
export function taskEdgesForManyStmt(
  read: ReadConn,
  taskIds: readonly string[],
) {
  return read
    .select({
      id: taskEdges.id,
      sourceTaskId: taskEdges.sourceTaskId,
      targetTaskId: taskEdges.targetTaskId,
      edgeType: taskEdges.edgeType,
      note: taskEdges.note,
    })
    .from(taskEdges)
    .where(
      sql`${taskEdges.sourceTaskId} = ANY(${uuidArray(taskIds)})
        OR ${taskEdges.targetTaskId} = ANY(${uuidArray(taskIds)})`,
    );
}

/**
 * Connected-task detail rows for an id list, as a lazy batch statement.
 * `ANY` over a typed uuid array keeps the statement valid for an empty
 * id list.
 *
 * @param read - Read statement-building handle.
 * @param taskIds - Connected task ids from {@link connectedTaskIds}.
 * @returns Lazy select yielding {@link ConnectedTaskRow}s.
 */
export function connectedTaskInfoStmt(
  read: ReadConn,
  taskIds: readonly string[],
) {
  return read
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      sequenceNumber: tasks.sequenceNumber,
      identifier: projects.identifier,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(sql`${tasks.id} = ANY(${uuidArray(taskIds)})`);
}

/**
 * Join edge rows with their connected-task details into the
 * {@link DetailedEdge} projection. Edges whose opposite endpoint is not in
 * `taskRows` (RLS-invisible) are dropped, matching the interactive path.
 *
 * @param taskId - UUID of the anchor task.
 * @param edges - Edge rows touching the anchor.
 * @param taskRows - Connected-task detail rows.
 * @returns Detailed edges with direction and connected-task info.
 */
export function assembleDetailedEdges(
  taskId: string,
  edges: readonly EdgeRow[],
  taskRows: readonly ConnectedTaskRow[],
): DetailedEdge[] {
  const taskInfoMap = new Map<
    string,
    { taskRef: string; title: string; status: string }
  >();
  for (const t of taskRows) {
    taskInfoMap.set(t.id, {
      taskRef: composeTaskRef(asIdentifier(t.identifier), t.sequenceNumber),
      title: t.title,
      status: t.status,
    });
  }

  return edges
    .map((edge) => {
      const isOutgoing = edge.sourceTaskId === taskId;
      const connectedId = isOutgoing ? edge.targetTaskId : edge.sourceTaskId;
      const info = taskInfoMap.get(connectedId);
      if (!info) return null;
      return {
        edgeId: edge.id,
        edgeType: edge.edgeType,
        direction: isOutgoing ? ("outgoing" as const) : ("incoming" as const),
        note: edge.note,
        connectedTask: { id: connectedId, ...info },
      };
    })
    .filter((e): e is DetailedEdge => e !== null);
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

/**
 * Every edge in a project, as a lazy batch statement keyed on the project
 * id alone. Filters on the source endpoint only: the
 * `task_edges_same_project_immutable` trigger guarantees both endpoints
 * share a project, so the source-side scan returns every intra-project
 * edge exactly once (same invariant `getProjectGraphSlim` relies on).
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project.
 * @returns Lazy select yielding full edge rows.
 */
export function projectEdgesStmt(read: ReadConn, projectId: string) {
  return read
    .select({
      id: taskEdges.id,
      sourceTaskId: taskEdges.sourceTaskId,
      targetTaskId: taskEdges.targetTaskId,
      edgeType: taskEdges.edgeType,
      note: taskEdges.note,
    })
    .from(taskEdges)
    .innerJoin(tasks, eq(taskEdges.sourceTaskId, tasks.id))
    .where(eq(tasks.projectId, projectId));
}

/**
 * Every `depends_on` edge in a project, as a lazy batch statement — the
 * graph-substrate twin of {@link projectEdgesStmt} with the edge-type
 * filter owned by the statement (as `listDependsOnEdges` does on the
 * interactive path), so graph consumers cannot forget it.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project.
 * @returns Lazy select yielding `depends_on` edge endpoint rows.
 */
export function projectDependsOnEdgesStmt(read: ReadConn, projectId: string) {
  return read
    .select({
      sourceTaskId: taskEdges.sourceTaskId,
      targetTaskId: taskEdges.targetTaskId,
    })
    .from(taskEdges)
    .innerJoin(tasks, eq(taskEdges.sourceTaskId, tasks.id))
    .where(
      and(eq(tasks.projectId, projectId), eq(taskEdges.edgeType, "depends_on")),
    );
}

/**
 * Fetch every `depends_on` edge whose source task is in the supplied
 * id set. Used by graph algorithms.
 *
 * @param sourceTaskIds - Task ids to filter the source side on.
 * @param conn - RLS-scoped {@link Conn} from an active `withUserContext` frame.
 * @returns Edge endpoints (source/target only — no metadata).
 */
export async function listDependsOnEdges(sourceTaskIds: string[], conn: Conn) {
  if (sourceTaskIds.length === 0) return [];
  return conn
    .select({
      sourceTaskId: taskEdges.sourceTaskId,
      targetTaskId: taskEdges.targetTaskId,
    })
    .from(taskEdges)
    .where(
      and(
        sql`${taskEdges.sourceTaskId} IN ${sourceTaskIds}`,
        eq(taskEdges.edgeType, "depends_on"),
      ),
    );
}

// ---------------------------------------------------------------------------
// Edge mutations
// ---------------------------------------------------------------------------

/**
 * Every `depends_on` edge inside a project, in one join. Feeds the batch
 * cycle check without materializing the project's task-id list into an IN
 * clause; edges are intra-project, so joining the source endpoint suffices.
 *
 * @param conn - Connection or transaction handle.
 * @param projectId - Owning project id.
 * @returns Source/target pairs of every depends_on edge in the project.
 */
export async function listProjectDependsOnEdges(conn: Conn, projectId: string) {
  return conn
    .select({
      sourceTaskId: taskEdges.sourceTaskId,
      targetTaskId: taskEdges.targetTaskId,
    })
    .from(taskEdges)
    .innerJoin(tasks, eq(tasks.id, taskEdges.sourceTaskId))
    .where(
      and(eq(tasks.projectId, projectId), eq(taskEdges.edgeType, "depends_on")),
    );
}

/** Cap on intermediate nodes rendered in a cycle-rejection loop. */
const CYCLE_RENDER_MAX_INTERMEDIATES = 6;

/**
 * Compose taskRefs for an id list, for cycle-rejection error copy. One
 * `tasks JOIN projects` read on the error path only; ids that resolve to
 * no visible row are simply absent from the map (callers fall back to the
 * raw id).
 *
 * @param tx - Active RLS-scoped transaction handle.
 * @param taskIds - Task ids to resolve.
 * @returns Map from task id to composed taskRef.
 */
export async function composeTaskRefsForIds(
  tx: Tx,
  taskIds: readonly string[],
): Promise<Map<string, string>> {
  if (taskIds.length === 0) return new Map();
  const rows = await tx
    .select({
      id: tasks.id,
      identifier: projects.identifier,
      sequenceNumber: tasks.sequenceNumber,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(inArray(tasks.id, [...taskIds]));
  return new Map(
    rows.map((r) => [
      r.id,
      String(composeTaskRef(asIdentifier(r.identifier), r.sequenceNumber)),
    ]),
  );
}

/**
 * Build the ref-rendered loop for a cycle rejection: source → target →
 * (target's dependency chain up to the source) → source. Intermediates are
 * capped so a wide chain cannot flood the error.
 *
 * @param tx - Active RLS-scoped transaction handle.
 * @param sourceTaskId - Source of the attempted edge.
 * @param targetTaskId - Target of the attempted edge.
 * @param chain - Depth-ordered dependency chain of the target.
 * @returns The loop as taskRefs (raw ids where a ref cannot be composed).
 */
async function composeCycleLoopRefs(
  tx: Tx,
  sourceTaskId: string,
  targetTaskId: string,
  chain: { id: string }[],
): Promise<string[]> {
  const srcIdx = chain.findIndex((n) => n.id === sourceTaskId);
  const intermediates = chain
    .slice(0, srcIdx)
    .map((n) => n.id)
    .filter((id) => id !== targetTaskId)
    .slice(0, CYCLE_RENDER_MAX_INTERMEDIATES);
  const loopIds = [sourceTaskId, targetTaskId, ...intermediates, sourceTaskId];
  const refs = await composeTaskRefsForIds(tx, [...new Set(loopIds)]);
  return loopIds.map((id) => refs.get(id) ?? id);
}

/**
 * Create an edge between two tasks and emit `activity_events` for both.
 * Validates against self-edges, duplicates, and circular depends_on.
 *
 * @param ctx - Resolved auth context.
 * @param data - Edge fields to insert.
 * @returns The created edge.
 * @throws SelfEdgeError when source and target are the same task.
 * @throws ForbiddenError when either endpoint is not an accessible task.
 * @throws DuplicateEdgeError when an identical edge already exists.
 * @throws EdgeCycleError when a `depends_on` edge would close a cycle.
 * @throws ProjectArchivedError when the parent project is archived (read-only).
 */
export async function createEdge(
  ctx: AuthContext,
  data: Omit<NewTaskEdge, "id">,
) {
  if (data.sourceTaskId === data.targetTaskId) {
    throw new SelfEdgeError();
  }

  if (typeof data.note === "string" && data.note.trim()) {
    data = { ...data, note: (await formatMarkdown(data.note)) ?? data.note };
  }

  const { edge, projectId, projectStatus, projectIdentifier } =
    await withUserContext(ctx.userId, async (tx) => {
      const [sourceTask, targetTask] = await Promise.all([
        assertTaskAccessTx(tx, data.sourceTaskId),
        assertTaskAccessTx(tx, data.targetTaskId),
      ]);

      if (sourceTask.projectId !== targetTask.projectId) {
        throw new CrossProjectEdgeError();
      }
      if (sourceTask.projectStatus === "archived") {
        throw new ProjectArchivedError(sourceTask.projectIdentifier);
      }

      const [existing] = await tx
        .select({ id: taskEdges.id })
        .from(taskEdges)
        .where(
          and(
            eq(taskEdges.sourceTaskId, data.sourceTaskId),
            eq(taskEdges.targetTaskId, data.targetTaskId),
            eq(taskEdges.edgeType, data.edgeType),
          ),
        );
      if (existing) {
        throw new DuplicateEdgeError(
          data.sourceTaskId,
          data.targetTaskId,
          data.edgeType,
        );
      }

      if (data.edgeType === "depends_on") {
        const chain = await fetchDependencyChain(
          tx,
          data.targetTaskId,
          targetTask.projectId,
          10,
        );
        if (chain.some((node) => node.id === data.sourceTaskId)) {
          throw new EdgeCycleError(
            chain.map((node) => node.id),
            await composeCycleLoopRefs(
              tx,
              data.sourceTaskId,
              data.targetTaskId,
              chain,
            ),
          );
        }
      }

      const [created] = await tx.insert(taskEdges).values(data).returning();

      await insertActivityEvents(tx, ctx.actor, [
        {
          projectId: sourceTask.projectId,
          taskId: data.sourceTaskId,
          type: "edge_added",
          summary: `added ${data.edgeType} → target`,
          targetRef: data.targetTaskId,
          metadata: { direction: "outgoing", relation: data.edgeType },
        },
        {
          projectId: sourceTask.projectId,
          taskId: data.targetTaskId,
          type: "edge_added",
          summary: `added ${data.edgeType} ← source`,
          targetRef: data.sourceTaskId,
          metadata: { direction: "incoming", relation: data.edgeType },
        },
      ]);

      return {
        edge: created,
        projectId: sourceTask.projectId,
        projectStatus: sourceTask.projectStatus,
        projectIdentifier: sourceTask.projectIdentifier,
      };
    });

  emitEdgeMutation(projectId, data.sourceTaskId, data.targetTaskId, true);
  return {
    id: edge.id,
    sourceTaskId: edge.sourceTaskId,
    targetTaskId: edge.targetTaskId,
    edgeType: edge.edgeType,
    note: edge.note,
    projectStatus,
    projectIdentifier,
  };
}

/**
 * Fetch an edge and assert caller access via the parent project on a
 * supplied tx. Missing edge and cross-team access both surface as
 * `ForbiddenError({ resource: "edge" })`.
 *
 * @param tx - Active RLS transaction handle.
 * @param edgeId - UUID of the edge.
 * @returns The edge row and its parent project id.
 * @throws ForbiddenError on missing edge, malformed id, or cross-team access.
 * @throws ProjectArchivedError when the parent project is archived (read-only).
 */
async function loadAuthorizedEdgeTx(tx: Tx, edgeId: string) {
  if (!isUuid(edgeId)) {
    throw new ForbiddenError("Forbidden", "edge", edgeId);
  }
  const [edge] = await tx
    .select()
    .from(taskEdges)
    .where(eq(taskEdges.id, edgeId));
  if (!edge) throw new ForbiddenError("Forbidden", "edge", edgeId);
  let sourceTask;
  try {
    sourceTask = await assertTaskAccessTx(tx, edge.sourceTaskId);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      throw new ForbiddenError("Forbidden", "edge", edgeId);
    }
    throw err;
  }
  if (sourceTask.projectStatus === "archived") {
    throw new ProjectArchivedError(sourceTask.projectIdentifier);
  }
  return { edge, projectId: sourceTask.projectId };
}

/**
 * Update an edgeType and/or note. Endpoints are immutable through this
 * helper, so a cycle check is only needed on a type change INTO `depends_on`.
 *
 * @param ctx - Resolved auth context.
 * @param edgeId - UUID of the edge to update.
 * @param updates - Fields to update.
 * @returns The updated edge.
 * @throws ForbiddenError when the edge is not found or outside the caller's team.
 * @throws DuplicateEdgeError when the type change collides with an existing edge.
 * @throws EdgeCycleError when the type change would close a `depends_on` cycle.
 * @throws ProjectArchivedError when the parent project is archived (read-only).
 */
export async function updateEdge(
  ctx: AuthContext,
  edgeId: string,
  updates: { edgeType?: EdgeType; note?: string },
) {
  if (typeof updates.note === "string" && updates.note.trim()) {
    updates = {
      ...updates,
      note: (await formatMarkdown(updates.note)) ?? updates.note,
    };
  }

  const setClause: Record<string, unknown> = { updatedAt: new Date() };
  if (updates.edgeType !== undefined) setClause.edgeType = updates.edgeType;
  if (updates.note !== undefined) setClause.note = updates.note;

  const { updated, existing, projectId, typeChanged } = await withUserContext(
    ctx.userId,
    async (tx) => {
      const { edge: existing, projectId } = await loadAuthorizedEdgeTx(
        tx,
        edgeId,
      );

      // Edge type is the only slim-graph-visible column here; note-only
      // annotation edits keep the metadata clock still.
      const typeChanged =
        updates.edgeType !== undefined &&
        updates.edgeType !== existing.edgeType;
      if (typeChanged) setClause.metaUpdatedAt = new Date();

      let targetProjectIdForCycle: string | undefined;
      if (
        updates.edgeType &&
        updates.edgeType !== existing.edgeType &&
        updates.edgeType === "depends_on"
      ) {
        const targetTask = await assertTaskAccessTx(tx, existing.targetTaskId);
        targetProjectIdForCycle = targetTask.projectId;
      }

      if (updates.edgeType && updates.edgeType !== existing.edgeType) {
        const [dup] = await tx
          .select({ id: taskEdges.id })
          .from(taskEdges)
          .where(
            and(
              eq(taskEdges.sourceTaskId, existing.sourceTaskId),
              eq(taskEdges.targetTaskId, existing.targetTaskId),
              eq(taskEdges.edgeType, updates.edgeType),
            ),
          );
        if (dup) {
          throw new DuplicateEdgeError(
            existing.sourceTaskId,
            existing.targetTaskId,
            updates.edgeType,
            "Duplicate edge: an edge with this type already exists between these tasks.",
          );
        }
      }

      if (targetProjectIdForCycle) {
        const chain = await fetchDependencyChain(
          tx,
          existing.targetTaskId,
          targetProjectIdForCycle,
          10,
        );
        if (chain.some((node) => node.id === existing.sourceTaskId)) {
          throw new EdgeCycleError(
            chain.map((node) => node.id),
            await composeCycleLoopRefs(
              tx,
              existing.sourceTaskId,
              existing.targetTaskId,
              chain,
            ),
            "Circular dependency: changing this edge type would create a cycle.",
          );
        }
      }

      const [row] = await tx
        .update(taskEdges)
        .set(setClause)
        .where(eq(taskEdges.id, edgeId))
        .returning();

      await insertActivityEvents(tx, ctx.actor, [
        {
          projectId,
          taskId: existing.sourceTaskId,
          type: "edge_updated",
          summary: `updated the ${row.edgeType} edge → target`,
          targetRef: existing.targetTaskId,
          metadata: { direction: "outgoing", relation: row.edgeType },
        },
        {
          projectId,
          taskId: existing.targetTaskId,
          type: "edge_updated",
          summary: `updated the ${row.edgeType} edge ← source`,
          targetRef: existing.sourceTaskId,
          metadata: { direction: "incoming", relation: row.edgeType },
        },
      ]);

      return { updated: row, existing, projectId, typeChanged };
    },
  );

  emitEdgeMutation(
    projectId,
    existing.sourceTaskId,
    existing.targetTaskId,
    typeChanged,
  );
  return {
    id: updated.id,
    sourceTaskId: updated.sourceTaskId,
    targetTaskId: updated.targetTaskId,
    edgeType: updated.edgeType,
    note: updated.note,
  };
}

/**
 * Remove an edge by ID and emit `activity_events` for both tasks.
 * @param ctx - Resolved auth context.
 * @param edgeId - UUID of the edge to delete.
 * @throws ProjectArchivedError when the parent project is archived (read-only).
 */
export async function removeEdge(ctx: AuthContext, edgeId: string) {
  const { edge, projectId } = await withUserContext(ctx.userId, async (tx) => {
    const { edge, projectId } = await loadAuthorizedEdgeTx(tx, edgeId);

    await tx.delete(taskEdges).where(eq(taskEdges.id, edgeId));

    await insertActivityEvents(tx, ctx.actor, [
      {
        projectId,
        taskId: edge.sourceTaskId,
        type: "edge_removed",
        summary: `removed the ${edge.edgeType} edge → target`,
        targetRef: edge.targetTaskId,
        metadata: { direction: "outgoing", relation: edge.edgeType },
      },
      {
        projectId,
        taskId: edge.targetTaskId,
        type: "edge_removed",
        summary: `removed the ${edge.edgeType} edge ← source`,
        targetRef: edge.sourceTaskId,
        metadata: { direction: "incoming", relation: edge.edgeType },
      },
    ]);

    return { edge, projectId };
  });

  emitEdgeMutation(projectId, edge.sourceTaskId, edge.targetTaskId, true);
}
