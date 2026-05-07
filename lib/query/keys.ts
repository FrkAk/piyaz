/**
 * Centralised TanStack Query key factories. Compound prefixes enable
 * `invalidateQueries({ queryKey: ['task', projectId] })` to drop every
 * task-scoped entry for a project as a graceful fallback.
 */

/** Project-scoped query keys (list, slim graph). */
export const projectKeys = {
  /** All project-related queries. */
  all: () => ["projects"] as const,
  /** Project list shown on the home grid. */
  list: () => ["projects", "list"] as const,
  /** Slim graph for a workspace project. */
  graph: (projectId: string) => ["projects", projectId, "graph"] as const,
} as const;

/** Task-scoped query keys (body, context bundle). */
export const taskKeys = {
  /** All task queries for a project. */
  all: (projectId: string) => ["task", projectId] as const,
  /** Full task body for the detail panel. */
  detail: (projectId: string, taskId: string) =>
    ["task", projectId, taskId] as const,
  /** Three-bundle markdown for the MD toggle. */
  context: (projectId: string, taskId: string) =>
    ["task", projectId, taskId, "context"] as const,
} as const;
