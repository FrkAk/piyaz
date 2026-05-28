import type { Project, Task, TaskEdge } from "@/lib/db/schema";
import type { TaskState } from "@/lib/data/task";
import type {
  AcceptanceCriterion,
  Decision,
  Priority,
  Estimate,
} from "@/lib/types";

/**
 * Lightweight assignee projection used by surfaces that render
 * the people assigned to a task. Source: `task_assignees` joined
 * to `neon_auth.user`.
 */
export type AssigneeRef = {
  userId: string;
  name: string;
  email: string;
};

/**
 * Projection of a single `task_links` row for the task detail surface and
 * context builders. `host` is derived on read from `url` (not stored) so the
 * DB stays single-sourced and renaming hosts in the classifier doesn't
 * require a backfill.
 */
export type TaskLinkRef = {
  id: string;
  kind: string;
  url: string;
  label: string | null;
  createdAt: Date;
};

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
  | "id"
  | "title"
  | "status"
  | "category"
  | "tags"
  | "priority"
  | "estimate"
  | "order"
  | "updatedAt"
> & {
  taskRef: string;
  /** True when `description` is non-empty after trimming whitespace. */
  hasDescription: boolean;
  /** True when `acceptanceCriteria` has at least one entry. */
  hasCriteria: boolean;
  /**
   * Derived state computed server-side using the project's effective
   * dependency graph. The schema only stores `status`; this is the
   * UI-facing projection (see {@link TaskState} in `lib/data/task.ts`)
   * that surfaces sub-stages like `plannable` / `ready` / `blocked`. The
   * client must NOT recompute this — drift between client and server
   * derivations is exactly what this projection eliminates.
   */
  state: TaskState;
  /** Number of users assigned to this task. */
  assigneeCount: number;
  /**
   * User IDs assigned to this task, ordered deterministically by the
   * database. Drives row-level avatar stacks; full names load on hover
   * via the team-member cache so the slim payload stays small.
   */
  assigneeUserIds: string[];
};

/** Slim project graph for the workspace canvas + list. Edges are returned
 * in full (they have no heavy fields), tasks are slim. */
export type ProjectGraphSlim = {
  project: Pick<
    Project,
    | "id"
    | "organizationId"
    | "identifier"
    | "title"
    | "status"
    | "updatedAt"
    | "categories"
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

/** Derived from `state`, not a schema column. */
export type LifecycleStage = "draft" | "planning" | "working" | "done";

/**
 * `blockedBy` carries the taskRef of the first non-done effective upstream
 * when the row is blocked.
 *
 * `MyTask` inherits `assigneeCount` and `assigneeUserIds` from
 * {@link TaskGraphSlim}, but `listMyTasks` only ever fills them with the
 * caller's own user; co-assignees are not joined in. Treat both fields as
 * projection-local: do NOT use them to render an assignee stack or to count
 * collaborators on the task. If you need the true assignee set, fetch the
 * task through a non-personal surface (e.g. project graph).
 */
export type MyTask = TaskGraphSlim & {
  project: {
    id: string;
    identifier: string;
    title: string;
    color: string;
  };
  stage: LifecycleStage;
  upstreamCount: number;
  downstreamCount: number;
  blockedBy: string | null;
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
  priority: Priority | null;
  estimate: Estimate | null;
  assigneeCount: number;
  order: number;
};

/**
 * Full task row + the composed `taskRef`, assignees, criteria, decisions, and
 * links for project page detail surfaces. Criteria and decisions live in
 * relational child tables (`task_acceptance_criteria`, `task_decisions`);
 * this type carries them via join so consumers read
 * `task.acceptanceCriteria` and `task.decisions` directly.
 */
export type TaskFull = Task & {
  taskRef: string;
  assignees: AssigneeRef[];
  acceptanceCriteria: AcceptanceCriterion[];
  decisions: Decision[];
  links: TaskLinkRef[];
};
