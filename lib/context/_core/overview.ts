import "server-only";

import type { EdgeType, Priority, Estimate } from "@/lib/types";
import {
  asIdentifier,
  composeTaskRef,
  enrichWithTaskRef,
} from "@/lib/graph/identifier";
import { getProjectTags } from "@/lib/data/project";
import {
  listProjectTasks,
  fetchAssigneesByTaskUnchecked,
} from "@/lib/data/task";
import { fetchEdgesForTaskIds } from "@/lib/data/edge";
import { compress } from "@/lib/context/format";
import type { AuthContext } from "@/lib/auth/context";
import { assertProjectAccess } from "@/lib/auth/authorization";

/** Task summary within a project overview. */
type TaskSummary = {
  id: string;
  taskRef: string;
  title: string;
  status: string;
  description: string;
  order: number;
  tags: string[];
  category: string | null;
  priority: Priority | null;
  estimate: Estimate | null;
  assigneeCount: number;
};

/** Edge summary for project overview. */
type OverviewEdge = {
  sourceTaskRef: string;
  sourceTitle: string;
  targetTaskRef: string;
  targetTitle: string;
  edgeType: EdgeType;
  note: string;
};

/** Full project overview with progress stats. */
export type ProjectOverview = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  status: string;
  categories: string[];
  tagVocabulary: string[];
  tasks: TaskSummary[];
  edges: OverviewEdge[];
  totalTasks: number;
  doneTasks: number;
  inProgressTasks: number;
  cancelledTasks: number;
  progress: number;
};

/**
 * Build a full project overview with flat task list, edges, and progress.
 * @param ctx - Resolved auth context.
 * @param projectId - UUID of the project.
 * @returns ProjectOverview or undefined if project not found.
 */
export async function buildProjectOverview(
  ctx: AuthContext,
  projectId: string,
): Promise<ProjectOverview> {
  const { project } = await assertProjectAccess(projectId, ctx);

  const allTasks = await listProjectTasks(projectId);

  const projectTags = await getProjectTags(ctx, projectId);

  const identifier = asIdentifier(project.identifier);
  const assigneesByTask = await fetchAssigneesByTaskUnchecked(
    allTasks.map((t) => t.id),
  );
  const taskSummaries: TaskSummary[] = enrichWithTaskRef(
    allTasks,
    identifier,
  ).map((t) => ({
    id: t.id,
    taskRef: t.taskRef,
    title: t.title,
    status: t.status,
    description: compress(t.description, 100),
    order: t.order,
    tags: t.tags,
    category: t.category,
    priority: t.priority,
    estimate: t.estimate,
    assigneeCount: assigneesByTask.get(t.id)?.length ?? 0,
  }));

  const totalTasks = allTasks.length;
  const doneTasks = allTasks.filter((t) => t.status === "done").length;
  const inProgressTasks = allTasks.filter(
    (t) => t.status === "in_progress",
  ).length;
  const cancelledTasks = allTasks.filter((t) => t.status === "cancelled").length;

  const taskIds = allTasks.map((t) => t.id);
  let edges: OverviewEdge[] = [];

  if (taskIds.length > 0) {
    const infoMap = new Map<string, { taskRef: string; title: string }>();
    for (const t of allTasks) {
      infoMap.set(t.id, {
        taskRef: composeTaskRef(identifier, t.sequenceNumber),
        title: t.title,
      });
    }

    const rawEdges = await fetchEdgesForTaskIds(taskIds);

    edges = rawEdges.map((e) => {
      const source = infoMap.get(e.sourceTaskId);
      const target = infoMap.get(e.targetTaskId);
      return {
        sourceTaskRef: source?.taskRef ?? "",
        sourceTitle: source?.title ?? "Unknown",
        targetTaskRef: target?.taskRef ?? "",
        targetTitle: target?.title ?? "Unknown",
        edgeType: e.edgeType,
        note: e.note,
      };
    });
  }

  const denominator = totalTasks - cancelledTasks;
  return {
    id: project.id,
    identifier: project.identifier,
    title: project.title,
    description: project.description,
    status: project.status,
    categories: project.categories,
    tagVocabulary: projectTags.map((t) => t.tag),
    tasks: taskSummaries,
    edges,
    totalTasks,
    doneTasks,
    inProgressTasks,
    cancelledTasks,
    progress: denominator > 0 ? Math.round((doneTasks / denominator) * 100) : 0,
  };
}
