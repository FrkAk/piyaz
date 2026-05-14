import { sql } from "drizzle-orm";
import { executeRaw, type Conn } from "@/lib/db/raw";

/**
 * Raw row shape returned by {@link fetchTaskFull}. Snake-case keys mirror
 * the underlying columns; the caller maps to the camelCase `TaskFull`
 * shape and narrows the `source` union on `decisions`.
 */
export type TaskFullRawRow = {
  id: string;
  project_id: string;
  title: string;
  sequence_number: number;
  description: string;
  status: string;
  order: number;
  category: string | null;
  implementation_plan: string | null;
  execution_record: string | null;
  tags: string[];
  priority: string | null;
  estimate: number | null;
  files: string[];
  history: unknown[];
  created_at: string | Date;
  updated_at: string | Date;
  project_identifier: string;
  assignees: { userId: string; name: string; email: string }[] | null;
  acceptance_criteria:
    | { id: string; text: string; checked: boolean }[]
    | null;
  decisions:
    | { id: string; text: string; source: string; date: string }[]
    | null;
  links:
    | {
        id: string;
        kind: string;
        url: string;
        label: string | null;
        createdAt: string;
      }[]
    | null;
};

/**
 * Fetch the raw projection backing `getTaskFull` in a single round-trip.
 * Joins `tasks` to `projects` and folds `task_assignees`,
 * `task_acceptance_criteria`, `task_decisions`, and `task_links` into
 * JSON-aggregated subqueries.
 *
 * UNCHECKED: this helper performs NO authorization. The caller must
 * assert task access (`assertTaskAccess`) before invoking. Sibling of
 * `fetch-dependency-chain.ts` and `fetch-downstream.ts`.
 *
 * @param conn - Drizzle client or transaction handle.
 * @param taskId - UUID of the task.
 * @returns Zero or one rows; callers handle the missing case.
 */
export async function fetchTaskFull(
  conn: Conn,
  taskId: string,
): Promise<TaskFullRawRow[]> {
  return executeRaw<TaskFullRawRow>(
    conn,
    sql`
      SELECT
        t.*,
        p.identifier AS project_identifier,
        (SELECT json_agg(json_build_object('userId', u.id, 'name', u.name, 'email', u.email) ORDER BY u.name)
         FROM task_assignees ta
         JOIN neon_auth."user" u ON u.id = ta.user_id
         WHERE ta.task_id = t.id) AS assignees,
        (SELECT json_agg(json_build_object('id', c.id, 'text', c.text, 'checked', c.checked) ORDER BY c.position, c.id)
         FROM task_acceptance_criteria c
         WHERE c.task_id = t.id) AS acceptance_criteria,
        (SELECT json_agg(json_build_object('id', d.id, 'text', d.text, 'source', d.source, 'date', d.decision_date) ORDER BY d.position, d.id)
         FROM task_decisions d
         WHERE d.task_id = t.id) AS decisions,
        (SELECT json_agg(json_build_object('id', l.id, 'kind', l.kind, 'url', l.url, 'label', l.label, 'createdAt', l.created_at) ORDER BY l.created_at)
         FROM task_links l
         WHERE l.task_id = t.id) AS links
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.id = ${taskId}
    `,
  );
}
