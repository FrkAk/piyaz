import { sql } from "drizzle-orm";
import { projects, tasks } from "@/lib/db/schema";
import { executeRaw, type Conn } from "@/lib/db/raw";

/** Snapshot of project + task counts for a team's delete cascade. */
export type TeamCascadePreview = { projectCount: number; taskCount: number };

/**
 * Read the project and task counts for an organization in a single
 * statement so both numbers come from the same MVCC snapshot under
 * default `READ COMMITTED` isolation. Splitting into two queries would
 * race with concurrent writes between them.
 *
 * @param conn - Drizzle client or transaction handle.
 * @param organizationId - UUID of the organization.
 * @returns Project and task counts.
 */
export async function previewTeamCascade(
  conn: Conn,
  organizationId: string,
): Promise<TeamCascadePreview> {
  const rows = await executeRaw<{
    project_count: number | string;
    task_count: number | string;
  }>(
    conn,
    sql`
      SELECT
        (SELECT count(*)::int FROM ${projects}
           WHERE ${projects.organizationId} = ${organizationId}) AS project_count,
        (SELECT count(*)::int FROM ${tasks}
           INNER JOIN ${projects} ON ${tasks.projectId} = ${projects.id}
           WHERE ${projects.organizationId} = ${organizationId}) AS task_count
    `,
  );
  const row = rows[0];
  return {
    projectCount: Number(row?.project_count ?? 0),
    taskCount: Number(row?.task_count ?? 0),
  };
}
