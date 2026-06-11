import { sql, type SQL } from "drizzle-orm";
import { tasks, taskEdges } from "@/lib/db/schema";
import { type ReadConn } from "@/lib/db/raw";

/** A task in an effective `depends_on` chain with its effective depth. */
export type EffectiveDepRow = { id: string; depth: number };

/**
 * Build the effective dependency-chain CTE shared by the interactive and
 * batch read paths. `projectScope` is the expression every visited task's
 * `project_id` must equal — a bound project id on the interactive path, a
 * scalar subquery deriving the source task's project on the batch path
 * (Postgres evaluates the uncorrelated subquery once as an InitPlan).
 *
 * @param taskId - UUID of the starting task (excluded from the result).
 * @param projectScope - SQL expression for the project filter.
 * @param maxDepth - Maximum effective hops to include.
 * @returns Parameterized SQL fragment.
 */
function effectiveDepChainSql(
  taskId: string,
  projectScope: SQL,
  maxDepth: number,
): SQL {
  return sql`
      WITH RECURSIVE walk AS (
        SELECT
          e.target_task_id AS id,
          t.status AS status,
          CASE WHEN t.status = 'cancelled' THEN 0 ELSE 1 END AS effective_depth
        FROM ${taskEdges} e
        INNER JOIN ${tasks} t ON t.id = e.target_task_id
        WHERE e.source_task_id = ${taskId}
          AND e.edge_type = 'depends_on'
          AND t.project_id = ${projectScope}

        UNION ALL

        SELECT
          e.target_task_id,
          t.status,
          w.effective_depth + CASE WHEN t.status = 'cancelled' THEN 0 ELSE 1 END
        FROM ${taskEdges} e
        INNER JOIN walk w ON e.source_task_id = w.id
        INNER JOIN ${tasks} t ON t.id = e.target_task_id
        WHERE e.edge_type = 'depends_on'
          AND t.project_id = ${projectScope}
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
    `;
}

/**
 * {@link fetchEffectiveDepChain} as a lazy batch statement. The project
 * filter derives from the source task's own row (the same project id every
 * interactive caller passes), so the statement can ride the first batch
 * before the task row has been read. Normalize the batch result with
 * `normalizeExecuteResult<{ id: string; depth: number | string }>`.
 *
 * @param read - Read statement-building handle.
 * @param taskId - UUID of the starting task (excluded from the result).
 * @param maxDepth - Maximum effective hops to include.
 * @returns Lazy raw statement yielding effective-dependency rows.
 */
export function effectiveDepChainStmt(
  read: ReadConn,
  taskId: string,
  maxDepth: number,
) {
  return read.execute(
    effectiveDepChainSql(
      taskId,
      sql`(SELECT project_id FROM ${tasks} WHERE id = ${taskId})`,
      maxDepth,
    ),
  );
}
