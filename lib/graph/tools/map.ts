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

/** Default row cap for map views. */
const MAP_DEFAULT_LIMIT = 50;

/**
 * Cap a view's rows at the caller's limit and render the remainder as a
 * guidance line, so no map view can dump an unbounded task or edge list.
 *
 * @param rows - Full row list from the traversal.
 * @param limit - Caller-supplied cap (defaults to {@link MAP_DEFAULT_LIMIT}).
 * @param format - Formatter for the kept rows.
 * @param guidance - How to fetch the remainder.
 * @returns The formatted view, with a truncation line when rows were dropped.
 */
function budgeted<T>(
  rows: T[],
  limit: number | undefined,
  format: (kept: T[]) => string,
  guidance: string,
): string {
  const cap = limit ?? MAP_DEFAULT_LIMIT;
  if (rows.length <= cap) return format(rows);
  return `${format(rows.slice(0, cap))}\n… +${rows.length - cap} more — ${guidance}`;
}

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
        return ok(
          budgeted(
            await getDownstream(ctx, taskId),
            p.limit,
            formatDownstream,
            "raise limit, or inspect a specific dependent with piyaz_get",
          ),
        );
      }
      const neighbors = await getNeighbors(ctx, taskId, p.hops ?? 1);
      const origin = p.task;
      return ok(
        budgeted(
          neighbors,
          p.limit,
          (kept) => formatNeighbors(kept, origin),
          "raise limit, or walk hops=1 first",
        ),
      );
    }

    if (!p.project)
      return fail(
        `project required for ${p.view}: identifier ('PYZ') or UUID. Run piyaz_workspace action='projects' first.`,
      );
    const projectId = await requireProjectId(ctx, p.project);
    const narrow = `narrow with piyaz_search project='${p.project}' status=[...] or raise limit`;
    switch (p.view) {
      case "ready":
        return ok(
          budgeted(
            await getReadyTasks(ctx, projectId),
            p.limit,
            formatReadyTasks,
            narrow,
          ),
        );
      case "blocked":
        return ok(
          budgeted(
            await getBlockedTasks(ctx, projectId),
            p.limit,
            formatBlockedTasks,
            narrow,
          ),
        );
      case "plannable":
        return ok(
          budgeted(
            await getPlannableTasks(ctx, projectId),
            p.limit,
            formatPlannableTasks,
            narrow,
          ),
        );
      case "critical_path":
        return ok(
          budgeted(
            await getCriticalPath(ctx, projectId),
            p.limit,
            formatCriticalPath,
            narrow,
          ),
        );
    }
  } catch (e) {
    return translateError(e);
  }
}
