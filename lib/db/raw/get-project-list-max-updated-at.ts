import { sql } from "drizzle-orm";
import { projects, tasks, taskEdges } from "@/lib/db/schema";
import { member } from "@/lib/db/auth-schema";
import { executeRaw, type Conn } from "@/lib/db/raw";

/**
 * Resolve the latest `updated_at` across every project the supplied user
 * can access, plus every task and edge belonging to those projects. Used as
 * the conditional-GET validator on `GET /api/projects` so the home grid
 * receives a 304 when nothing in the user's accessible scope has moved.
 *
 * Single round-trip via `GREATEST` over per-table aggregates. The user's
 * accessibility is enforced by the `member` join — the raw helper does no
 * separate auth check, so callers must supply a verified user id.
 *
 * @param conn - Drizzle client or transaction handle.
 * @param userId - Verified user id.
 * @returns The latest `updated_at`, or epoch-0 when the user has no
 *   accessible projects (so a missing-data response still has a stable
 *   validator the client can revalidate against).
 */
export async function getProjectListMaxUpdatedAtRaw(
  conn: Conn,
  userId: string,
): Promise<Date> {
  const rows = await executeRaw<{ max_updated_at: string | Date | null }>(
    conn,
    sql`
      WITH accessible AS (
        SELECT p.id AS project_id, p.updated_at AS project_updated_at
        FROM ${projects} p
        INNER JOIN ${member} m
          ON m.organization_id = p.organization_id
         AND m.user_id = ${userId}
      )
      SELECT GREATEST(
        COALESCE((SELECT MAX(project_updated_at) FROM accessible), TO_TIMESTAMP(0)),
        COALESCE(
          (SELECT MAX(updated_at) FROM ${tasks}
           WHERE project_id IN (SELECT project_id FROM accessible)),
          TO_TIMESTAMP(0)
        ),
        COALESCE(
          (SELECT MAX(updated_at) FROM ${taskEdges}
           WHERE source_task_id IN
             (SELECT id FROM ${tasks}
               WHERE project_id IN (SELECT project_id FROM accessible))
            OR target_task_id IN
             (SELECT id FROM ${tasks}
               WHERE project_id IN (SELECT project_id FROM accessible))),
          TO_TIMESTAMP(0)
        )
      ) AS max_updated_at
    `,
  );
  const value = rows[0]?.max_updated_at ?? null;
  if (value === null) return new Date(0);
  return value instanceof Date ? value : new Date(value);
}
