import { sql, type SQL } from "drizzle-orm";
import { type ReadConn } from "@/lib/db/raw";
import type { ActivityCursor } from "@/lib/db/raw/fetch-task-activity";

/**
 * Hard cap on the `summary` text egressed per row. Mirrors the task- and
 * project-activity paths so the per-note history egresses only the rendered
 * prefix.
 */
const SUMMARY_MAX_CHARS = 160;

/**
 * Build the seek predicate for a decoded keyset cursor, or the empty
 * fragment for the first page.
 *
 * @param cur - Decoded keyset cursor, or null.
 * @returns AND-able SQL fragment over `(ae.created_at, ae.id)`.
 */
function keysetClause(cur: ActivityCursor | null): SQL {
  return cur
    ? sql`AND (ae.created_at < ${cur.createdAt}::timestamptz
        OR (ae.created_at = ${cur.createdAt}::timestamptz
            AND ae.id < ${cur.id}::uuid))`
    : sql``;
}

/**
 * Build the inclusive-exclusive lower bound (`created_at > since`), or the
 * empty fragment.
 *
 * @param since - Normalized ISO lower bound, or null.
 * @returns AND-able SQL fragment.
 */
function sinceLowerBound(since: string | null): SQL {
  return since ? sql`AND ae.created_at > ${since}::timestamptz` : sql``;
}

/**
 * Build the keyset page SQL for one note's activity. Pages newest-first over
 * `(created_at, id)` and hydrates display identity inline via the
 * `activity_actors_for_project_visible` / `oauth_client_name` SECURITY
 * DEFINER functions: the note-anchored sibling of `activityPageSql`, no
 * `service_role`. The project id feeding the identity function resolves from
 * the RLS-scoped `notes` row inline, keeping the read one batch: an
 * invisible note yields NULL (no identity rows), and the caller's gate probe
 * 404-shapes the request regardless.
 *
 * `summary` is capped to {@link SUMMARY_MAX_CHARS}. `oauth_client_name` is
 * resolved once per distinct client id on the page (a STABLE function is not
 * memoized across rows).
 *
 * @param noteId - Note whose events to read.
 * @param cur - Decoded keyset cursor, or null for the first page.
 * @param limit - Row cap (already includes the +1 look-ahead).
 * @param since - Inclusive-exclusive lower bound (`created_at > since`), or null.
 * @returns Parameterized read-only SQL.
 */
function noteActivityPageSql(
  noteId: string,
  cur: ActivityCursor | null,
  limit: number,
  since: string | null,
): SQL {
  const keyset = keysetClause(cur);
  const sinceClause = sinceLowerBound(since);
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
      WHERE ae.note_id = ${noteId}::uuid
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
    LEFT JOIN public.activity_actors_for_project_visible(
      (SELECT project_id FROM public.notes WHERE id = ${noteId}::uuid)) a
      ON a.user_id = page.actor_user_id
    LEFT JOIN client_names cn ON cn.client_id = page.actor_client_id
    ORDER BY page.created_at DESC, page.id DESC`;
}

/**
 * Lazy read statement for one keyset page of a note's activity, for the
 * `withUserContextRead` batch. Note-anchored sibling of `taskActivityStmt`.
 *
 * @param read - RLS-scoped read connection from `withUserContextRead`.
 * @param noteId - Note whose events to read.
 * @param cur - Decoded keyset cursor, or null for the first page.
 * @param limit - Row cap (already includes the +1 look-ahead).
 * @param since - Inclusive-exclusive lower bound (`created_at > since`), or null.
 * @returns Lazy raw-SQL read statement.
 */
export function noteActivityStmt(
  read: ReadConn,
  noteId: string,
  cur: ActivityCursor | null,
  limit: number,
  since: string | null = null,
) {
  return read.execute(noteActivityPageSql(noteId, cur, limit, since));
}

/**
 * Lazy read statement for the newest event key of a note-activity page:
 * `(id, created_at)` of the first row the matching {@link noteActivityStmt}
 * would return. One partial-index head probe, no identity joins: the
 * cheap validator resolve for `HEAD`/`If-None-Match`, so a 304 skips the
 * full page fetch.
 *
 * @param read - RLS-scoped read connection from `withUserContextRead`.
 * @param noteId - Note whose events to probe.
 * @param cur - Decoded keyset cursor, or null for the first page.
 * @param since - Inclusive-exclusive lower bound (`created_at > since`), or null.
 * @returns Lazy raw-SQL read statement yielding zero or one rows.
 */
export function noteActivityHeadStmt(
  read: ReadConn,
  noteId: string,
  cur: ActivityCursor | null,
  since: string | null = null,
) {
  return read.execute(sql`
    SELECT ae.id, ae.created_at
    FROM public.activity_events ae
    WHERE ae.note_id = ${noteId}::uuid
    ${sinceLowerBound(since)}
    ${keysetClause(cur)}
    ORDER BY ae.created_at DESC, ae.id DESC
    LIMIT 1`);
}
