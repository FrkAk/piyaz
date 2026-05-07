import { sql } from "drizzle-orm";
import { tasks, taskEdges } from "@/lib/db/schema";
import { executeRaw, type Conn } from "@/lib/db/raw";

/** A task in a `depends_on` chain with its depth (1-based). */
export type DependencyChainRow = { id: string; depth: number };

/**
 * Walk forward `depends_on` edges from `taskId`, depth-bounded. Joins
 * `tasks` at every step and filters on `projectId` so a stale or
 * hand-crafted cross-project edge cannot leak into the result.
 *
 * @param conn - Drizzle client or transaction handle.
 * @param taskId - UUID of the starting task.
 * @param projectId - UUID of the project the starting task belongs to.
 * @param maxDepth - Maximum traversal depth.
 * @returns Distinct tasks reachable along `depends_on`, ordered by min depth ascending.
 */
export async function fetchDependencyChain(
  conn: Conn,
  taskId: string,
  projectId: string,
  maxDepth: number,
): Promise<DependencyChainRow[]> {
  const rows = await executeRaw<{ id: string; depth: number | string }>(
    conn,
    sql`
      WITH RECURSIVE dep_chain AS (
        SELECT
          e.target_task_id AS id,
          1 AS depth
        FROM ${taskEdges} e
        INNER JOIN ${tasks} t ON t.id = e.target_task_id
        WHERE e.source_task_id = ${taskId}
          AND e.edge_type = 'depends_on'
          AND t.project_id = ${projectId}

        UNION ALL

        SELECT
          e.target_task_id AS id,
          dc.depth + 1 AS depth
        FROM ${taskEdges} e
        INNER JOIN dep_chain dc ON e.source_task_id = dc.id
        INNER JOIN ${tasks} t ON t.id = e.target_task_id
        WHERE e.edge_type = 'depends_on'
          AND t.project_id = ${projectId}
          AND dc.depth < ${maxDepth}
      )
      SELECT DISTINCT id, MIN(depth) AS depth
      FROM dep_chain
      GROUP BY id
      ORDER BY depth ASC
    `,
  );
  return rows.map((r) => ({ id: r.id, depth: Number(r.depth) }));
}
