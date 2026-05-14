/** Semantic relationship between two tasks. */
export type EdgeType = "depends_on" | "relates_to";

/** Top-level project lifecycle status. */
export type ProjectStatus =
  | "brainstorming"
  | "decomposing"
  | "active"
  | "archived";

/** Task lifecycle status. */
export type TaskStatus = "draft" | "planned" | "in_progress" | "in_review" | "done" | "cancelled";

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

/** A verifiable acceptance criterion for a task. */
export type AcceptanceCriterion = {
  id: string;
  text: string;
  checked: boolean;
};
