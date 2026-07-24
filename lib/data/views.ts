import type {
  NoteLink,
  NoteTaskLink,
  Project,
  Task,
  TaskEdge,
} from "@/lib/db/schema";
import type { TaskState } from "@/lib/data/task";
import type {
  AcceptanceCriterion,
  Decision,
  Priority,
  Estimate,
  NoteType,
  TaskStatus,
} from "@/lib/types";

/**
 * Lightweight assignee projection used by surfaces that render
 * the people assigned to a task. Source: `task_assignees` joined
 * to `piyaz_auth.user`.
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

/**
 * Per-project task progress counts shown on the home grid. One bucket per
 * persisted task status so the lifecycle bar can colour each status band;
 * `total` is the sum across every bucket.
 */
export type ProjectTaskStats = {
  total: number;
  done: number;
  inReview: number;
  inProgress: number;
  planned: number;
  draft: number;
  cancelled: number;
};

/**
 * Progress buckets the lifecycle bar renders as bands — every
 * {@link ProjectTaskStats} count except the `total` roll-up and `cancelled`
 * (excluded from the denominator, not shown as progress).
 */
export type ProgressBucket = Exclude<
  keyof ProjectTaskStats,
  "total" | "cancelled"
>;

/**
 * Canonical persisted-status → {@link ProjectTaskStats} bucket map: the single
 * source of truth shared by the server roll-up (`accumulateTaskStats`) and the
 * client lifecycle bar. Typed `Record<TaskStatus, …>` so adding or renaming a
 * status is a compile error here instead of a silently under-filled bar.
 */
export const STATUS_BUCKET: Record<TaskStatus, keyof ProjectTaskStats> = {
  draft: "draft",
  planned: "planned",
  in_progress: "inProgress",
  in_review: "inReview",
  done: "done",
  cancelled: "cancelled",
};

/**
 * Project entry returned by `listProjectsSlim`. Carries only the columns the
 * home grid and sidebar render (id, organizationId, title, identifier,
 * description, status, updatedAt); categories and createdAt are omitted to
 * keep the wire payload slim.
 */
export type ProjectListEntry = Pick<
  Project,
  | "id"
  | "organizationId"
  | "title"
  | "identifier"
  | "description"
  | "status"
  | "updatedAt"
> & {
  organization: ProjectListOrganization;
  memberRole: string;
  taskStats: ProjectTaskStats;
  progress: number;
};

/**
 * Minimal project nav row returned by `listProjectIndex` — the columns the
 * ⌘K command palette needs to jump to a project. No task stats, joins, or
 * timestamps, so the whole accessible set fits in one slim payload.
 */
export type ProjectIndexEntry = Pick<
  Project,
  "id" | "organizationId" | "title" | "identifier"
>;

/**
 * Slim project entry returned by `listProjectsForMcp` — the agent-facing
 * shape for `piyaz_workspace action='projects'`. Strips description, categories,
 * and timestamps to keep the payload tight; agents fetch the
 * description and tag vocabulary on demand via `piyaz_get project view='meta'`.
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

/**
 * Slim task entry returned by the project graph payload. `updatedAt`
 * carries the content clock (`tasks.updated_at`): StructureView renders
 * it as lastActive and sorts on it, so heavy writes must surface here.
 * The graph route's `graph`-mode validator folds the same clock, keeping
 * the payload byte-stable under a 304.
 */
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
   * True when `executionRecord` is non-null. Lets the bundle preview mirror
   * the builders' record-gated lists (Abandoned Approaches, upstream
   * execution records) without shipping record text in the slim payload.
   */
  hasExecutionRecord: boolean;
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

/** Slim edge entry returned by the project graph payload. */
export type TaskGraphEdge = Pick<
  TaskEdge,
  "id" | "sourceTaskId" | "targetTaskId" | "edgeType"
>;

/** Connected edge carried on {@link TaskFullWithEdges} — slim graph edge plus
 * the `note` the detail relationships list renders. Omits the timestamp fields
 * so the JSON shape matches the type across the API boundary. */
export type TaskEdgeRef = TaskGraphEdge & Pick<TaskEdge, "note">;

/**
 * Slim note entry returned by the project graph payload. Mirrors
 * {@link TaskGraphSlim}'s ref composition: `noteRef` is the composed
 * `<IDENT>-N<seq>` string. Only the fields the canvas and rail render ship;
 * `fed` derives from `feedMode != 'none'`.
 */
export type NoteGraphSlim = {
  id: string;
  noteRef: string;
  title: string;
  type: NoteType;
  fed: boolean;
};

/** Slim note-to-note edge for the graph payload. Keyed client-side by the
 * endpoint pair (`note_links` is unique on it), so no `id` ships. */
export type NoteGraphEdge = Pick<NoteLink, "sourceNoteId" | "targetNoteId">;

/** Slim note-to-task edge for the graph payload. Pairs are deduped
 * server-side to the strongest `kind` (`spec_of` > `reference` > `mention`)
 * so the canvas styles deliberate links apart from body mentions. */
export type NoteTaskGraphEdge = Pick<
  NoteTaskLink,
  "noteId" | "taskId" | "kind"
>;

/** Slim project graph for the workspace canvas + list. Edges, tasks, and
 * notes are projected down to the fields the graph surfaces render. The
 * project block's `updatedAt` carries the content clock
 * (`projects.updated_at`), matching the route's `graph` validator. */
export type ProjectGraphSlim = {
  project: Pick<
    Project,
    | "id"
    | "organizationId"
    | "identifier"
    | "title"
    | "description"
    | "status"
    | "updatedAt"
    | "categories"
  >;
  tasks: TaskGraphSlim[];
  edges: TaskGraphEdge[];
  notes: NoteGraphSlim[];
  noteLinks: NoteGraphEdge[];
  noteTaskLinks: NoteTaskGraphEdge[];
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

/**
 * Personal task projection. Drops `assigneeCount` / `assigneeUserIds`
 * because `listMyTasks` does not join co-assignees in — every row is the
 * caller's by construction, so the avatar slot in `MyTasksRow` renders
 * the session user directly. Fetch the task through a non-personal
 * surface (e.g. project graph) when the true assignee set is required.
 *
 * `upstreamCount` / `downstreamCount` count direct `depends_on` edges
 * only (no transitive walk), matching the workspace structure view.
 * `state` and `blockedBy` are likewise derived from direct dependencies:
 * `blockedBy` carries the taskRef of the lowest-sequence direct upstream
 * that is neither done nor cancelled, when one exists.
 *
 * `updatedAt` carries the content clock (`tasks.updated_at`), matching
 * the graph payload: the list sorts on recency of any change, and
 * realtime patches the row in place when a heavy write skips the refetch.
 */
export type MyTask = Omit<
  TaskGraphSlim,
  "assigneeCount" | "assigneeUserIds" | "hasExecutionRecord"
> & {
  project: {
    id: string;
    identifier: string;
    title: string;
    color: string;
  };
  /** Count of direct `depends_on` edges the task is the source of. */
  upstreamCount: number;
  /** Count of direct `depends_on` edges the task is the target of. */
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
 * `task.acceptanceCriteria` and `task.decisions` directly. Omits
 * `metaUpdatedAt`: no writer or validator reads the task metadata clock
 * (see `lib/db/schema.ts`), and detail surfaces render `updatedAt`.
 */
export type TaskFull = Omit<Task, "metaUpdatedAt"> & {
  taskRef: string;
  assignees: AssigneeRef[];
  acceptanceCriteria: AcceptanceCriterion[];
  decisions: Decision[];
  links: TaskLinkRef[];
};

/** {@link TaskFull} plus the task's connected edges (slim + `note`). Only the
 * task-detail endpoint needs edges, so they are layered on here rather than on
 * the universal {@link TaskFull} that every `getTaskFull` caller pays for. */
export type TaskFullWithEdges = TaskFull & { edges: TaskEdgeRef[] };
