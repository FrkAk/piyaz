import "server-only";

import type { EdgeType, AcceptanceCriterion, Decision } from "@/lib/types";
import { getTaskEdgesDetailed } from "@/lib/data/edge";
import { getProjectHeader } from "@/lib/data/project";
import { asIdentifier, composeTaskRef } from "@/lib/graph/identifier";
import type { AuthContext } from "@/lib/auth/context";
import { assertTaskAccess } from "@/lib/auth/authorization";

/** Detailed edge information for summary context. */
type EdgeDetail = {
  edgeType: EdgeType;
  direction: "outgoing" | "incoming";
  connectedTaskId: string;
  connectedTaskRef: string;
  connectedTaskTitle: string;
  connectedTaskStatus: string;
  note: string;
};

/** Summary context for a task (0-hop). */
export type SummaryContext = {
  node: {
    taskRef: string;
    title: string;
    status: string;
    description: string;
  };
  parent: { title: string; type: "project" } | null;
  edgeCount: Record<EdgeType, number>;
  edges: EdgeDetail[];
  acceptanceCriteriaCount: number;
  decisionsCount: number;
  hasImplementationPlan: boolean;
};

/**
 * Build a lightweight summary context for a task. Zero-hop traversal.
 * @param ctx - Resolved auth context.
 * @param taskId - UUID of the task.
 * @returns Summary context with task info, parent project, and edge details/counts.
 */
export async function buildSummaryContext(
  ctx: AuthContext,
  taskId: string,
): Promise<SummaryContext> {
  const task = await assertTaskAccess(taskId, ctx);

  const project = await getProjectHeader(task.projectId);
  if (!project) {
    console.error("Task has no joinable project", {
      taskId: task.id,
      projectId: task.projectId,
    });
  }

  const detailedEdges = await getTaskEdgesDetailed(ctx, taskId);

  const edges: EdgeDetail[] = detailedEdges.map((e) => ({
    edgeType: e.edgeType,
    direction: e.direction,
    connectedTaskId: e.connectedTask.id,
    connectedTaskRef: e.connectedTask.taskRef,
    connectedTaskTitle: e.connectedTask.title,
    connectedTaskStatus: e.connectedTask.status,
    note: e.note,
  }));

  const edgeCount = buildEdgeCount(edges);

  return {
    node: {
      taskRef: project
        ? composeTaskRef(asIdentifier(project.identifier), task.sequenceNumber)
        : "",
      title: task.title,
      status: task.status,
      description: task.description,
    },
    parent: project ? { title: project.title, type: "project" } : null,
    edgeCount,
    edges,
    acceptanceCriteriaCount: (task.acceptanceCriteria as AcceptanceCriterion[])
      .length,
    decisionsCount: (task.decisions as Decision[]).length,
    hasImplementationPlan: !!task.implementationPlan,
  };
}

/**
 * Build edge counts grouped by edge type.
 * @param edges - Array of edge details.
 * @returns Record of edge type to count.
 */
function buildEdgeCount(edges: EdgeDetail[]): Record<EdgeType, number> {
  const counts: Record<EdgeType, number> = {
    depends_on: 0,
    relates_to: 0,
  };
  for (const e of edges) {
    counts[e.edgeType]++;
  }
  return counts;
}
