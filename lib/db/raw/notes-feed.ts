/**
 * The §7 agent-exposure query: which notes an agent may see for a task.
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
 * postgres-js and neon-http. `project_id` + `feed_mode <> 'none'` lead
 * the WHERE to match the partial `notes_feed_idx`; the jsonb arms are
 * post-filters over the exposed subset only. Never selects `body` or
 * `search_tsv`.
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
 * The categories arm: matches `feed_mode = 'categories'` notes whose
 * `feed_categories` contains the task's category. Collapses to `false`
 * for a category-less task.
 *
 * @param category - The task's category, or null.
 * @returns SQL boolean fragment.
 */
function categoriesArmSql(category: string | null): SQL {
  if (category === null) return sql`false`;
  return sql`(n.feed_mode = 'categories' AND n.feed_categories @> ${JSON.stringify([category])}::jsonb)`;
}

/**
 * The tags arm: matches `feed_mode = 'tags'` notes whose `feed_tags`
 * overlaps the task's tags. The task tags bind as one jsonb string and
 * unfold server-side into the `text[]` that `?|` requires. Collapses to
 * `false` for an untagged task.
 *
 * @param tags - The task's tags.
 * @returns SQL boolean fragment.
 */
function tagsArmSql(tags: string[]): SQL {
  if (tags.length === 0) return sql`false`;
  return sql`(n.feed_mode = 'tags' AND n.feed_tags ?| ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(tags)}::jsonb)))`;
}

/**
 * Build the §7 exposure query for one task. Exported separately from the
 * statement builder so tests can EXPLAIN the exact query text.
 *
 * @param projectId - UUID of the project whose notes are resolved.
 * @param task - The task the feed targets.
 * @returns SQL yielding {@link NoteFeedRawRow}s, most recently updated
 *   first (ties broken by id ascending).
 */
export function notesFeedSql(projectId: string, task: FeedTask): SQL {
  return sql`
    SELECT n.id, n.slug, n.title, n.type, n.folder, n.summary, n.updated_at
    FROM ${notes} n
    WHERE n.project_id = ${projectId}
      AND n.feed_mode <> 'none'
      AND n.deleted_at IS NULL
      AND n.visibility = 'team'
      AND (
        n.feed_mode = 'all'
        OR ${categoriesArmSql(task.category)}
        OR ${tagsArmSql(task.tags)}
        OR (n.feed_mode = 'tasks' AND n.feed_task_ids @> ${JSON.stringify([task.id])}::jsonb)
      )
    ORDER BY n.updated_at DESC, n.id ASC
  `;
}

/**
 * The feed-exposure query as a lazy batch statement. Batch alongside
 * `projectAccessGateStmt` and evaluate the gate rows first.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project whose notes are resolved.
 * @param task - The task the feed targets.
 * @returns Lazy raw statement yielding {@link NoteFeedRawRow}s.
 */
export function notesFeedStmt(
  read: ReadConn,
  projectId: string,
  task: FeedTask,
) {
  return read.execute(notesFeedSql(projectId, task));
}
