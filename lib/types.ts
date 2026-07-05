/** Semantic relationship between two tasks. */
export type EdgeType = "depends_on" | "relates_to";

/** Top-level project lifecycle status. */
export type ProjectStatus =
  | "brainstorming"
  | "decomposing"
  | "active"
  | "archived";

/**
 * Project lifecycle phases in progression order. Shared by the MCP
 * workspace transition hints and the phase-gating checks so the order
 * lives in one place.
 */
export const PROJECT_STATUS_ORDER = [
  "brainstorming",
  "decomposing",
  "active",
  "archived",
] as const satisfies readonly ProjectStatus[];

/**
 * Task lifecycle statuses in progression order (`cancelled` is terminal
 * from any phase). Shared by the MCP status schema, the edit-op validator,
 * and the status-jump hints so the lifecycle list lives in one place.
 */
export const TASK_STATUSES = [
  "draft",
  "planned",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;

/** Task lifecycle status. */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Terminal task statuses — work that will never resume. Shared by the
 * bundle dispatch (agent depth falls back to the retrospective record
 * bundle), the context route's record gate, and the per-depth column
 * projections, so the lifecycle rule lives in one place.
 */
export const TERMINAL_STATUSES = ["done", "cancelled"] as const;

/**
 * Narrow a status string to a terminal status.
 *
 * @param status - Schema task status.
 * @returns Whether the status is `done` or `cancelled`.
 */
export function isTerminalStatus(
  status: string,
): status is (typeof TERMINAL_STATUSES)[number] {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Task priority. */
export type Priority = "urgent" | "core" | "normal" | "backlog";

/** Fibonacci story-point estimate. */
export type Estimate = 1 | 2 | 3 | 5 | 8 | 13;

/** A recorded decision made during any project phase. */
export type Decision = {
  id: string;
  text: string;
  date: string;
  source: "brainstorm" | "refinement" | "planning" | "execution";
};

/** Discrete, append-only activity event kinds for the audit log. */
export type ActivityEventType =
  | "task_created"
  | "title_changed"
  | "description_changed"
  | "status_changed"
  | "priority_changed"
  | "estimate_changed"
  | "category_changed"
  | "moved"
  | "tag_added"
  | "tag_removed"
  | "plan_set"
  | "record_set"
  | "files_changed"
  | "assignee_added"
  | "assignee_removed"
  | "criterion_added"
  | "criterion_removed"
  | "criterion_edited"
  | "criterion_checked"
  | "criterion_unchecked"
  | "decision_added"
  | "decision_removed"
  | "decision_edited"
  | "link_added"
  | "link_removed"
  | "link_updated"
  | "edge_added"
  | "edge_removed"
  | "edge_updated"
  | "project_created"
  | "note_created"
  | "note_updated"
  | "note_moved"
  | "note_deleted"
  | "note_restored";

/** Origin of an activity event. */
export type ActivitySource = "web" | "mcp" | "system";

/** Read-model row for the activity panel and audit feeds. */
export type ActivityEvent = {
  id: string;
  projectId: string;
  taskId: string | null;
  type: ActivityEventType;
  createdAt: string;
  actorUserId: string | null;
  actorName: string | null;
  actorAvatar: string | null;
  source: ActivitySource;
  agent: string | null;
  /**
   * Whether the harness OAuth client is on the verified allowlist. Gates brand
   * polish in the UI (`formatOAuthClientName`): an unverified client's raw
   * registered name is shown verbatim so a spoofed name is never laundered.
   */
  agentVerified: boolean;
  summary: string;
  targetRef: string | null;
  metadata: Record<string, unknown> | null;
};

/** A verifiable acceptance criterion for a task. */
export type AcceptanceCriterion = {
  id: string;
  text: string;
  checked: boolean;
};

/** Editorial kind of a note: reference material, guidance, or knowledge. */
export type NoteType = "reference" | "guidance" | "knowledge";

/** Note visibility scope: author-only or shared with the whole team. */
export type Visibility = "private" | "team";

/** How a note's feed selects tasks for agent exposure. */
export type FeedMode = "none" | "all" | "categories" | "tags" | "tasks";

/** Semantic relationship between a note and a task. */
export type NoteTaskLinkKind = "mention" | "reference" | "spec_of";

/** Lifecycle state of a note's semantic embedding. */
export type EmbeddingStatus = "none" | "pending" | "ready" | "failed" | "stale";
