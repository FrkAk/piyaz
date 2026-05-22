import { sql } from "drizzle-orm";
import { tasks, taskEdges } from "@/lib/db/schema";
import { executeRaw, type Conn } from "@/lib/db/raw";

/** A task in an effective `depends_on` chain with its effective depth. */
export type EffectiveDepRow = { id: string; depth: number };

/**
 * Walk forward `depends_on` edges from `taskId`, treating cancelled tasks
 * as transparent: a chain `A → B(cancelled) → C(active)` returns C at
 * effective depth 1. Cancelled middles do not consume a depth slot.
 *
 * Recursive CTE bounded by `effective_depth < maxDepth` on the active
 * wall. The `CYCLE` clause terminates recursion on cycles, including
 * cancelled-only loops. Joins `tasks` at every step and filters on
 * `projectId` so a stale or hand-crafted cross-project edge cannot leak
 * into the result. The source task is excluded from the result.
 *
 * @param conn - Drizzle client or transaction handle.
 * @param taskId - UUID of the starting task (excluded from the result).
 * @param projectId - UUID of the project the starting task belongs to.
 * @param maxDepth - Maximum effective hops to include.
 * @returns Distinct active task ids reachable from `taskId` within
 *   `maxDepth` effective hops, ordered by minimum effective depth ascending.
 */
export async function fetchEffectiveDepChain(
  conn: Conn,
  taskId: string,
  projectId: string,
  maxDepth: number,
): Promise<EffectiveDepRow[]> {
  const rows = await executeRaw<{ id: string; depth: number | string }>(
    conn,
    sql`
      WITH RECURSIVE walk AS (
        SELECT
          e.target_task_id AS id,
          t.status AS status,
          CASE WHEN t.status = 'cancelled' THEN 0 ELSE 1 END AS effective_depth
        FROM ${taskEdges} e
        INNER JOIN ${tasks} t ON t.id = e.target_task_id
        WHERE e.source_task_id = ${taskId}
          AND e.edge_type = 'depends_on'
          AND t.project_id = ${projectId}

        UNION ALL

        SELECT
          e.target_task_id,
          t.status,
          w.effective_depth + CASE WHEN t.status = 'cancelled' THEN 0 ELSE 1 END
        FROM ${taskEdges} e
        INNER JOIN walk w ON e.source_task_id = w.id
        INNER JOIN ${tasks} t ON t.id = e.target_task_id
        WHERE e.edge_type = 'depends_on'
          AND t.project_id = ${projectId}
          AND w.effective_depth < ${maxDepth}
      ) CYCLE id SET is_cycle USING path
      SELECT id, MIN(effective_depth) AS depth
      FROM walk
      WHERE NOT is_cycle
        AND status <> 'cancelled'
        AND effective_depth <= ${maxDepth}
        AND id <> ${taskId}
      GROUP BY id
      ORDER BY depth ASC
    `,
  );
  return rows.map((r) => ({ id: r.id, depth: Number(r.depth) }));
}
