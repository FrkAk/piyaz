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
import {
  projects,
  tasks,
  type Project,
  type Task,
} from "@/lib/db/schema";
import { executeRaw } from "@/lib/db/raw";
import { withUserContext, type Tx } from "@/lib/db/rls";
import type { ProjectListOrganization } from "@/lib/data/views";

/** Resolved project access returned when a caller can read a project. */
export type ProjectAccessRow = {
  /** The authorized project row. */
  project: Project;
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
    .select()
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
 * @returns Task row when accessible, null otherwise.
 */
export async function findTaskAccess(
  userId: string,
  taskId: string,
): Promise<Task | null> {
  return withUserContext(userId, (tx) => findTaskAccessTx(tx, taskId));
}

/**
 * {@link findTaskAccess} on a caller-supplied tx.
 *
 * @param tx - Active RLS transaction handle.
 * @param taskId - UUID of the task.
 * @returns Task row when accessible, null otherwise.
 */
export async function findTaskAccessTx(
  tx: Tx,
  taskId: string,
): Promise<Task | null> {
  const [row] = await tx
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  return row ?? null;
}
