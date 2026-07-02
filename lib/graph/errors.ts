/**
 * Custom error types for the graph module.
 */

/**
 * Thrown when the identifier allocation loop exhausts its attempt budget
 * without finding a free suffix for the requested base.
 */
export class IdentifierAllocationError extends Error {
  /**
   * @param base - Starting identifier whose collision could not be resolved.
   */
  constructor(public readonly base: string) {
    super(`Could not allocate unique identifier for base "${base}"`);
    this.name = "IdentifierAllocationError";
  }
}

/**
 * Thrown when a lookup by project UUID returns no row.
 */
export class ProjectNotFoundError extends Error {
  /**
   * @param projectId - UUID that did not match any project.
   */
  constructor(public readonly projectId: string) {
    super(`Project ${projectId} not found`);
    this.name = "ProjectNotFoundError";
  }
}

/** Team option carried in {@link MultiTeamAmbiguityError}. */
export type TeamOption = { readonly id: string; readonly name: string };

/**
 * Thrown by `createProject` when the caller is a member of multiple teams
 * and did not supply `organizationId`. Carries the team list so the
 * tool-handler can surface it to the agent for self-recovery without an
 * extra round trip.
 */
export class MultiTeamAmbiguityError extends Error {
  /**
   * @param teams - Teams the caller belongs to (id + name).
   */
  constructor(public readonly teams: readonly TeamOption[]) {
    const ids = teams.map((t) => t.id).join(", ");
    super(
      `organizationId required: caller is a member of ${teams.length} teams (${ids})`,
    );
    this.name = "MultiTeamAmbiguityError";
  }
}

/**
 * Thrown by `createProject` when the caller has zero team memberships.
 * MCP cannot create a project in nowhere; the caller must onboard first.
 */
export class NoTeamMembershipError extends Error {
  constructor() {
    super("Caller has no team memberships");
    this.name = "NoTeamMembershipError";
  }
}

/**
 * Thrown by `createTask` when a project is at its task-count cap
 * (`MAX_TASKS_PER_PROJECT`). A dedicated type — not `ForbiddenError` —
 * because the MCP error translator renders `ForbiddenError` as an
 * anti-enumeration "not found", which would mislead an agent hitting
 * the quota into retrying lookups instead of stopping.
 */
export class TaskLimitError extends Error {
  /**
   * @param projectId - Project that is at the cap.
   * @param limit - Configured maximum live tasks per project.
   */
  constructor(
    public readonly projectId: string,
    public readonly limit: number,
  ) {
    super(
      `Project has reached its ${limit}-task limit; no new tasks can be created`,
    );
    this.name = "TaskLimitError";
  }
}

/**
 * Thrown by `createEdge` when source and target are the same task. A typed
 * class — not a plain `Error` — so the MCP error translator can surface it
 * as an actionable tool error instead of the opaque `Internal error`.
 */
export class SelfEdgeError extends Error {
  constructor() {
    super("Cannot create self-edge: source and target are the same task.");
    this.name = "SelfEdgeError";
  }
}

/**
 * Thrown by `createEdge` when the two endpoints belong to different
 * projects. Edges are intra-project only (enforced in-app and by the
 * `task_edges_same_project_immutable` trigger).
 */
export class CrossProjectEdgeError extends Error {
  constructor() {
    super("Cannot create edge between tasks in different projects.");
    this.name = "CrossProjectEdgeError";
  }
}

/**
 * Thrown by `createEdge`/`updateEdge` when an identical edge already exists.
 * Carries the endpoints and type so the translator can steer the agent to
 * treat the conflict as success and verify.
 */
export class DuplicateEdgeError extends Error {
  /**
   * @param sourceTaskId - Source endpoint of the conflicting edge.
   * @param targetTaskId - Target endpoint of the conflicting edge.
   * @param edgeType - Relationship type of the conflicting edge.
   * @param message - Existing wording, preserved for callers asserting it.
   */
  constructor(
    public readonly sourceTaskId: string,
    public readonly targetTaskId: string,
    public readonly edgeType: string,
    message = "Duplicate edge: an identical edge already exists.",
  ) {
    super(message);
    this.name = "DuplicateEdgeError";
  }
}

/**
 * Thrown by `createEdge`/`updateEdge` when a `depends_on` edge would close a
 * cycle. Carries the dependency chain that would close the cycle when it is
 * cheaply available (empty otherwise) so the translator can name it.
 */
export class EdgeCycleError extends Error {
  /**
   * @param chainTaskIds - Task ids in the closing dependency chain; empty
   *   when the chain is not cheaply available.
   * @param message - Existing wording, preserved for callers asserting it.
   */
  constructor(
    public readonly chainTaskIds: string[] = [],
    message = "Circular dependency: adding this edge would create a cycle.",
  ) {
    super(message);
    this.name = "EdgeCycleError";
  }
}
