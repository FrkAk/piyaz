import { sql, type SQL } from "drizzle-orm";
import { type ReadConn } from "@/lib/db/raw";
import type { ActivityCursor } from "@/lib/db/raw/fetch-task-activity";

/**
 * Hard cap on the `summary` text egressed per row. Mirrors the task-activity
 * path so the project feed egresses only the rendered prefix, never a
 * full free-form criterion or decision body embedded in a summary.
 */
const SUMMARY_MAX_CHARS = 160;

/**
 * Build the keyset page SQL for a project's activity. Pages newest-first over
 * `(created_at, id)` and hydrates display identity inline via the
 * `activity_actors_for_project_visible` / `oauth_client_name` SECURITY DEFINER
 * functions — the project-anchored twin of `activityPageSql`, no `service_role`.
 * A non-member sees an empty page because the `activity_events` RLS policy
 * hides the rows.
 *
 * `summary` is capped to {@link SUMMARY_MAX_CHARS}. `oauth_client_name` is
 * resolved once per distinct client id on the page (a STABLE function is not
 * memoized across rows). The optional `since` lower bound is AND'd with the
 * keyset clause.
 *
 * @param projectId - Project whose events to read.
 * @param cur - Decoded keyset cursor, or null for the first page.
 * @param limit - Row cap (already includes the +1 look-ahead).
 * @param since - Inclusive-exclusive lower bound (`created_at > since`), or null.
 * @returns Parameterized read-only SQL.
 */
function projectActivityPageSql(
  projectId: string,
  cur: ActivityCursor | null,
  limit: number,
  since: string | null,
): SQL {
  const keyset = cur
    ? sql`AND (ae.created_at < ${cur.createdAt}::timestamptz
        OR (ae.created_at = ${cur.createdAt}::timestamptz
            AND ae.id < ${cur.id}::uuid))`
    : sql``;
  const sinceClause = since
    ? sql`AND ae.created_at > ${since}::timestamptz`
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
      WHERE ae.project_id = ${projectId}::uuid
      ${sinceClause}
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
    LEFT JOIN public.activity_actors_for_project_visible(${projectId}::uuid) a
      ON a.user_id = page.actor_user_id
    LEFT JOIN client_names cn ON cn.client_id = page.actor_client_id
    ORDER BY page.created_at DESC, page.id DESC`;
}

/**
 * Lazy read statement for one keyset page of a project's activity, for the
 * `withUserContextRead` batch. Project-anchored sibling of `taskActivityStmt`.
 *
 * @param read - RLS-scoped read connection from `withUserContextRead`.
 * @param projectId - Project whose events to read.
 * @param cur - Decoded keyset cursor, or null for the first page.
 * @param limit - Row cap (already includes the +1 look-ahead).
 * @param since - Inclusive-exclusive lower bound (`created_at > since`), or null.
 * @returns Lazy raw-SQL read statement.
 */
export function projectActivityStmt(
  read: ReadConn,
  projectId: string,
  cur: ActivityCursor | null,
  limit: number,
  since: string | null,
) {
  return read.execute(projectActivityPageSql(projectId, cur, limit, since));
}
