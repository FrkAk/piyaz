/** Semantic relationship between two tasks. */
export type EdgeType = "depends_on" | "relates_to";

/** Top-level project lifecycle status. */
export type ProjectStatus =
  | "brainstorming"
  | "decomposing"
  | "active"
  | "archived";

/** Task lifecycle status. */
export type TaskStatus =
  | "draft"
  | "planned"
  | "in_progress"
  | "in_review"
  | "done"
  | "cancelled";

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

/** A timestamped event in a node's history. */
export type HistoryEntry = {
  id: string;
  type:
    | "created"
    | "refined"
    | "decision"
    | "edge_added"
    | "edge_removed"
    | "edge_updated"
    | "status_change"
    | "planned"
    | "moved";
  date: string;
  label: string;
  description: string;
  actor: "user" | "ai";
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
  | "criterion_checked"
  | "criterion_unchecked"
  | "decision_added"
  | "decision_removed"
  | "link_added"
  | "link_removed"
  | "edge_added"
  | "edge_removed"
  | "edge_updated"
  | "project_created";

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
