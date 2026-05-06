import { sql } from "drizzle-orm";
import { tasks } from "@/lib/db/schema";
import { executeRaw, type Conn } from "@/lib/db/raw";

/** Distinct tag with usage count for a single project. */
export type ProjectTagRow = { tag: string; count: number };

/**
 * Aggregate distinct task tags for a project with their usage counts,
 * sorted by count desc and tag asc. Uses `LATERAL jsonb_array_elements_text`
 * because the type-safe builder cannot express jsonb-element unfolding.
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
    sql`
      SELECT tag, COUNT(*)::int AS count
      FROM ${tasks}, LATERAL jsonb_array_elements_text(${tasks.tags}) AS tag
      WHERE ${tasks.projectId} = ${projectId}
      GROUP BY tag
      ORDER BY count DESC, tag ASC
    `,
  );
  return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
}
