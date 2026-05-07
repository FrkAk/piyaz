import { sql } from "drizzle-orm";
import { projects, tasks, taskEdges } from "@/lib/db/schema";
import { executeRaw, type Conn } from "@/lib/db/raw";

/**
 * Resolve the latest `updated_at` across a project's metadata, every task
 * in the project, and every edge whose source OR target is in the project.
 *
 * Single round trip via `GREATEST` over correlated subqueries so the
 * conditional-GET path fans out one DB query per request, not three.
 *
 * @param conn - Drizzle client or transaction handle.
 * @param projectId - UUID of the project.
 * @returns The latest `updated_at`, or `null` when the project does not exist.
 */
export async function getProjectMaxUpdatedAtRaw(
  conn: Conn,
  projectId: string,
): Promise<Date | null> {
  const rows = await executeRaw<{ max_updated_at: string | Date }>(
    conn,
    sql`
      SELECT GREATEST(
        p.updated_at,
        COALESCE(
          (SELECT MAX(updated_at) FROM ${tasks} WHERE project_id = p.id),
          p.updated_at
        ),
        COALESCE(
          (SELECT MAX(e.updated_at)
           FROM ${taskEdges} e
           WHERE e.source_task_id IN (SELECT id FROM ${tasks} WHERE project_id = p.id)
              OR e.target_task_id IN (SELECT id FROM ${tasks} WHERE project_id = p.id)),
          p.updated_at
        )
      ) AS max_updated_at
      FROM ${projects} p
      WHERE p.id = ${projectId}
    `,
  );
  if (rows.length === 0) return null;
  const value = rows[0].max_updated_at;
  return value instanceof Date ? value : new Date(value);
}
