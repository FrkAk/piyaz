import "server-only";

import { cache } from "react";
import type { AuthContext } from "@/lib/auth/context";
import type { Tx } from "@/lib/db/rls";
import {
  findNoteAccessTx,
  findProjectAccess,
  findProjectAccessTx,
  findTaskAccess,
  findTaskAccessTx,
  type NoteAccessGate,
  type ProjectAccessRow,
  type TaskAccessGate,
} from "@/lib/data/access";
import {
  roleHasProjectPermission,
  type ProjectAction,
} from "@/lib/auth/permissions";

/** Resource kind a {@link ForbiddenError} refers to. */
export type ForbiddenResource = "project" | "task" | "edge" | "team" | "note";

/** Strict UUID v1-v5 shape. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reject obviously malformed ids before issuing a parameterized SQL query.
 * Postgres raises `22P02 invalid_text_representation` for non-UUID input on
 * a `uuid` column, which would otherwise surface as a 500 instead of a 404.
 * @param id - Candidate UUID string.
 * @returns True when the input matches the UUID shape.
 */
export function isUuid(id: string): boolean {
  return UUID_PATTERN.test(id);
}

/**
 * Thrown when the caller is authenticated but not authorized for the target
 * resource. Default-deny: helpers throw this so the application layer
 * cannot accidentally bypass the check by ignoring a boolean return value.
 *
 * `resource` and `resourceId` let callers translate the error into a
 * resource-specific recovery hint without re-querying the database.
 */
export class ForbiddenError extends Error {
  constructor(
    message = "Forbidden",
    public readonly resource?: ForbiddenResource,
    public readonly resourceId?: string,
  ) {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Thrown when the caller is a member of the resource's org but lacks the
 * role required for the requested action (e.g. delete or rename a project).
 *
 * Extends {@link ForbiddenError} so legacy `instanceof ForbiddenError`
 * checks still trigger; new call sites can branch on the subclass to
 * distinguish "not your team" (anti-enumeration → 404) from "wrong role"
 * (legitimate 403 with actionable copy).
 *
 * Carries the full required-action list so consumers can render an accurate
 * message when more than one action was requested. `primaryAction` is the
 * first entry — convenient for single-action UX where the message just says
 * e.g. "Only team admins can delete projects."
 */
export class InsufficientRoleError extends ForbiddenError {
  constructor(
    public readonly requiredActions: readonly ProjectAction[],
    resource?: ForbiddenResource,
    resourceId?: string,
  ) {
    super("InsufficientRole", resource, resourceId);
    this.name = "InsufficientRoleError";
  }

  /** First requested action — used for single-action user-facing copy. */
  get primaryAction(): ProjectAction {
    return this.requiredActions[0];
  }
}

/** Result of a successful {@link assertProjectAccess} call. */
export type ProjectAccess = ProjectAccessRow;

/**
 * Verify the caller can access the project and return its row plus the
 * caller's role. The caller must hold a membership row in the project's
 * organization. A single SQL JOIN performs both checks atomically so the
 * predicate cannot be split. The active organization is intentionally not
 * part of the gate — users can read and write any project belonging to a
 * team they're a member of, regardless of which team is currently selected
 * as the default for new projects.
 *
 * When `required` is provided, the caller's role (read from the same JOIN)
 * is also evaluated against the requested project actions; insufficient
 * role surfaces as {@link InsufficientRoleError} so the caller can return
 * a typed 403 distinct from the membership-failure 404.
 *
 * Returning the role alongside the row lets downstream code derive UI
 * capabilities (e.g. `canRename`) without a second `member` query — the
 * JOIN already loaded the value.
 *
 * @param projectId - UUID of the project to authorize.
 * @param ctx - Resolved auth context.
 * @param required - Optional permission gate (e.g. `{ project: ["delete"] }`).
 * @returns The full project row and the caller's member role.
 * @throws ForbiddenError if the user is not a member of the project's
 *   organization. The same error is thrown when the project does not
 *   exist, to avoid leaking org membership.
 * @throws InsufficientRoleError when the caller is a member but their role
 *   does not grant every action in `required.project`.
 */
export async function assertProjectAccess(
  projectId: string,
  ctx: AuthContext,
  required?: { project: readonly ProjectAction[] },
): Promise<ProjectAccess> {
  assertValidProjectId(projectId);
  const access = await findProjectAccess(ctx.userId, projectId);
  if (!access) throw new ForbiddenError("Forbidden", "project", projectId);
  if (
    required &&
    !roleHasProjectPermission(access.memberRole, required.project)
  ) {
    throw new InsufficientRoleError(required.project, "project", projectId);
  }
  return access;
}

/**
 * Membership-gated project access row, memoized for the lifetime of one RSC
 * request. Keyed on `(userId, projectId)` strings — not the per-call
 * `AuthContext` object — so the workspace layout and page share a single
 * project-access read per navigation. Same access boundary as
 * {@link assertProjectAccess}: RLS scopes the read and the membership
 * JOIN gates it; missing or cross-team projects raise
 * {@link ForbiddenError} (anti-enumeration 404).
 *
 * @param userId - Verified user id from the request's auth context.
 * @param projectId - UUID of the project to authorize.
 * @returns The access row with the project, caller role, and owning team.
 * @throws ForbiddenError on malformed, missing, or cross-team project.
 */
export const loadProjectAccess = cache(
  async (userId: string, projectId: string): Promise<ProjectAccess> => {
    assertValidProjectId(projectId);
    const access = await findProjectAccess(userId, projectId);
    if (!access) throw new ForbiddenError("Forbidden", "project", projectId);
    return access;
  },
);

/**
 * {@link assertProjectAccess} on a caller-supplied tx so the access
 * check shares one `withUserContext` frame with the protected work.
 *
 * @param tx - Active RLS transaction handle.
 * @param projectId - UUID of the project to authorize.
 * @param required - Optional permission gate (e.g. `{ project: ["delete"] }`).
 * @returns The full project row and the caller's member role.
 * @throws ForbiddenError on missing project or non-member access.
 * @throws InsufficientRoleError when role does not satisfy `required`.
 */
export async function assertProjectAccessTx(
  tx: Tx,
  projectId: string,
  required?: { project: readonly ProjectAction[] },
): Promise<ProjectAccess> {
  assertValidProjectId(projectId);
  const access = await findProjectAccessTx(tx, projectId);
  if (!access) throw new ForbiddenError("Forbidden", "project", projectId);
  if (
    required &&
    !roleHasProjectPermission(access.memberRole, required.project)
  ) {
    throw new InsufficientRoleError(required.project, "project", projectId);
  }
  return access;
}

/**
 * Verify the caller can access the task and return its gate row. Joins
 * through the parent project to confirm the caller is a member of the
 * project's organization. The active organization is not part of the gate
 * — membership in the resource's team is the boundary.
 *
 * @param taskId - UUID of the task to authorize.
 * @param ctx - Resolved auth context.
 * @returns The slim gate row for the task.
 * @throws ForbiddenError on missing task or cross-team access.
 */
export async function assertTaskAccess(
  taskId: string,
  ctx: AuthContext,
): Promise<TaskAccessGate> {
  assertValidTaskId(taskId);
  const task = await findTaskAccess(ctx.userId, taskId);
  if (!task) throw new ForbiddenError("Forbidden", "task", taskId);
  return task;
}

/**
 * {@link assertTaskAccess} on a caller-supplied tx.
 *
 * @param tx - Active RLS transaction handle.
 * @param taskId - UUID of the task to authorize.
 * @returns The slim gate row for the task.
 * @throws ForbiddenError on missing task or cross-team access.
 */
export async function assertTaskAccessTx(
  tx: Tx,
  taskId: string,
): Promise<TaskAccessGate> {
  assertValidTaskId(taskId);
  const task = await findTaskAccessTx(tx, taskId);
  if (!task) throw new ForbiddenError("Forbidden", "task", taskId);
  return task;
}

/**
 * Verify the caller can access the note and return its gate row. Joins
 * through the parent project; RLS additionally hides other members'
 * private notes, so those surface as the same 404-shaped error as a
 * missing note. Trashed notes still pass the gate (the row carries
 * `deletedAt`) — restore is the one caller that needs them, and every
 * other caller rejects or filters on `deletedAt` itself.
 *
 * @param tx - Active RLS transaction handle.
 * @param noteId - UUID of the note to authorize.
 * @returns The slim gate row for the note.
 * @throws ForbiddenError on malformed id, missing note, cross-team access,
 *   or another member's private note.
 */
export async function assertNoteAccessTx(
  tx: Tx,
  noteId: string,
): Promise<NoteAccessGate> {
  assertValidNoteId(noteId);
  const note = await findNoteAccessTx(tx, noteId);
  if (!note) throw new ForbiddenError("Forbidden", "note", noteId);
  return note;
}

/**
 * Reject a malformed task id before any statement is built: a non-UUID id
 * must surface as a 404-shaped ForbiddenError, not as a Postgres `22P02`
 * cast failure. The single malformed-id guard shared by the access gates
 * above and the batch read paths.
 *
 * @param taskId - Candidate task id from the caller.
 * @throws ForbiddenError when the id is not UUID-shaped.
 */
export function assertValidTaskId(taskId: string): void {
  if (!isUuid(taskId)) {
    throw new ForbiddenError("Forbidden", "task", taskId);
  }
}

/**
 * Reject a malformed project id before any statement is built. See
 * {@link assertValidTaskId}.
 *
 * @param projectId - Candidate project id from the caller.
 * @throws ForbiddenError when the id is not UUID-shaped.
 */
export function assertValidProjectId(projectId: string): void {
  if (!isUuid(projectId)) {
    throw new ForbiddenError("Forbidden", "project", projectId);
  }
}

/**
 * Reject a malformed note id before any statement is built. See
 * {@link assertValidTaskId}.
 *
 * @param noteId - Candidate note id from the caller.
 * @throws ForbiddenError when the id is not UUID-shaped.
 */
export function assertValidNoteId(noteId: string): void {
  if (!isUuid(noteId)) {
    throw new ForbiddenError("Forbidden", "note", noteId);
  }
}

/**
 * The single RLS read-path gate contract: an empty batch result means the
 * resource is missing or cross-team — both 404-shaped. Every batch gate
 * evaluator delegates here so the emptiness rule cannot drift per resource.
 *
 * @param resource - Resource kind for the error payload.
 * @param id - UUID the gate statement targeted.
 * @param rows - Rows from the batch result.
 * @returns The first visible row.
 * @throws ForbiddenError when no row is visible to the caller.
 */
export function firstRowOrForbidden<T>(
  resource: ForbiddenResource,
  id: string,
  rows: readonly T[],
): T {
  const row = rows[0];
  if (!row) throw new ForbiddenError("Forbidden", resource, id);
  return row;
}

/**
 * Evaluate the access-gate rows returned by a `projectAccessGateStmt`
 * batch statement. RLS scopes `projects` rows to the caller's memberships,
 * so an empty result means missing project or cross-team access. Read-path
 * only: unlike {@link assertProjectAccessTx} this carries no member role,
 * so it cannot answer permission (`required`) questions.
 *
 * @param projectId - UUID of the project the gate statement targeted.
 * @param rows - Gate rows from the batch result.
 * @returns The authorized project slice.
 * @throws ForbiddenError when no project row is visible to the caller.
 */
export function assertProjectGateRows<T>(
  projectId: string,
  rows: readonly T[],
): T {
  return firstRowOrForbidden("project", projectId, rows);
}

/**
 * Evaluate the access-gate rows returned by a `taskAccessGateStmt` batch
 * statement. The batch read path counterpart of {@link assertTaskAccessTx}:
 * RLS already filtered invisible rows, so an empty result means missing
 * task or cross-team access — both 404-shaped.
 *
 * @param taskId - UUID of the task the gate statement targeted.
 * @param rows - Gate rows from the batch result.
 * @returns The slim gate row for the task.
 * @throws ForbiddenError when no gate row is visible to the caller.
 */
export function assertTaskGateRows(
  taskId: string,
  rows: readonly TaskAccessGate[],
): TaskAccessGate {
  return firstRowOrForbidden("task", taskId, rows);
}

/**
 * Evaluate the access-gate rows returned by a `noteAccessGateStmt` batch
 * statement. The batch read path counterpart of {@link assertNoteAccessTx}:
 * RLS already filtered invisible rows, so an empty result means missing
 * note, cross-team access, or another member's private note — all
 * 404-shaped.
 *
 * @param noteId - UUID of the note the gate statement targeted.
 * @param rows - Gate rows from the batch result.
 * @returns The slim gate row for the note.
 * @throws ForbiddenError when no gate row is visible to the caller.
 */
export function assertNoteGateRows(
  noteId: string,
  rows: readonly NoteAccessGate[],
): NoteAccessGate {
  return firstRowOrForbidden("note", noteId, rows);
}
