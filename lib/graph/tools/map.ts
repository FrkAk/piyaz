/**
 * `piyaz_map` handler: graph navigation. Project-scoped work queues
 * (ready/blocked/plannable/critical_path) and task-scoped walks
 * (downstream/neighbors).
 */

import {
  getReadyTasks,
  getBlockedTasks,
  getDownstream,
  getCriticalPath,
  getPlannableTasks,
  getNeighbors,
} from "@/lib/data/traversal";
import {
  formatReadyTasks,
  formatBlockedTasks,
  formatDownstream,
  formatCriticalPath,
  formatPlannableTasks,
  formatNeighbors,
} from "@/lib/graph/format-responses";
import type { AuthContext } from "@/lib/auth/context";
import {
  ok,
  fail,
  requireProjectId,
  requireTaskId,
  translateError,
  type ToolResult,
} from "@/lib/graph/tools/shared";

/** Params for piyaz_map. */
export type MapParams = {
  view:
    | "ready"
    | "blocked"
    | "plannable"
    | "critical_path"
    | "downstream"
    | "neighbors";
  project?: string;
  task?: string;
  hops?: 1 | 2;
  limit?: number;
};

/**
 * Handle piyaz_map views.
 * @param p - Validated map params.
 * @param ctx - Resolved auth context.
 * @returns Tool result with the formatted view.
 */
export async function handleMap(
  p: MapParams,
  ctx: AuthContext,
): Promise<ToolResult> {
  try {
    if (p.view === "downstream" || p.view === "neighbors") {
      if (!p.task)
        return fail(
          `task required for ${p.view}: taskRef ('PYZ-42') or UUID. Find it with piyaz_search.`,
        );
      const taskId = await requireTaskId(ctx, p.task);
      if (p.view === "downstream") {
        return ok(formatDownstream(await getDownstream(ctx, taskId)));
      }
      const neighbors = await getNeighbors(ctx, taskId, p.hops ?? 1);
      return ok(formatNeighbors(neighbors, p.task));
    }

    if (!p.project)
      return fail(
        `project required for ${p.view}: identifier ('PYZ') or UUID. Run piyaz_workspace action='projects' first.`,
      );
    const projectId = await requireProjectId(ctx, p.project);
    switch (p.view) {
      case "ready":
        return ok(formatReadyTasks(await getReadyTasks(ctx, projectId)));
      case "blocked":
        return ok(formatBlockedTasks(await getBlockedTasks(ctx, projectId)));
      case "plannable":
        return ok(
          formatPlannableTasks(await getPlannableTasks(ctx, projectId)),
        );
      case "critical_path":
        return ok(formatCriticalPath(await getCriticalPath(ctx, projectId)));
    }
  } catch (e) {
    return translateError(e);
  }
}
