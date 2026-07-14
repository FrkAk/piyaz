import { sql } from "drizzle-orm";
import { notes, projects, tasks, taskEdges } from "@/lib/db/schema";
import { executeRaw, type Conn } from "@/lib/db/raw";

/** How a project validator folds notes in: `none` ignores notes, `meta`
 *  reads the graph-visible metadata clock (`notes.meta_updated_at`), and
 *  `content` reads the full content clock (`notes.updated_at`). */
export type ProjectValidatorNotesMode = "none" | "meta" | "content";

/**
 * Resolve the latest `updated_at` across a project's metadata, every task
 * in the project, and every edge whose source OR target is in the project.
 * `notesMode` picks the notes clock: the graph route uses `meta` so note
 * body edits don't move its validator (the payload renders only note
 * metadata and links), the context-bundle route uses `content` because it
 * embeds note bodies, and consumers that render no notes use `none` to
 * avoid needless cache misses. Every meta bump also bumps `updated_at`,
 * so `content` strictly dominates `meta`.
 *
 * Single round trip via `GREATEST` over correlated subqueries so the
 * conditional-GET path fans out one DB query per request, not several.
 *
 * @param conn - Drizzle client or transaction handle.
 * @param projectId - UUID of the project.
 * @param notesMode - Which notes clock to fold into the validator.
 * @returns The latest `updated_at`, or `null` when the project does not exist.
 */
export async function getProjectMaxUpdatedAtRaw(
  conn: Conn,
  projectId: string,
  notesMode: ProjectValidatorNotesMode = "none",
): Promise<Date | null> {
  const notesTerm =
    notesMode === "none"
      ? sql``
      : sql`,
        COALESCE(
          (SELECT MAX(${notesMode === "meta" ? sql.raw("meta_updated_at") : sql.raw("updated_at")}) FROM ${notes} WHERE project_id = p.id),
          p.updated_at
        )`;
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
