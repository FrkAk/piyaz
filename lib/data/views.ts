import type { Project, Task, TaskEdge } from "@/lib/db/schema";

/**
 * Slim view of the project's owning team — only the fields the home grid
 * and team chip render. Decorating each project with its own organization
 * here saves the home page from a separate `organization` query.
 */
export type ProjectListOrganization = {
  id: string;
  name: string;
  slug: string;
};

/** Per-project task progress counts shown on the home grid. */
export type ProjectTaskStats = {
  total: number;
  done: number;
  inProgress: number;
  cancelled: number;
};

/** Project entry returned by `listProjectsSlim`. */
export type ProjectListEntry = Project & {
  organization: ProjectListOrganization;
  memberRole: string;
  taskStats: ProjectTaskStats;
  progress: number;
};

/**
 * Slim project entry returned by `listProjectsForMcp` — the agent-facing
 * shape for `mymir_project action='list'`. Strips description, history,
 * categories, and timestamps to keep the payload tight; agents fetch the
 * description and tag vocabulary on demand via `mymir_query type='meta'`.
 */
export type ProjectListEntryMcp = Pick<
  Project,
  "id" | "organizationId" | "title" | "identifier" | "status"
> & {
  organization: ProjectListOrganization;
  memberRole: string;
  taskStats: ProjectTaskStats;
  progress: number;
};

/** Slim task entry returned by the project graph payload. */
export type TaskGraphSlim = Pick<
  Task,
  "id" | "title" | "status" | "category" | "tags" | "order" | "updatedAt"
> & {
  taskRef: string;
  /** True when `description` is non-empty after trimming whitespace. */
  hasDescription: boolean;
  /** True when `acceptanceCriteria` has at least one entry. */
  hasCriteria: boolean;
};

/** Slim project graph for the workspace canvas + list. Edges are returned
 * in full (they have no heavy fields), tasks are slim. */
export type ProjectGraphSlim = {
  project: Pick<
    Project,
    "id" | "identifier" | "title" | "status" | "updatedAt" | "categories"
  >;
  tasks: TaskGraphSlim[];
  edges: TaskEdge[];
};

/**
 * Chrome-only project view for the workspace layout (TopBar / settings).
 * Includes the fields the layout renders plus a `taskCount` so it can
 * surface progress without pulling the slim graph.
 */
export type ProjectChrome = Pick<
  Project,
  "id" | "title" | "description" | "identifier" | "status" | "categories"
> & {
  organization: ProjectListOrganization;
  memberRole: string;
  taskCount: number;
};

/**
 * Slim project metadata view for agent orientation. Header fields plus tag
 * vocabulary, status-grouped task counts, and progress percent. Designed as
 * the lightweight alternative to the full project overview when the agent
 * only needs categories, tag vocab, or progress.
 */
export type ProjectMeta = Pick<
  Project,
  "id" | "identifier" | "title" | "description" | "status" | "categories"
> & {
  tagVocabulary: { tag: string; count: number }[];
  taskStats: ProjectTaskStats;
  progress: number;
};

/** Slim view of a project for list/search surfaces. */
export type ProjectSlim = {
  id: string;
  identifier: string;
  title: string;
  status: string;
  organizationId: string;
  updatedAt: Date;
};

/** Slim view of a task for listing surfaces (search results, project task lists). */
export type TaskSlim = {
  id: string;
  taskRef: string;
  title: string;
  status: string;
  tags: string[];
  category: string | null;
  order: number;
};

/** Full task row + the composed `taskRef` for project page detail surfaces. */
export type TaskFull = Task & { taskRef: string };
