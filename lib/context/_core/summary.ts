import "server-only";

import type { EdgeType, Priority, Estimate } from "@/lib/types";
import type { TaskLinkRef } from "@/lib/data/views";
import type { AuthContext } from "@/lib/auth/context";
import { resolveSummaryData } from "@/lib/context/_core/bundle";

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
    priority: Priority | null;
    estimate: Estimate | null;
    prUrl: string | null;
  };
  parent: { title: string; type: "project" } | null;
  edgeCount: Record<EdgeType, number>;
  edges: EdgeDetail[];
  acceptanceCriteriaCount: number;
  decisionsCount: number;
  assigneeCount: number;
  hasImplementationPlan: boolean;
  links: TaskLinkRef[];
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
  const { task, detailedEdges, project } = await resolveSummaryData(
    ctx.userId,
    taskId,
  );
  if (!project) {
    console.error("Task has no joinable project", {
      taskId: task.id,
      projectId: task.projectId,
    });
  }

  const links = task.links;

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

  const prUrl = links.find((l) => l.kind === "pull_request")?.url ?? null;

  return {
    node: {
      taskRef: task.taskRef,
      title: task.title,
      status: task.status,
      description: task.description,
      priority: task.priority,
      estimate: task.estimate,
      prUrl,
    },
    parent: project ? { title: project.title, type: "project" } : null,
    edgeCount,
    edges,
    acceptanceCriteriaCount: task.acceptanceCriteria.length,
    decisionsCount: task.decisions.length,
    assigneeCount: task.assignees.length,
    hasImplementationPlan: !!task.implementationPlan,
    links,
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
