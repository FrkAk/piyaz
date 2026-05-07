import "server-only";

import { and, eq, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  projects,
  tasks,
  taskEdges,
  type NewTaskEdge,
} from "@/lib/db/schema";
import type { EdgeType, HistoryEntry } from "@/lib/types";
import { asIdentifier, composeTaskRef } from "@/lib/graph/identifier";
import { getDependencyChain } from "@/lib/data/traversal";
import { appendTaskHistory } from "@/lib/data/task";
import { formatMarkdown } from "@/lib/markdown/format";
import type { AuthContext } from "@/lib/auth/context";
import {
  ForbiddenError,
  assertTaskAccess,
  isUuid,
} from "@/lib/auth/authorization";
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
  await assertTaskAccess(sourceTaskId, ctx);
  await assertTaskAccess(targetTaskId, ctx);
  const [row] = await db
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
}

/**
 * Fetch all edges where a task is source or target.
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns Array of edges.
 */
export async function getTaskEdges(ctx: AuthContext, taskId: string) {
  await assertTaskAccess(taskId, ctx);
  return db
    .select()
    .from(taskEdges)
    .where(
      or(
        eq(taskEdges.sourceTaskId, taskId),
        eq(taskEdges.targetTaskId, taskId),
      ),
    );
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
 * Fetch all edges on a task with connected task titles and statuses.
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns Array of detailed edges.
 */
export async function getTaskEdgesDetailed(
  ctx: AuthContext,
  taskId: string,
): Promise<DetailedEdge[]> {
  await assertTaskAccess(taskId, ctx);

  const edges = await db
    .select()
    .from(taskEdges)
    .where(
      or(
        eq(taskEdges.sourceTaskId, taskId),
        eq(taskEdges.targetTaskId, taskId),
      ),
    );

  const idsToFetch = new Set<string>();
  for (const edge of edges) {
    const isOutgoing = edge.sourceTaskId === taskId;
    idsToFetch.add(isOutgoing ? edge.targetTaskId : edge.sourceTaskId);
  }

  const taskInfoMap = new Map<
    string,
    { taskRef: string; title: string; status: string }
  >();

  if (idsToFetch.size > 0) {
    const ids = [...idsToFetch];
    const taskRows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        sequenceNumber: tasks.sequenceNumber,
        identifier: projects.identifier,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(sql`${tasks.id} IN ${ids}`);
    for (const t of taskRows) {
      taskInfoMap.set(t.id, {
        taskRef: composeTaskRef(asIdentifier(t.identifier), t.sequenceNumber),
        title: t.title,
        status: t.status,
      });
    }
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
 * Fetch every edge whose source OR target task is in the supplied id set.
 * Internal helper for the project-overview context assembler — caller
 * asserted access on the project, and the id set is the project's task
 * ids so the OR-on-id-list is safely scoped.
 *
 * @param taskIds - Task ids to filter the endpoints on.
 * @returns Full edge rows.
 */
export async function fetchEdgesForTaskIds(taskIds: string[]) {
  if (taskIds.length === 0) return [];
  return db
    .select()
    .from(taskEdges)
    .where(
      or(
        sql`${taskEdges.sourceTaskId} IN ${taskIds}`,
        sql`${taskEdges.targetTaskId} IN ${taskIds}`,
      ),
    );
}

/**
 * Fetch every `depends_on` edge whose source task is in the supplied
 * id set. Used by graph algorithms.
 *
 * @param sourceTaskIds - Task ids to filter the source side on.
 * @returns Edge endpoints (source/target only — no metadata).
 */
export async function listDependsOnEdges(sourceTaskIds: string[]) {
  if (sourceTaskIds.length === 0) return [];
  return db
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

  const [sourceTask, targetTask] = await Promise.all([
    assertTaskAccess(data.sourceTaskId, ctx),
    assertTaskAccess(data.targetTaskId, ctx),
  ]);

  if (sourceTask.projectId !== targetTask.projectId) {
    throw new Error("Cannot create edge between tasks in different projects.");
  }

  if (typeof data.note === "string" && data.note.trim()) {
    data = { ...data, note: (await formatMarkdown(data.note)) ?? data.note };
  }

  const [existing] = await db
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
    const chain = await getDependencyChain(
      data.targetTaskId,
      targetTask.projectId,
    );
    const wouldCycle = chain.some((node) => node.id === data.sourceTaskId);
    if (wouldCycle) {
      throw new Error(
        "Circular dependency: adding this edge would create a cycle.",
      );
    }
  }

  const [edge] = await db.insert(taskEdges).values(data).returning();

  const historyEntry = makeHistoryEntry({
    type: "edge_added",
    label: `Edge: ${data.edgeType}`,
    description: `${data.edgeType} edge created.`,
    actor: "ai",
  });

  await Promise.all([
    appendTaskHistory(data.sourceTaskId, historyEntry),
    appendTaskHistory(data.targetTaskId, historyEntry),
  ]);

  notifyChange();
  return {
    id: edge.id,
    sourceTaskId: edge.sourceTaskId,
    targetTaskId: edge.targetTaskId,
    edgeType: edge.edgeType,
    note: edge.note,
  };
}

/**
 * Internal helper: fetch an edge by id then assert the caller can reach it
 * via the parent project. Both the missing-edge case and a cross-team task
 * surface as a `ForbiddenError` tagged with `resource: "edge"` so the tool
 * layer can render an edge-specific recovery hint without re-querying.
 * @param edgeId - UUID of the edge.
 * @param ctx - Resolved auth context.
 * @returns The edge row.
 */
async function loadAuthorizedEdge(edgeId: string, ctx: AuthContext) {
  if (!isUuid(edgeId)) {
    throw new ForbiddenError("Forbidden", "edge", edgeId);
  }
  const [edge] = await db
    .select()
    .from(taskEdges)
    .where(eq(taskEdges.id, edgeId));
  if (!edge) throw new ForbiddenError("Forbidden", "edge", edgeId);
  try {
    await assertTaskAccess(edge.sourceTaskId, ctx);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      throw new ForbiddenError("Forbidden", "edge", edgeId);
    }
    throw err;
  }
  return edge;
}

/**
 * Update an existing edge's edgeType and/or note.
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
  const existing = await loadAuthorizedEdge(edgeId, ctx);

  if (typeof updates.note === "string" && updates.note.trim()) {
    updates = {
      ...updates,
      note: (await formatMarkdown(updates.note)) ?? updates.note,
    };
  }

  if (updates.edgeType && updates.edgeType !== existing.edgeType) {
    const [dup] = await db
      .select({ id: taskEdges.id })
      .from(taskEdges)
      .where(
        and(
          eq(taskEdges.sourceTaskId, existing.sourceTaskId),
          eq(taskEdges.targetTaskId, existing.targetTaskId),
          eq(taskEdges.edgeType, updates.edgeType),
        ),
      );
    if (dup)
      throw new Error(
        "Duplicate edge: an edge with this type already exists between these tasks.",
      );

    if (updates.edgeType === "depends_on") {
      const targetTask = await assertTaskAccess(existing.targetTaskId, ctx);
      const chain = await getDependencyChain(
        existing.targetTaskId,
        targetTask.projectId,
      );
      if (chain.some((node) => node.id === existing.sourceTaskId)) {
        throw new Error(
          "Circular dependency: changing this edge type would create a cycle.",
        );
      }
    }
  }

  const setClause: Record<string, unknown> = { updatedAt: new Date() };
  if (updates.edgeType !== undefined) setClause.edgeType = updates.edgeType;
  if (updates.note !== undefined) setClause.note = updates.note;

  const [updated] = await db
    .update(taskEdges)
    .set(setClause)
    .where(eq(taskEdges.id, edgeId))
    .returning();

  const historyEntry = makeHistoryEntry({
    type: "edge_updated",
    label: `Edge updated: ${updated.edgeType}`,
    description: `Edge updated${updates.edgeType ? ` to ${updates.edgeType}` : ""}${
      updates.note !== undefined ? " with new note" : ""
    }.`,
    actor: "ai",
  });

  await Promise.all([
    appendTaskHistory(existing.sourceTaskId, historyEntry),
    appendTaskHistory(existing.targetTaskId, historyEntry),
  ]);

  notifyChange();
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
  const edge = await loadAuthorizedEdge(edgeId, ctx);

  await db.delete(taskEdges).where(eq(taskEdges.id, edgeId));

  const historyEntry = makeHistoryEntry({
    type: "edge_removed",
    label: `Edge removed: ${edge.edgeType}`,
    description: `${edge.edgeType} edge removed.`,
    actor: "user",
  });

  await Promise.all([
    appendTaskHistory(edge.sourceTaskId, historyEntry),
    appendTaskHistory(edge.targetTaskId, historyEntry),
  ]);
  notifyChange();
}
