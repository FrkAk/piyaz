/**
 * The agent-exposure query, Notes spec (PYZ-264 decisions) §7: which
 * notes an agent may see for a task.
 *
 * A note is exposed iff `visibility = 'team'` AND `feed_mode <> 'none'`
 * AND its feed mode targets the task (`all` matches every task;
 * `categories`/`tags`/`tasks` match against the task's category, tags,
 * and id). The `visibility = 'team'` predicate lives HERE, never
 * delegated to RLS: the `notes_member_access` policy grants a member
 * their own private notes, which must stay invisible to agents.
 *
 * The exposure fence (project scope, `feed_mode <> 'none'`, `deleted_at`,
 * `visibility`) is written once, in {@link notesFeedQuery}. Only the three
 * feed-mode match arms have two value sources: {@link boundFeedSource}
 * binds a task row the caller already holds, and {@link taskFeedSource}
 * reads it in a CTE so a caller holding only a task id needs no prior
 * round trip. The CTE reads `tasks` under RLS, so a task the caller
 * cannot see yields no CTE row and therefore no notes.
 *
 * Raw SQL because the mode arms need jsonb containment (`@>`) and the
 * jsonb-to-`text[]` unfold for `?|`, which the type-safe builder cannot
 * express. Bound parameters bind as plain strings (`JSON.stringify`
 * + server-side `::jsonb` casts) so the fragment behaves identically on
 * postgres-js and neon-http. Task-side match values are canonicalized to
 * trimmed lowercase, the form the write path stores for feed labels and
 * task ids. `project_id` + `feed_mode <> 'none'` lead the WHERE to match
 * the partial `notes_feed_idx`; the jsonb arms are post-filters over the
 * exposed subset only. A bound `LIMIT` caps the fetch, and `summary` is
 * blanked past the admission cap so rows that can only become pointers
 * carry no summary egress. Never selects `search_tsv`; `body` ships only
 * on the bodies variant, char-bounded and restricted to guidance rows
 * within the admission rank, and degrades to a bare `char_length` for
 * callers that need only the budget arithmetic.
 */

import { sql, type SQL } from "drizzle-orm";
import { notes, projects, tasks } from "@/lib/db/schema";
import { type ReadConn } from "@/lib/db/raw";

/** The task shape feed resolution matches against; callers hold the row. */
export type FeedTask = {
  id: string;
  category: string | null;
  tags: string[];
};

/** Row shape returned by the feed-exposure query. */
export type NoteFeedRawRow = {
  id: string;
  slug: string;
  title: string;
  type: string;
  folder: string;
  summary: string;
  sequence_number: number;
  identifier: string;
  body?: string;
  body_length?: number;
  updated_at: string | Date;
};

/**
 * Guidance-body bounds for the bodies variant of the feed query.
 * `rankCap` limits which rows ship a body (guidance rows within the
 * admission rank); `charBound` is the server-side `LEFT` bound, one char
 * past the char budget so an over-budget body arrives over-budget and
 * degrades to a pointer instead of rendering truncated; `budget` caps the
 * cumulative body egress so a row only ships its body while the bodies of
 * the guidance rows before it sum within `budget`. The row that first
 * crosses `budget` still ships (its full length is what marks it
 * over-budget to the decoder), every guidance row after it blanks.
 *
 * `lengthsOnly` ships `char_length(body)` as `body_length` in place of the
 * body text. The budget arithmetic reads only the length, so callers that
 * never render a body (the note-context endpoint, whose payload is links
 * only) admit exactly the same rows while keeping the body text in
 * Postgres instead of paying up to `budget` chars of egress per request.
 */
export type NoteFeedBodyBound = {
  rankCap: number;
  charBound: number;
  budget: number;
  lengthsOnly?: boolean;
};

/**
 * Where the task-side match values come from. The exposure fence is shared;
 * these are the only parts that differ between a caller that already holds
 * the task row and one that holds only its id.
 */
type FeedSource = {
  /** `WITH` clause introducing the task row, or empty when values are bound. */
  cte: SQL;
  /** Join binding notes to the task's project, or empty when bound. */
  join: SQL;
  /** Project scoping predicate. */
  project: SQL;
  /** The three feed-mode match arms. */
  match: SQL;
};

/**
 * Canonicalize a task-side match value to trimmed lowercase, the form
 * the write path stores for feed labels and task ids.
 *
 * @param value - Raw task-side value.
 * @returns Trimmed, lowercased value.
 */
function canonicalMatchValue(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Assemble the three feed-mode match arms into one boolean fragment.
 * `all` needs no task-side value, so it is shared verbatim.
 *
 * @param categories - Boolean fragment for the `categories` arm.
 * @param tags - Boolean fragment for the `tags` arm.
 * @param taskIds - Boolean fragment for the `tasks` arm.
 * @returns SQL boolean fragment matching any armed feed mode.
 */
function feedMatchSql(categories: SQL, tags: SQL, taskIds: SQL): SQL {
  return sql`(
        n.feed_mode = 'all'
        OR (n.feed_mode = 'categories' AND ${categories})
        OR (n.feed_mode = 'tags' AND ${tags})
        OR (n.feed_mode = 'tasks' AND ${taskIds})
      )`;
}

/**
 * Match values bound from a task row the caller already holds. A
 * category-less or untagged task collapses its arm to `false` rather than
 * probing with an empty value, which would match a note that fed on the
 * empty string.
 *
 * @param projectId - UUID of the project whose notes are resolved.
 * @param task - The task the feed targets.
 * @returns Source with no CTE and no join.
 */
function boundFeedSource(projectId: string, task: FeedTask): FeedSource {
  const category =
    task.category === null ? "" : canonicalMatchValue(task.category);
  const tags = task.tags
    .map(canonicalMatchValue)
    .filter((tag) => tag.length > 0);
  return {
    cte: sql``,
    join: sql``,
    project: sql`n.project_id = ${projectId}`,
    match: feedMatchSql(
      category.length === 0
        ? sql`false`
        : sql`n.feed_categories @> ${JSON.stringify([category])}::jsonb`,
      tags.length === 0
        ? sql`false`
        : sql`n.feed_tags ?| ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(tags)}::jsonb))`,
      sql`n.feed_task_ids @> ${JSON.stringify([canonicalMatchValue(task.id)])}::jsonb`,
    ),
  };
}

/**
 * Match values read from the task row in a CTE, for a caller holding only
 * a task id. The CTE selects from `tasks` under RLS, so an inaccessible
 * task yields no row, the join drops every note, and the feed comes back
 * empty. Canonicalization mirrors {@link canonicalMatchValue} in SQL
 * (`lower(btrim(...))` trims ASCII whitespace where JS `trim()` also
 * strips Unicode whitespace; realistic labels resolve identically), and
 * a blank category or tag is filtered rather than probed.
 *
 * @param taskId - UUID of the task the feed targets.
 * @returns Source carrying the task CTE and its project join.
 */
function taskFeedSource(taskId: string): FeedSource {
  return {
    cte: sql`WITH t AS (SELECT id, project_id, category, tags FROM ${tasks} WHERE id = ${taskId}::uuid)`,
    join: sql`JOIN t ON t.project_id = n.project_id`,
    project: sql`true`,
    match: feedMatchSql(
      sql`btrim(coalesce(t.category, '')) <> '' AND n.feed_categories @> jsonb_build_array(lower(btrim(t.category)))`,
      sql`n.feed_tags ?| ARRAY(SELECT lower(btrim(tag)) FROM jsonb_array_elements_text(t.tags) AS tag WHERE btrim(tag) <> '')`,
      sql`n.feed_task_ids @> jsonb_build_array(lower(t.id::text))`,
    ),
  };
}

/**
 * The guidance-body column: the body text, or its char count on the
 * `lengthsOnly` variant. Both are gated by the same admission-rank and
 * cumulative-budget window, so the two variants admit identical rows.
 *
 * @param bodies - Body bounds, or undefined to select no body at all.
 * @returns Trailing select-list fragment, empty when no body ships.
 */
function bodyColumnSql(bodies?: NoteFeedBodyBound): SQL {
  if (!bodies) return sql``;
  const bounded = sql`LEFT(n.body, ${bodies.charBound})`;
  const shipped = bodies.lengthsOnly ? sql`char_length(${bounded})` : bounded;
  const blank = bodies.lengthsOnly ? sql`0` : sql`''`;
  const alias = bodies.lengthsOnly ? sql`body_length` : sql`body`;
  return sql`
      CASE
        WHEN n.type = 'guidance'
          AND row_number() OVER (ORDER BY n.updated_at DESC, n.id ASC) <= ${bodies.rankCap}
          AND COALESCE(
            SUM(CASE WHEN n.type = 'guidance' THEN char_length(LEFT(n.body, ${bodies.charBound})) ELSE 0 END)
              OVER (ORDER BY n.updated_at DESC, n.id ASC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
            0
          ) <= ${bodies.budget}
        THEN ${shipped} ELSE ${blank}
      END AS ${alias},`;
}

/**
 * Build the §7 exposure query over a {@link FeedSource}. Rows past
 * `summaryCap` in exposure order can only degrade to pointers, so their
 * `summary` is blanked server-side to keep egress at the admitted set.
 *
 * @param src - Where the task-side match values come from.
 * @param summaryCap - Rows past this rank return an empty `summary`.
 * @param limit - Row bound; callers pass note cap + pointer cap + 1.
 * @param bodies - Guidance-body bounds; omit to select no body.
 * @returns SQL yielding {@link NoteFeedRawRow}s, most recently updated
 *   first (ties broken by id ascending).
 */
function notesFeedQuery(
  src: FeedSource,
  summaryCap: number,
  limit: number,
  bodies?: NoteFeedBodyBound,
): SQL {
  return sql`
    ${src.cte}
    SELECT n.id, n.slug, n.title, n.type, n.folder, n.sequence_number, p.identifier,
      CASE
        WHEN row_number() OVER (ORDER BY n.updated_at DESC, n.id ASC) <= ${summaryCap}
        THEN n.summary ELSE ''
      END AS summary,${bodyColumnSql(bodies)}
      n.updated_at
    FROM ${notes} n
    JOIN ${projects} p ON p.id = n.project_id
    ${src.join}
    WHERE ${src.project}
      AND n.feed_mode <> 'none'
      AND n.deleted_at IS NULL
      AND n.visibility = 'team'
      AND ${src.match}
    ORDER BY n.updated_at DESC, n.id ASC
    LIMIT ${limit}
  `;
}

/**
 * The §7 exposure query for a task row the caller already holds. Exported
 * separately from the statement builder so tests can EXPLAIN the exact
 * query text.
 *
 * @param projectId - UUID of the project whose notes are resolved.
 * @param task - The task the feed targets.
 * @param summaryCap - Rows past this rank return an empty `summary`;
 *   callers pass the effective note cap.
 * @param limit - Row bound; callers pass note cap + pointer cap + 1
 *   (the sentinel row that disambiguates truncation).
 * @param bodies - Guidance-body bounds; omit to select no body.
 * @returns SQL yielding {@link NoteFeedRawRow}s.
 */
export function notesFeedSql(
  projectId: string,
  task: FeedTask,
  summaryCap: number,
  limit: number,
  bodies?: NoteFeedBodyBound,
): SQL {
  return notesFeedQuery(
    boundFeedSource(projectId, task),
    summaryCap,
    limit,
    bodies,
  );
}

/**
 * The §7 exposure query for a caller holding only a task id: the task row
 * is read in a CTE under RLS, so the feed resolves in the same round trip
 * as the caller's other reads instead of waiting on a task fetch.
 *
 * @param taskId - UUID of the task the feed targets.
 * @param summaryCap - Rows past this rank return an empty `summary`.
 * @param limit - Row bound; callers pass note cap + pointer cap + 1.
 * @param bodies - Guidance-body bounds; omit to select no body.
 * @returns SQL yielding {@link NoteFeedRawRow}s; empty when the task is
 *   not visible to the caller.
 */
export function notesFeedForTaskSql(
  taskId: string,
  summaryCap: number,
  limit: number,
  bodies?: NoteFeedBodyBound,
): SQL {
  return notesFeedQuery(taskFeedSource(taskId), summaryCap, limit, bodies);
}

/**
 * The feed-exposure query as a lazy batch statement. Standalone callers
 * batch it alongside `projectAccessGateStmt` and evaluate the gate rows
 * first; the bundle path folds it into a batch that already asserted
 * task (hence project) access and skips the redundant gate.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project whose notes are resolved.
 * @param task - The task the feed targets.
 * @param summaryCap - Rows past this rank return an empty `summary`.
 * @param limit - Row bound; callers pass note cap + pointer cap + 1.
 * @param bodies - Guidance-body bounds; omit to select no body.
 * @returns Lazy raw statement yielding {@link NoteFeedRawRow}s.
 */
export function notesFeedStmt(
  read: ReadConn,
  projectId: string,
  task: FeedTask,
  summaryCap: number,
  limit: number,
  bodies?: NoteFeedBodyBound,
) {
  return read.execute(notesFeedSql(projectId, task, summaryCap, limit, bodies));
}

/**
 * The CTE feed-exposure query as a lazy batch statement, for callers that
 * resolve the feed from a task id in the same batch as their task read.
 *
 * @param read - Read statement-building handle.
 * @param taskId - UUID of the task the feed targets.
 * @param summaryCap - Rows past this rank return an empty `summary`.
 * @param limit - Row bound; callers pass note cap + pointer cap + 1.
 * @param bodies - Guidance-body bounds; omit to select no body.
 * @returns Lazy raw statement yielding {@link NoteFeedRawRow}s.
 */
export function notesFeedForTaskStmt(
  read: ReadConn,
  taskId: string,
  summaryCap: number,
  limit: number,
  bodies?: NoteFeedBodyBound,
) {
  return read.execute(notesFeedForTaskSql(taskId, summaryCap, limit, bodies));
}
