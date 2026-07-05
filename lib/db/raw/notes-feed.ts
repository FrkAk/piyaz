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
 * Raw SQL because the mode arms need jsonb containment (`@>`) and the
 * jsonb-to-`text[]` unfold for `?|`, which the type-safe builder cannot
 * express. Every parameter binds as a plain string (`JSON.stringify`
 * + server-side `::jsonb` casts) so the fragment behaves identically on
 * postgres-js and neon-http. Task-side match values bind trimmed and
 * lowercased, meeting the canonical form the write path stores for feed
 * labels and task ids. `project_id` + `feed_mode <> 'none'` lead the
 * WHERE to match the partial `notes_feed_idx`; the jsonb arms are
 * post-filters over the exposed subset only. A bound `LIMIT` caps the
 * fetch, and `summary` is blanked past the admission cap so rows that
 * can only become pointers carry no summary egress. Never selects
 * `body` or `search_tsv`.
 */

import { sql, type SQL } from "drizzle-orm";
import { notes } from "@/lib/db/schema";
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
  updated_at: string | Date;
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
 * The categories arm: matches `feed_mode = 'categories'` notes whose
 * `feed_categories` contains the task's category. The category binds
 * trimmed and lowercased to meet the stored canonical form. Collapses
 * to `false` for a category-less task.
 *
 * @param category - The task's category, or null.
 * @returns SQL boolean fragment.
 */
function categoriesArmSql(category: string | null): SQL {
  const canonical = category === null ? "" : canonicalMatchValue(category);
  if (canonical.length === 0) return sql`false`;
  return sql`(n.feed_mode = 'categories' AND n.feed_categories @> ${JSON.stringify([canonical])}::jsonb)`;
}

/**
 * The tags arm: matches `feed_mode = 'tags'` notes whose `feed_tags`
 * overlaps the task's tags. The task tags bind trimmed and lowercased
 * as one jsonb string and unfold server-side into the `text[]` that
 * `?|` requires. Collapses to `false` for an untagged task.
 *
 * @param tags - The task's tags.
 * @returns SQL boolean fragment.
 */
function tagsArmSql(tags: string[]): SQL {
  const canonical = tags
    .map(canonicalMatchValue)
    .filter((tag) => tag.length > 0);
  if (canonical.length === 0) return sql`false`;
  return sql`(n.feed_mode = 'tags' AND n.feed_tags ?| ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(canonical)}::jsonb)))`;
}

/**
 * Build the §7 exposure query for one task. Exported separately from the
 * statement builder so tests can EXPLAIN the exact query text. Rows past
 * `summaryCap` in exposure order can only degrade to pointers, so their
 * `summary` is blanked server-side to keep egress at the admitted set.
 *
 * @param projectId - UUID of the project whose notes are resolved.
 * @param task - The task the feed targets.
 * @param summaryCap - Rows past this rank return an empty `summary`;
 *   callers pass the effective note cap.
 * @param limit - Row bound; callers pass note cap + pointer cap + 1
 *   (the sentinel row that disambiguates truncation).
 * @returns SQL yielding {@link NoteFeedRawRow}s, most recently updated
 *   first (ties broken by id ascending).
 */
export function notesFeedSql(
  projectId: string,
  task: FeedTask,
  summaryCap: number,
  limit: number,
): SQL {
  return sql`
    SELECT n.id, n.slug, n.title, n.type, n.folder,
      CASE
        WHEN row_number() OVER (ORDER BY n.updated_at DESC, n.id ASC) <= ${summaryCap}
        THEN n.summary ELSE ''
      END AS summary,
      n.updated_at
    FROM ${notes} n
    WHERE n.project_id = ${projectId}
      AND n.feed_mode <> 'none'
      AND n.deleted_at IS NULL
      AND n.visibility = 'team'
      AND (
        n.feed_mode = 'all'
        OR ${categoriesArmSql(task.category)}
        OR ${tagsArmSql(task.tags)}
        OR (n.feed_mode = 'tasks' AND n.feed_task_ids @> ${JSON.stringify([canonicalMatchValue(task.id)])}::jsonb)
      )
    ORDER BY n.updated_at DESC, n.id ASC
    LIMIT ${limit}
  `;
}

/**
 * The feed-exposure query as a lazy batch statement. Batch alongside
 * `projectAccessGateStmt` and evaluate the gate rows first.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project whose notes are resolved.
 * @param task - The task the feed targets.
 * @param summaryCap - Rows past this rank return an empty `summary`.
 * @param limit - Row bound; callers pass note cap + pointer cap + 1.
 * @returns Lazy raw statement yielding {@link NoteFeedRawRow}s.
 */
export function notesFeedStmt(
  read: ReadConn,
  projectId: string,
  task: FeedTask,
  summaryCap: number,
  limit: number,
) {
  return read.execute(notesFeedSql(projectId, task, summaryCap, limit));
}
