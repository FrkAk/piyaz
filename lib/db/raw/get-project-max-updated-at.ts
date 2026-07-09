import { sql } from "drizzle-orm";
import { notes, projects, tasks, taskEdges } from "@/lib/db/schema";
import { executeRaw, type Conn } from "@/lib/db/raw";

/**
 * Resolve the latest `updated_at` across a project's metadata, every task
 * in the project, and every edge whose source OR target is in the project.
 * When `includeNotes` is set the project's notes are folded in too, so a
 * consumer that embeds note content (the context-bundle route) invalidates
 * on a note edit; consumers that render no notes (the graph route) leave it
 * off to avoid needless cache misses.
 *
 * Single round trip via `GREATEST` over correlated subqueries so the
 * conditional-GET path fans out one DB query per request, not several.
 *
 * @param conn - Drizzle client or transaction handle.
 * @param projectId - UUID of the project.
 * @param includeNotes - Fold `notes.updated_at` into the validator.
 * @returns The latest `updated_at`, or `null` when the project does not exist.
 */
export async function getProjectMaxUpdatedAtRaw(
  conn: Conn,
  projectId: string,
  includeNotes = false,
): Promise<Date | null> {
  const notesTerm = includeNotes
    ? sql`,
        COALESCE(
          (SELECT MAX(updated_at) FROM ${notes} WHERE project_id = p.id),
          p.updated_at
        )`
    : sql``;
  const rows = await executeRaw<{ max_updated_at: string | Date }>(
    conn,
    sql`
      SELECT GREATEST(
        p.updated_at,
        COALESCE(
          (SELECT MAX(updated_at) FROM ${tasks} WHERE project_id = p.id),
          p.updated_at
        ),
        COALESCE(
          (SELECT MAX(e.updated_at)
           FROM ${taskEdges} e
           WHERE e.source_task_id IN (SELECT id FROM ${tasks} WHERE project_id = p.id)
              OR e.target_task_id IN (SELECT id FROM ${tasks} WHERE project_id = p.id)),
          p.updated_at
        )${notesTerm}
      ) AS max_updated_at
      FROM ${projects} p
      WHERE p.id = ${projectId}
    `,
  );
  if (rows.length === 0) return null;
  const value = rows[0].max_updated_at;
  return value instanceof Date ? value : new Date(value);
}
