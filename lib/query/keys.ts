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

/** Team-scoped query keys (member roster). */
export const teamKeys = {
  /** All team-scoped queries. */
  all: () => ["team"] as const,
  /** Member roster for an organization — drives the AssigneePicker and TaskRow avatar names. */
  members: (organizationId: string) =>
    ["team", organizationId, "members"] as const,
} as const;

export const myTasksKeys = {
  all: () => ["my-tasks"] as const,
  list: () => ["my-tasks", "list"] as const,
} as const;
