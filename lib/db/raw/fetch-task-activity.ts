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
 * Feed-level exposure filter for note-linked events, shared by the task and
 * project page fetchers. `note_id IS NULL` short-circuits task/edge rows;
 * note-event rows require a currently shared note (team-visible with
 * `shared_since` set) and an event inside the current share window
 * (`created_at >= shared_since`), all via one `notes_pkey` EXISTS probe
 * that also fails closed through the notes RLS. A trashed note keeps only
 * its `note_deleted` event in feeds until restored. For MCP actors the
 * probe additionally requires a feed-enabled note (the PYZ-250
 * agent-exposure rule). The author's own private-note events surface only
 * on the per-note read path, never in a feed, so feeds cannot become an
 * existence oracle.
 *
 * @param agentExposed - True for MCP actors: additionally require
 *   `feed_mode <> 'none'`.
 * @returns The AND-able SQL fragment.
 */
export function noteExposureClause(agentExposed: boolean): SQL {
  const feedArm = agentExposed ? sql`AND n.feed_mode <> 'none'` : sql``;
  return sql`AND (ae.note_id IS NULL OR EXISTS (
        SELECT 1 FROM public.notes n
        WHERE n.id = ae.note_id AND n.visibility = 'team'
          AND n.shared_since IS NOT NULL
          AND ae.created_at >= n.shared_since
          AND (n.deleted_at IS NULL OR ae.type = 'note_deleted')
          ${feedArm}))`;
}

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
 * @param since - Inclusive-exclusive lower bound (`created_at > since`), or null.
 * @param agentExposed - Restrict note-linked events to feed-enabled notes
 *   ({@link noteExposureClause}).
 * @returns Parameterized read-only SQL.
 */
function activityPageSql(
  taskId: string,
  cur: ActivityCursor | null,
  limit: number,
  since: string | null,
  agentExposed: boolean,
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
      WHERE ae.task_id = ${taskId}::uuid
      ${noteExposureClause(agentExposed)}
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
 * @param since - Inclusive-exclusive lower bound (`created_at > since`), or null.
 * @param agentExposed - Restrict note-linked events to feed-enabled notes
 *   ({@link noteExposureClause}).
 * @returns Lazy raw-SQL read statement.
 */
/**
 * Lazy read statement for the newest event key of a task-activity page:
 * `(id, created_at)` of the first row the matching {@link taskActivityStmt}
 * would return. One index head probe with the same exposure filters, no
 * identity joins: the cheap validator resolve for `HEAD`/`If-None-Match`,
 * so a 304 skips the full page fetch.
 *
 * @param read - RLS-scoped read connection from `withUserContextRead`.
 * @param taskId - Task whose events to probe.
 * @param cur - Decoded keyset cursor, or null for the first page.
 * @param since - Inclusive-exclusive lower bound (`created_at > since`), or null.
 * @param agentExposed - Restrict note-linked events to feed-enabled notes
 *   ({@link noteExposureClause}).
 * @returns Lazy raw-SQL read statement yielding zero or one rows.
 */
export function taskActivityHeadStmt(
  read: ReadConn,
  taskId: string,
  cur: ActivityCursor | null,
  since: string | null = null,
  agentExposed = false,
) {
  const keyset = cur
    ? sql`AND (ae.created_at < ${cur.createdAt}::timestamptz
        OR (ae.created_at = ${cur.createdAt}::timestamptz
            AND ae.id < ${cur.id}::uuid))`
    : sql``;
  const sinceClause = since
    ? sql`AND ae.created_at > ${since}::timestamptz`
    : sql``;
  return read.execute(sql`
    SELECT ae.id, ae.created_at
    FROM public.activity_events ae
    WHERE ae.task_id = ${taskId}::uuid
    ${sinceClause}
    ${keyset}
    ${noteExposureClause(agentExposed)}
    ORDER BY ae.created_at DESC, ae.id DESC
    LIMIT 1`);
}

export function taskActivityStmt(
  read: ReadConn,
  taskId: string,
  cur: ActivityCursor | null,
  limit: number,
  since: string | null = null,
  agentExposed = false,
) {
  return read.execute(activityPageSql(taskId, cur, limit, since, agentExposed));
}
