import { sql, type SQL } from "drizzle-orm";
import { tasks } from "@/lib/db/schema";
import { executeRaw, type Conn, type ReadConn } from "@/lib/db/raw";

/** Distinct tag with usage count for a single project. */
export type ProjectTagRow = { tag: string; count: number };

/**
 * Ceiling on the tag vocabulary a single read returns.
 *
 * The set is caller-grown: tags arrive on task writes with no project-wide
 * cap, and every consumer walks the whole result. Ordering puts the
 * most-used tags first, so the rows past this point are the long tail a
 * caller can inflate at will rather than the vocabulary anyone works with.
 *
 * Consumers render this as the project's tag vocabulary, so hitting the cap has
 * to be visible: an agent silently shown a partial list will coin a tag that
 * already exists. `lib/graph/format-responses.ts` marks the rendered line when
 * the row count reaches this value.
 */
export const MAX_PROJECT_TAGS = 500;

/**
 * Build the tag-aggregation SQL shared by the interactive and batch read
 * paths. Uses `LATERAL jsonb_array_elements_text` because the type-safe
 * builder cannot express jsonb-element unfolding.
 *
 * @param projectId - UUID of the project.
 * @returns Parameterized SQL fragment.
 */
function projectTagsSql(projectId: string): SQL {
  return sql`
      SELECT tag, COUNT(*)::int AS count
      FROM ${tasks}, LATERAL jsonb_array_elements_text(${tasks.tags}) AS tag
      WHERE ${tasks.projectId} = ${projectId}
      GROUP BY tag
      ORDER BY count DESC, tag ASC
      LIMIT ${MAX_PROJECT_TAGS}
    `;
}

/**
 * Coerce raw tag-aggregation rows to {@link ProjectTagRow}s with numeric
 * counts.
 *
 * @param rows - Raw rows from the aggregation query.
 * @returns Tag rows with JS-number counts.
 */
export function mapProjectTagRows(
  rows: readonly { tag: string; count: number | string }[],
): ProjectTagRow[] {
  return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
}

/**
 * Aggregate distinct task tags for a project with their usage counts,
 * sorted by count desc and tag asc.
 *
 * @param conn - Drizzle client or transaction handle.
 * @param projectId - UUID of the project.
 * @returns Tag rows; counts are coerced to JS numbers.
 */
export async function aggregateProjectTags(
  conn: Conn,
  projectId: string,
): Promise<ProjectTagRow[]> {
  const rows = await executeRaw<{ tag: string; count: number | string }>(
    conn,
    projectTagsSql(projectId),
  );
  return mapProjectTagRows(rows);
}

/**
 * {@link aggregateProjectTags} as a lazy batch statement. Normalize the
 * batch result with
 * `normalizeExecuteResult<{ tag: string; count: number | string }>` and map
 * with {@link mapProjectTagRows}.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project.
 * @returns Lazy raw statement yielding tag-aggregation rows.
 */
export function projectTagsStmt(read: ReadConn, projectId: string) {
  return read.execute(projectTagsSql(projectId));
}
