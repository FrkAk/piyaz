import { sql } from "drizzle-orm";
import { executeRaw, type Conn } from "@/lib/db/raw";

/**
 * Raw row shape returned by {@link fetchTaskChildren}: both child relations
 * folded into JSON-aggregated arrays in one round-trip.
 */
export type TaskChildrenRow = {
  acceptance_criteria:
    | { id: string; text: string; checked: boolean }[]
    | null;
  decisions:
    | { id: string; text: string; source: string; date: string }[]
    | null;
};

/**
 * Fetch a task's criteria and decisions in a single round-trip via two
 * `json_agg` subqueries. Sibling of {@link fetchTaskFull}; used by the
 * `updateTask` post-write hot path to surface the freshest child state to
 * callers without paying two separate sequential reads.
 *
 * UNCHECKED: this helper performs NO authorization. Callers must assert
 * task access first.
 *
 * @param conn - Drizzle client or transaction handle.
 * @param taskId - UUID of the task.
 * @returns Exactly one row with both arrays (each possibly null when empty).
 */
export async function fetchTaskChildren(
  conn: Conn,
  taskId: string,
): Promise<TaskChildrenRow> {
  const rows = await executeRaw<TaskChildrenRow>(
    conn,
    sql`
      SELECT
        (SELECT json_agg(json_build_object('id', c.id, 'text', c.text, 'checked', c.checked) ORDER BY c.position, c.id)
         FROM task_acceptance_criteria c
         WHERE c.task_id = ${taskId}::uuid) AS acceptance_criteria,
        (SELECT json_agg(json_build_object('id', d.id, 'text', d.text, 'source', d.source, 'date', d.decision_date) ORDER BY d.position, d.id)
         FROM task_decisions d
         WHERE d.task_id = ${taskId}::uuid) AS decisions
    `,
  );
  return rows[0] ?? { acceptance_criteria: null, decisions: null };
}
