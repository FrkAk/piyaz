/**
 * Membership-gated project + task lookups.
 *
 * RLS scopes every read here. `app_user` has no grants on `neon_auth.*`;
 * the org metadata join routes through `public.current_user_orgs()`
 * (SECURITY DEFINER). `*Tx` variants take a caller-supplied tx so the
 * access check and the protected work share one `withUserContext` frame.
 */
import "server-only";
import { eq, sql } from "drizzle-orm";
import { projects, tasks, type Project, type Task } from "@/lib/db/schema";
import { executeRaw, type ReadConn } from "@/lib/db/raw";
import { withUserContext, type Tx } from "@/lib/db/rls";
import type { ProjectListOrganization } from "@/lib/data/views";

/** Slim task row returned by the membership gate. Only the columns callers read. */
export type TaskAccessGate = Pick<
  Task,
  "id" | "projectId" | "title" | "status" | "files" | "updatedAt"
>;

/**
 * Project columns the access check returns. Omits `history` and `createdAt`
 * to reduce DB egress; callers only read id, organizationId, identifier,
 * title, status, description, categories, updatedAt.
 */
export type ProjectAccessProject = Omit<Project, "history" | "createdAt">;

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
    .select({
      id: projects.id,
      organizationId: projects.organizationId,
      title: projects.title,
      identifier: projects.identifier,
      description: projects.description,
      status: projects.status,
      categories: projects.categories,
      updatedAt: projects.updatedAt,
    })
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
 * Membership-gated task lookup. RLS gates membership; no neon_auth JOIN.
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
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      title: tasks.title,
      status: tasks.status,
      files: tasks.files,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
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
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      title: tasks.title,
      status: tasks.status,
      files: tasks.files,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
}
