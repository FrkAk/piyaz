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
