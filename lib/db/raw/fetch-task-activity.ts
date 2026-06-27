import { sql, type SQL } from "drizzle-orm";
import { type ReadConn } from "@/lib/db/raw";
import type { ActivityEventType, ActivitySource } from "@/lib/types";

/**
 * Opaque keyset cursor decoded to its ordering pair. `createdAt` is the
 * microsecond-precision ISO text emitted by `created_at_cursor` (never a JS
 * `Date`, which floors to milliseconds and would drop same-microsecond rows at
 * a page boundary).
 */
export type ActivityCursor = { createdAt: string; id: string };

/**
 * Raw snake-case row returned by {@link taskActivityStmt}. Read-time display
 * identity (`actor_name`, `actor_image`, `agent_name`) is joined from the
 * `activity_actors_visible` / `oauth_client_name` SECURITY DEFINER functions.
 */
export type ActivityRawRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  type: ActivityEventType;
  created_at: Date | string;
  created_at_cursor: string;
  actor_user_id: string | null;
  source: ActivitySource;
  actor_client_id: string | null;
  summary: string;
  target_ref: string | null;
  metadata: Record<string, unknown> | null;
  actor_name: string | null;
  actor_image: string | null;
  agent_name: string | null;
};

/**
 * Build the keyset page SQL for a task's activity. Pages newest-first and
 * hydrates display identity inline via the `activity_actors_visible` /
 * `oauth_client_name` SECURITY DEFINER functions — the same idiom as the
 * task+assignees read, no `service_role`. A non-member sees an empty page
 * because the `activity_events` RLS policy hides the rows.
 *
 * @param taskId - Task whose events to read.
 * @param cur - Decoded keyset cursor, or null for the first page.
 * @param limit - Row cap (already includes the +1 look-ahead).
 * @returns Parameterized read-only SQL.
 */
function activityPageSql(
  taskId: string,
  cur: ActivityCursor | null,
  limit: number,
): SQL {
  const keyset = cur
    ? sql`AND (ae.created_at < ${cur.createdAt}::timestamptz
        OR (ae.created_at = ${cur.createdAt}::timestamptz
            AND ae.id < ${cur.id}::uuid))`
    : sql``;
  return sql`
    SELECT
      ae.id, ae.project_id, ae.task_id, ae.type, ae.created_at,
      to_char(ae.created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
      ae.actor_user_id, ae.source, ae.actor_client_id,
      ae.summary, ae.target_ref, ae.metadata,
      a.name AS actor_name,
      a.image AS actor_image,
      CASE
        WHEN ae.actor_client_id IS NOT NULL
        THEN COALESCE(
          public.oauth_client_name(ae.actor_client_id),
          ae.actor_client_id
        )
      END AS agent_name
    FROM public.activity_events ae
    LEFT JOIN public.activity_actors_visible(${taskId}::uuid) a
      ON a.user_id = ae.actor_user_id
    WHERE ae.task_id = ${taskId}::uuid
    ${keyset}
    ORDER BY ae.created_at DESC, ae.id DESC
    LIMIT ${limit}`;
}

/**
 * Lazy read statement for one keyset page of a task's activity, for the
 * `withUserContextRead` batch. Mirrors `taskFullStmt`.
 *
 * @param read - RLS-scoped read connection from `withUserContextRead`.
 * @param taskId - Task whose events to read.
 * @param cur - Decoded keyset cursor, or null for the first page.
 * @param limit - Row cap (already includes the +1 look-ahead).
 * @returns Lazy raw-SQL read statement.
 */
export function taskActivityStmt(
  read: ReadConn,
  taskId: string,
  cur: ActivityCursor | null,
  limit: number,
) {
  return read.execute(activityPageSql(taskId, cur, limit));
}
