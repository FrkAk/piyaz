import "server-only";
import { and, eq, getTableColumns } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, tasks, type Project, type Task } from "@/lib/db/schema";
import { member, organization } from "@/lib/db/auth-schema";
import type { ProjectListOrganization } from "@/lib/data/views";

/** Resolved project access — what the membership JOIN returns when a caller can read a project. */
export type ProjectAccessRow = {
  /** The authorized project row. */
  project: Project;
  /** Caller's `member.role` string from the same JOIN. */
  memberRole: string;
  /** Owning team — projected from the same JOIN to save a round-trip. */
  organization: ProjectListOrganization;
};

/**
 * Single-query membership-gated project lookup. Inner-joins
 * `projects × member × organization` and projects all three so callers
 * don't need a follow-up org fetch.
 *
 * @param userId - Verified user id.
 * @param projectId - UUID of the project.
 * @returns Access row, or null when the project doesn't exist or the user is not a member.
 */
export async function findProjectAccess(
  userId: string,
  projectId: string,
): Promise<ProjectAccessRow | null> {
  const [row] = await db
    .select({
      project: getTableColumns(projects),
      memberRole: member.role,
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
      },
    })
    .from(projects)
    .innerJoin(
      member,
      and(
        eq(member.organizationId, projects.organizationId),
        eq(member.userId, userId),
      ),
    )
    .innerJoin(organization, eq(organization.id, projects.organizationId))
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}

/**
 * Single-query membership-gated task lookup via the project chain.
 *
 * @param userId - Verified user id.
 * @param taskId - UUID of the task.
 * @returns Full task row when the user can access it, null otherwise.
 */
export async function findTaskAccess(
  userId: string,
  taskId: string,
): Promise<Task | null> {
  const [row] = await db
    .select(getTableColumns(tasks))
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(
      member,
      and(
        eq(member.organizationId, projects.organizationId),
        eq(member.userId, userId),
      ),
    )
    .where(eq(tasks.id, taskId))
    .limit(1);
  return row ?? null;
}
