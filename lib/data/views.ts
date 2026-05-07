import "server-only";
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

/** Project + tasks + edges + owning team — what the project page consumes. */
export type ProjectFull = Project & {
  tasks: Task[];
  edges: TaskEdge[];
  memberRole: string;
  organization: ProjectListOrganization;
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
