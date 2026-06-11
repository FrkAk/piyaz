import "server-only";

import { and, eq, or, sql } from "drizzle-orm";
import { uuidArray, type Conn, type ReadConn } from "@/lib/db/raw";
import { withUserContext, withUserContextRead, type Tx } from "@/lib/db/rls";
import { projects, tasks, taskEdges, type NewTaskEdge } from "@/lib/db/schema";
import type { EdgeType, HistoryEntry } from "@/lib/types";
import { asIdentifier, composeTaskRef } from "@/lib/graph/identifier";
import { fetchDependencyChain } from "@/lib/db/raw/fetch-dependency-chain";
import { appendTaskHistoryMany } from "@/lib/data/task";
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
 * Create an edge between two tasks and append history to both.
 * Validates against self-edges, duplicates, and circular depends_on.
 * @param ctx - Resolved auth context.
 * @param data - Edge fields to insert.
 * @returns The created edge.
 * @throws Error if validation fails.
 */
export async function createEdge(
  ctx: AuthContext,
  data: Omit<NewTaskEdge, "id">,
) {
  if (data.sourceTaskId === data.targetTaskId) {
    throw new Error(
      "Cannot create self-edge: source and target are the same task.",
    );
  }

  if (typeof data.note === "string" && data.note.trim()) {
    data = { ...data, note: (await formatMarkdown(data.note)) ?? data.note };
  }

  const { edge, projectId } = await withUserContext(ctx.userId, async (tx) => {
    const [sourceTask, targetTask] = await Promise.all([
      assertTaskAccessTx(tx, data.sourceTaskId),
      assertTaskAccessTx(tx, data.targetTaskId),
    ]);

    if (sourceTask.projectId !== targetTask.projectId) {
      throw new Error(
        "Cannot create edge between tasks in different projects.",
      );
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
      throw new Error("Duplicate edge: an identical edge already exists.");
    }

    if (data.edgeType === "depends_on") {
      const chain = await fetchDependencyChain(
        tx,
        data.targetTaskId,
        targetTask.projectId,
        10,
      );
      if (chain.some((node) => node.id === data.sourceTaskId)) {
        throw new Error(
          "Circular dependency: adding this edge would create a cycle.",
        );
      }
    }

    const [created] = await tx.insert(taskEdges).values(data).returning();

    const historyEntry = makeHistoryEntry({
      type: "edge_added",
      label: `Edge: ${data.edgeType}`,
      description: `${data.edgeType} edge created.`,
      actor: "ai",
    });

    await appendTaskHistoryMany(
      [data.sourceTaskId, data.targetTaskId],
      historyEntry,
      { tx },
    );

    return { edge: created, projectId: sourceTask.projectId };
  });

  emitEdgeMutation(projectId, data.sourceTaskId, data.targetTaskId);
  return {
    id: edge.id,
    sourceTaskId: edge.sourceTaskId,
    targetTaskId: edge.targetTaskId,
    edgeType: edge.edgeType,
    note: edge.note,
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
 * @throws Error if edge not found or validation fails.
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

  const { updated, existing, projectId } = await withUserContext(
    ctx.userId,
    async (tx) => {
      const { edge: existing, projectId } = await loadAuthorizedEdgeTx(
        tx,
        edgeId,
      );

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
          throw new Error(
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
          throw new Error(
            "Circular dependency: changing this edge type would create a cycle.",
          );
        }
      }

      const [row] = await tx
        .update(taskEdges)
        .set(setClause)
        .where(eq(taskEdges.id, edgeId))
        .returning();

      const historyEntry = makeHistoryEntry({
        type: "edge_updated",
        label: `Edge updated: ${row.edgeType}`,
        description: `Edge updated${updates.edgeType ? ` to ${updates.edgeType}` : ""}${
          updates.note !== undefined ? " with new note" : ""
        }.`,
        actor: "ai",
      });

      await appendTaskHistoryMany(
        [existing.sourceTaskId, existing.targetTaskId],
        historyEntry,
        { tx },
      );

      return { updated: row, existing, projectId };
    },
  );

  emitEdgeMutation(projectId, existing.sourceTaskId, existing.targetTaskId);
  return {
    id: updated.id,
    sourceTaskId: updated.sourceTaskId,
    targetTaskId: updated.targetTaskId,
    edgeType: updated.edgeType,
    note: updated.note,
  };
}

/**
 * Remove an edge by ID and append history to both tasks.
 * @param ctx - Resolved auth context.
 * @param edgeId - UUID of the edge to delete.
 */
export async function removeEdge(ctx: AuthContext, edgeId: string) {
  const { edge, projectId } = await withUserContext(ctx.userId, async (tx) => {
    const { edge, projectId } = await loadAuthorizedEdgeTx(tx, edgeId);

    await tx.delete(taskEdges).where(eq(taskEdges.id, edgeId));

    const historyEntry = makeHistoryEntry({
      type: "edge_removed",
      label: `Edge removed: ${edge.edgeType}`,
      description: `${edge.edgeType} edge removed.`,
      actor: "user",
    });

    await appendTaskHistoryMany(
      [edge.sourceTaskId, edge.targetTaskId],
      historyEntry,
      { tx },
    );

    return { edge, projectId };
  });

  emitEdgeMutation(projectId, edge.sourceTaskId, edge.targetTaskId);
}
