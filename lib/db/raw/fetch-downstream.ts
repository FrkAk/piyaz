import { sql } from "drizzle-orm";
import { tasks, taskEdges } from "@/lib/db/schema";
import { executeRaw, type Conn } from "@/lib/db/raw";

/** A task in a downstream-dependents chain with its depth (1-based). */
export type DownstreamRow = { id: string; depth: number };

/**
 * Walk backward `depends_on` edges from `taskId` (i.e. find tasks that
 * depend on it), depth-bounded. Filters on `projectId` at every step.
 *
 * @param conn - Drizzle client or transaction handle.
 * @param taskId - UUID of the starting task.
 * @param projectId - UUID of the project the starting task belongs to.
 * @param maxDepth - Maximum traversal depth.
 * @returns Distinct dependent tasks, ordered by min depth ascending.
 */
export async function fetchDownstream(
  conn: Conn,
  taskId: string,
  projectId: string,
  maxDepth: number,
): Promise<DownstreamRow[]> {
  const rows = await executeRaw<{ id: string; depth: number | string }>(
    conn,
    sql`
      WITH RECURSIVE downstream AS (
        SELECT
          e.source_task_id AS id,
          1 AS depth
        FROM ${taskEdges} e
        INNER JOIN ${tasks} t ON t.id = e.source_task_id
        WHERE e.target_task_id = ${taskId}
          AND e.edge_type = 'depends_on'
          AND t.project_id = ${projectId}

        UNION ALL

        SELECT
          e.source_task_id AS id,
          ds.depth + 1 AS depth
        FROM ${taskEdges} e
        INNER JOIN downstream ds ON e.target_task_id = ds.id
        INNER JOIN ${tasks} t ON t.id = e.source_task_id
        WHERE e.edge_type = 'depends_on'
          AND t.project_id = ${projectId}
          AND ds.depth < ${maxDepth}
      )
      SELECT DISTINCT id, MIN(depth) AS depth
      FROM downstream
      GROUP BY id
      ORDER BY depth ASC
    `,
  );
  return rows.map((r) => ({ id: r.id, depth: Number(r.depth) }));
}
