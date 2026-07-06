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
  /** One bundle kind's structured sections for the MD toggle / drawers. */
  context: (projectId: string, taskId: string, kind: string) =>
    ["task", projectId, taskId, "context", kind] as const,
  /** Prefix matching every bundle kind — used for invalidation. */
  contextAll: (projectId: string, taskId: string) =>
    ["task", projectId, taskId, "context"] as const,
  /** Paginated activity log for the detail panel. */
  activity: (projectId: string, taskId: string) =>
    ["task", projectId, taskId, "activity"] as const,
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

/** Note-scoped query keys (tree list, detail, search, task backlinks). */
export const noteKeys = {
  /** All note queries for a project — the invalidation prefix. */
  all: (projectId: string) => ["notes", projectId] as const,
  /** Slim tree list for the notes pane. */
  list: (projectId: string) => ["notes", projectId, "list"] as const,
  /** Full note (body + link context) for the editor. */
  detail: (projectId: string, noteId: string) =>
    ["notes", projectId, "detail", noteId] as const,
  /** Ranked full-text search hits for a query string. */
  search: (projectId: string, q: string) =>
    ["notes", projectId, "search", q] as const,
  /** Notes linked to a task (backlinks panel). */
  backlinks: (projectId: string, taskId: string) =>
    ["notes", projectId, "backlinks", taskId] as const,
  /** All backlink queries for a project — the invalidation prefix. */
  backlinksAll: (projectId: string) =>
    ["notes", projectId, "backlinks"] as const,
} as const;
