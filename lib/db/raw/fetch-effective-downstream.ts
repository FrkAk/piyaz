import { sql } from "drizzle-orm";
import { tasks, taskEdges } from "@/lib/db/schema";
import { executeRaw, type Conn } from "@/lib/db/raw";

/** A task in an effective downstream-dependents chain with its effective depth. */
export type EffectiveDownstreamRow = { id: string; depth: number };

/**
 * Walk backward `depends_on` edges from `taskId` (find tasks that depend
 * on it), treating cancelled tasks as transparent: a chain
 * `C(active) → B(cancelled) → A` returns A at effective depth 1 from C's
 * perspective.
 *
 * Mirror of {@link fetchEffectiveDepChain} with source/target swapped on
 * the join; bounded by `effective_depth < maxDepth` on the active wall,
 * `CYCLE` clause terminates recursion through cycles (cancelled loops
 * included). Joins `tasks` at every step and filters on `projectId`. The
 * source task is excluded from the result.
 *
 * @param conn - Drizzle client or transaction handle.
 * @param taskId - UUID of the starting task (excluded from the result).
 * @param projectId - UUID of the project the starting task belongs to.
 * @param maxDepth - Maximum effective hops to include.
 * @returns Distinct active task ids that effectively depend on `taskId`
 *   within `maxDepth` effective hops, ordered by minimum effective depth
 *   ascending.
 */
export async function fetchEffectiveDownstream(
  conn: Conn,
  taskId: string,
  projectId: string,
  maxDepth: number,
): Promise<EffectiveDownstreamRow[]> {
  const rows = await executeRaw<{ id: string; depth: number | string }>(
    conn,
    sql`
      WITH RECURSIVE walk AS (
        SELECT
          e.source_task_id AS id,
          t.status AS status,
          CASE WHEN t.status = 'cancelled' THEN 0 ELSE 1 END AS effective_depth
        FROM ${taskEdges} e
        INNER JOIN ${tasks} t ON t.id = e.source_task_id
        WHERE e.target_task_id = ${taskId}
          AND e.edge_type = 'depends_on'
          AND t.project_id = ${projectId}

        UNION ALL

        SELECT
          e.source_task_id,
          t.status,
          w.effective_depth + CASE WHEN t.status = 'cancelled' THEN 0 ELSE 1 END
        FROM ${taskEdges} e
        INNER JOIN walk w ON e.target_task_id = w.id
        INNER JOIN ${tasks} t ON t.id = e.source_task_id
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
