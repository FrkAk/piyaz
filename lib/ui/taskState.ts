import type { TaskEdge } from "@/lib/db/schema";

/**
 * Minimum shape needed to evaluate {@link isPlannable}. Mirrors the slim
 * graph payload so callers can pass either a full {@link Task} (after
 * deriving the two flags) or a `TaskGraphSlim` row directly.
 */
export type PlannableInput = {
  id: string;
  status: string;
  hasDescription: boolean;
  hasCriteria: boolean;
};

/** Minimum shape needed to evaluate {@link isReady}. */
export type ReadyInput = {
  id: string;
  status: string;
};

/**
 * Walk forward from a task through depends_on edges, treating cancelled tasks
 * as transparent. Mirrors server-side `walkEffectiveDeps` so client-side badges
 * stay consistent with `mymir_analyze` and `deriveTaskState`.
 *
 * @param taskId - Starting task id.
 * @param statusMap - Map of task ID to status.
 * @param edges - All edges in the project.
 * @returns Array of active task IDs reachable through any number of cancelled middles.
 */
function walkEffectiveDeps(
  taskId: string,
  statusMap: Map<string, string>,
  edges: TaskEdge[],
): string[] {
  const result = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [taskId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const targets = edges
      .filter((e) => e.sourceTaskId === cur && e.edgeType === "depends_on")
      .map((e) => e.targetTaskId);
    for (const target of targets) {
      if (visited.has(target)) continue;
      const status = statusMap.get(target);
      if (status === "cancelled") {
        stack.push(target);
      } else if (status !== undefined) {
        result.add(target);
      }
    }
  }
  return [...result];
}

/**
 * Check if a draft task has enough content to be planned and is not blocked.
 * Mirrors server-side deriveTaskState logic (queries.ts) using effective deps —
 * cancelled tasks are transparent (passable but not satisfying).
 * @param task - Task with `hasDescription` / `hasCriteria` flags resolved.
 * @param statusMap - Pre-built map of task ID to status.
 * @param edges - All edges in the project.
 * @returns True if the task is draft, all effective deps are done, with description and criteria.
 */
export function isPlannable(
  task: PlannableInput,
  statusMap: Map<string, string>,
  edges: TaskEdge[],
): boolean {
  if (task.status !== "draft") return false;
  const effectiveDeps = walkEffectiveDeps(task.id, statusMap, edges);
  if (!effectiveDeps.every((id) => statusMap.get(id) === "done")) return false;
  if (!task.hasDescription) return false;
  return task.hasCriteria;
}

/**
 * Check if a planned task has all dependencies satisfied via the effective
 * dependency graph. Cancelled tasks are transparent.
 * @param task - Task with `id` and `status`.
 * @param statusMap - Pre-built map of task ID to status.
 * @param edges - All edges in the project.
 * @returns True if the task is planned and every effective dep is done.
 */
export function isReady(
  task: ReadyInput,
  statusMap: Map<string, string>,
  edges: TaskEdge[],
): boolean {
  if (task.status !== "planned") return false;
  const effectiveDeps = walkEffectiveDeps(task.id, statusMap, edges);
  return effectiveDeps.every((id) => statusMap.get(id) === "done");
}

/**
 * Build a status map from a task array. Build once, pass to isReady for each task.
 * @param tasks - All tasks in the project.
 * @returns Map of task ID to status string.
 */
export function buildStatusMap(tasks: ReadonlyArray<{ id: string; status: string }>): Map<string, string> {
  return new Map(tasks.map((t) => [t.id, t.status]));
}
