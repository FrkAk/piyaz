import { sql } from "drizzle-orm";
import { type ReadConn } from "@/lib/db/raw";
import type { AssigneeRef } from "@/lib/data/views";

/** Raw row shape of the per-project assignee SDF read. */
export type AssigneeByProjectRow = {
  task_id: string;
  user_id: string;
  name: string;
  email: string;
};

/**
 * Every visible task assignee in a project, as a lazy batch statement.
 * Routes through the `task_assignees_for_project_visible` SECURITY DEFINER
 * function so `app_user` can read `piyaz_auth.user` under the Option-B
 * lockdown. Normalize the batch result with
 * `normalizeExecuteResult<AssigneeByProjectRow>` and fold with
 * {@link mapAssigneesByProjectRows}.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project.
 * @returns Lazy raw statement yielding per-task assignee rows.
 */
export function assigneesByProjectStmt(read: ReadConn, projectId: string) {
  return read.execute(
    sql`
      SELECT task_id, user_id, name, email
      FROM public.task_assignees_for_project_visible(${projectId}::uuid)
    `,
  );
}

/**
 * Fold per-project assignee rows into the task-id → assignee-list map the
 * overview assembler consumes.
 *
 * @param rows - Rows from the per-project assignee SDF read.
 * @returns Map of task id to assignee refs.
 */
export function mapAssigneesByProjectRows(
  rows: readonly AssigneeByProjectRow[],
): Map<string, AssigneeRef[]> {
  const result = new Map<string, AssigneeRef[]>();
  for (const r of rows) {
    const list = result.get(r.task_id) ?? [];
    list.push({ userId: r.user_id, name: r.name, email: r.email });
    result.set(r.task_id, list);
  }
  return result;
}
