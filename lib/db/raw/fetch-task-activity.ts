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
 * Hard cap on the `summary` text egressed per row. The feed renders one
 * CSS-truncated line, so shipping the full free-form body (a criterion /
 * decision paragraph or a long title embedded in the summary) is wasted
 * bandwidth. Mirrors the `substring(... for 101)` projection cap on the
 * overview path. Comfortably past any edge-direction marker, so it never
 * truncates a marker the legacy `edgePhrase` fallback parses.
 */
const SUMMARY_MAX_CHARS = 160;

/**
 * Build the keyset page SQL for a task's activity. Pages newest-first and
 * hydrates display identity inline via the `activity_actors_visible` /
 * `oauth_client_name` SECURITY DEFINER functions — the same idiom as the
 * task+assignees read, no `service_role`. A non-member sees an empty page
 * because the `activity_events` RLS policy hides the rows.
 *
 * The page is materialized in a CTE first, then `oauth_client_name` is
 * resolved once per *distinct* client id on the page (a STABLE function is
 * not memoized across rows, so calling it inline per row re-ran the
 * membership probe for every duplicate harness). `summary` is capped to
 * {@link SUMMARY_MAX_CHARS} so only the rendered prefix is egressed.
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
    WITH page AS (
      SELECT
        ae.id, ae.project_id, ae.task_id, ae.type, ae.created_at,
        to_char(ae.created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
        ae.actor_user_id, ae.source, ae.actor_client_id,
        substring(ae.summary FROM 1 FOR ${SUMMARY_MAX_CHARS}) AS summary,
        ae.target_ref, ae.metadata
      FROM public.activity_events ae
      WHERE ae.task_id = ${taskId}::uuid
      ${keyset}
      ORDER BY ae.created_at DESC, ae.id DESC
      LIMIT ${limit}
    ),
    client_names AS (
      SELECT
        c.client_id,
        COALESCE(public.oauth_client_name(c.client_id), c.client_id) AS name
      FROM (
        SELECT DISTINCT actor_client_id AS client_id
        FROM page
        WHERE actor_client_id IS NOT NULL
      ) c
    )
    SELECT
      page.id, page.project_id, page.task_id, page.type, page.created_at,
      page.created_at_cursor, page.actor_user_id, page.source,
      page.actor_client_id, page.summary, page.target_ref, page.metadata,
      a.name AS actor_name,
      a.image AS actor_image,
      cn.name AS agent_name
    FROM page
    LEFT JOIN public.activity_actors_visible(${taskId}::uuid) a
      ON a.user_id = page.actor_user_id
    LEFT JOIN client_names cn ON cn.client_id = page.actor_client_id
    ORDER BY page.created_at DESC, page.id DESC`;
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
