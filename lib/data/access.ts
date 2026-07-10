/**
 * Membership-gated project + task lookups.
 *
 * RLS scopes every read here. `app_user` has no grants on `piyaz_auth.*`;
 * the org metadata join routes through `public.current_user_orgs()`
 * (SECURITY DEFINER). `*Tx` variants take a caller-supplied tx so the
 * access check and the protected work share one `withUserContext` frame.
 */
import "server-only";
import { eq, sql } from "drizzle-orm";
import {
  notes,
  projects,
  tasks,
  type Note,
  type Project,
  type Task,
} from "@/lib/db/schema";
import { executeRaw, type ReadConn } from "@/lib/db/raw";
import { withUserContext, withUserContextRead, type Tx } from "@/lib/db/rls";
import type { ProjectListOrganization } from "@/lib/data/views";
import type { ProjectStatus } from "@/lib/types";

/**
 * Gate columns shared by the interactive finder and the batch statement.
 * `projectStatus`/`projectIdentifier` come from the projects join so task
 * writes can gate on the parent project's lifecycle phase without a
 * second query.
 */
const taskGateColumns = {
  id: tasks.id,
  projectId: tasks.projectId,
  title: tasks.title,
  status: tasks.status,
  files: tasks.files,
  updatedAt: tasks.updatedAt,
  projectStatus: projects.status,
  projectIdentifier: projects.identifier,
} as const;

/** Project gate columns shared by the finder and the batch statement. */
const projectGateColumns = {
  id: projects.id,
  organizationId: projects.organizationId,
  title: projects.title,
  identifier: projects.identifier,
  description: projects.description,
  status: projects.status,
  categories: projects.categories,
  updatedAt: projects.updatedAt,
} as const;

/**
 * Slim task row returned by the membership gate. Only the columns callers
 * read, plus the parent project's lifecycle phase and identifier from the
 * same join.
 */
export type TaskAccessGate = Pick<
  Task,
  "id" | "projectId" | "title" | "status" | "files" | "updatedAt"
> & { projectStatus: ProjectStatus; projectIdentifier: string };

/**
 * Project columns the access check returns. Omits `createdAt` to reduce DB
 * egress; callers only read id, organizationId, identifier, title, status,
 * description, categories, updatedAt.
 */
export type ProjectAccessProject = Omit<Project, "createdAt">;

/** Resolved project access returned when a caller can read a project. */
export type ProjectAccessRow = {
  /** The authorized project row — only the 8 columns callers read. */
  project: ProjectAccessProject;
  /** Caller's `member.role` string from the same JOIN. */
  memberRole: string;
  /** Owning team — projected from the same lookup to save a round-trip. */
  organization: ProjectListOrganization;
};

/**
 * Membership-gated project lookup.
 *
 * @param userId - Verified user id.
 * @param projectId - UUID of the project.
 * @returns Access row, or null when the project is missing or caller is not a member.
 */
export async function findProjectAccess(
  userId: string,
  projectId: string,
): Promise<ProjectAccessRow | null> {
  return withUserContext(userId, (tx) => findProjectAccessTx(tx, projectId));
}

/**
 * {@link findProjectAccess} on a caller-supplied tx.
 *
 * @param tx - Active RLS transaction handle.
 * @param projectId - UUID of the project.
 * @returns Access row, or null when the project is missing or caller is not a member.
 */
export async function findProjectAccessTx(
  tx: Tx,
  projectId: string,
): Promise<ProjectAccessRow | null> {
  const [projectRow] = await tx
    .select(projectGateColumns)
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!projectRow) return null;
  const [org] = await executeRaw<{
    org_id: string;
    name: string;
    slug: string;
    member_role: string;
  }>(
    tx,
    sql`SELECT org_id, name, slug, member_role FROM public.current_user_orgs() WHERE org_id = ${projectRow.organizationId}::uuid LIMIT 1`,
  );
  if (!org) return null;
  return {
    project: projectRow,
    memberRole: org.member_role,
    organization: {
      id: org.org_id,
      name: org.name,
      slug: org.slug,
    },
  };
}

/**
 * Membership-gated task lookup. RLS gates membership; no piyaz_auth JOIN.
 *
 * @param userId - Verified user id.
 * @param taskId - UUID of the task.
 * @returns Gate row with only the columns callers read, or null when inaccessible.
 */
export async function findTaskAccess(
  userId: string,
  taskId: string,
): Promise<TaskAccessGate | null> {
  return withUserContext(userId, (tx) => findTaskAccessTx(tx, taskId));
}

/**
 * {@link findTaskAccess} on a caller-supplied tx.
 *
 * @param tx - Active RLS transaction handle.
 * @param taskId - UUID of the task.
 * @returns Gate row with only the columns callers read, or null when inaccessible.
 */
export async function findTaskAccessTx(
  tx: Tx,
  taskId: string,
): Promise<TaskAccessGate | null> {
  const [row] = await tx
    .select(taskGateColumns)
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId))
    .limit(1);
  return row ?? null;
}

/**
 * Build the task access-gate read as a lazy batch statement. Same
 * projection as {@link findTaskAccessTx}; RLS scopes visibility, so an
 * empty result post-batch means missing task or cross-team access.
 * Evaluate the rows with `assertTaskGateRows`.
 *
 * @param read - Read statement-building handle.
 * @param taskId - UUID of the task.
 * @returns Lazy select statement yielding zero or one gate rows.
 */
export function taskAccessGateStmt(read: ReadConn, taskId: string) {
  return read
    .select(taskGateColumns)
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId))
    .limit(1);
}

/**
 * Note gate columns shared by the interactive finder and the batch
 * statement. `projectStatus`/`projectIdentifier` come from the projects
 * join: writes gate on the parent project's lifecycle phase and link
 * derivation composes taskRefs from the identifier without a second query.
 */
const noteGateColumns = {
  id: notes.id,
  projectId: notes.projectId,
  sequenceNumber: notes.sequenceNumber,
  title: notes.title,
  slug: notes.slug,
  folder: notes.folder,
  visibility: notes.visibility,
  agentWritable: notes.agentWritable,
  locked: notes.locked,
  version: notes.version,
  embeddingStatus: notes.embeddingStatus,
  shareRequestedBy: notes.shareRequestedBy,
  createdBy: notes.createdBy,
  updatedAt: notes.updatedAt,
  deletedAt: notes.deletedAt,
  projectStatus: projects.status,
  projectIdentifier: projects.identifier,
} as const;

/**
 * Slim note row returned by the membership gate. Deliberately does NOT
 * filter `deleted_at`: restore is the one write that must reach trashed
 * rows, so every other caller checks `deletedAt` itself and read queries
 * filter `deleted_at IS NULL` in their own statements.
 */
export type NoteAccessGate = Pick<
  Note,
  | "id"
  | "projectId"
  | "sequenceNumber"
  | "title"
  | "slug"
  | "folder"
  | "visibility"
  | "agentWritable"
  | "locked"
  | "version"
  | "embeddingStatus"
  | "shareRequestedBy"
  | "createdBy"
  | "updatedAt"
  | "deletedAt"
> & { projectStatus: ProjectStatus; projectIdentifier: string };

/**
 * Membership-gated note lookup as one stateless read batch over
 * {@link noteAccessGateStmt}. RLS gates membership and per-note
 * visibility (`team` or own-private); no piyaz_auth JOIN. Like
 * {@link findNoteAccessTx}, trashed rows pass; callers decide the
 * `deletedAt` policy.
 *
 * @param userId - Verified user id.
 * @param noteId - UUID of the note.
 * @returns Gate row with only the columns callers read, or null when inaccessible.
 */
export async function findNoteAccess(
  userId: string,
  noteId: string,
): Promise<NoteAccessGate | null> {
  const [rows] = await withUserContextRead(userId, (read) => [
    noteAccessGateStmt(read, noteId),
  ]);
  return rows[0] ?? null;
}

/**
 * Membership-gated note lookup. RLS gates membership and per-note
 * visibility (`team` or own-private); no piyaz_auth JOIN.
 *
 * @param tx - Active RLS transaction handle.
 * @param noteId - UUID of the note.
 * @param opts - `forUpdate` locks the notes row (`FOR UPDATE OF notes`) so
 *   the gate row doubles as a CAS baseline with no TOCTOU window.
 * @returns Gate row with only the columns callers read, or null when inaccessible.
 */
export async function findNoteAccessTx(
  tx: Tx,
  noteId: string,
  opts?: { forUpdate?: boolean },
): Promise<NoteAccessGate | null> {
  const query = tx
    .select(noteGateColumns)
    .from(notes)
    .innerJoin(projects, eq(projects.id, notes.projectId))
    .where(eq(notes.id, noteId))
    .limit(1);
  const [row] = await (opts?.forUpdate
    ? query.for("update", { of: notes })
    : query);
  return row ?? null;
}

/**
 * Build the note access-gate read as a lazy batch statement. Same
 * projection as {@link findNoteAccessTx}; RLS scopes visibility, so an
 * empty result post-batch means missing note, cross-team access, or
 * another member's private note. Evaluate the rows with
 * `assertNoteGateRows`.
 *
 * @param read - Read statement-building handle.
 * @param noteId - UUID of the note.
 * @returns Lazy select statement yielding zero or one gate rows.
 */
export function noteAccessGateStmt(read: ReadConn, noteId: string) {
  return read
    .select(noteGateColumns)
    .from(notes)
    .innerJoin(projects, eq(projects.id, notes.projectId))
    .where(eq(notes.id, noteId))
    .limit(1);
}

/**
 * Build the project access-gate read as a lazy batch statement. Same
 * project projection as {@link findProjectAccessTx} but WITHOUT the
 * member-role lookup: read paths only need the authorized project row, and
 * RLS already scopes `projects` visibility to the caller's memberships.
 * Evaluate the rows with `assertProjectGateRows`.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project.
 * @returns Lazy select statement yielding zero or one project rows.
 */
export function projectAccessGateStmt(read: ReadConn, projectId: string) {
  return read
    .select(projectGateColumns)
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
}
