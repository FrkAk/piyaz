import { sql } from "drizzle-orm";
import { notes, projects, tasks, taskEdges } from "@/lib/db/schema";
import { executeRaw, type Conn } from "@/lib/db/raw";

/** Which clocks the project validator reads: `none` reads content clocks
 *  and ignores notes, `content` also folds the notes content clock, and
 *  `meta` switches every term (project, tasks, edges, notes) to the
 *  metadata clocks so heavy-only writes leave the validator unmoved. */
export type ProjectValidatorMode = "none" | "meta" | "content";

/**
 * Resolve the latest clock across a project's row, every task in the
 * project, and every edge whose source OR target is in the project.
 * `mode` picks the clocks: the graph route uses `meta` (the payload
 * renders only slim metadata, so plan/record/decision/link writes and
 * note body edits must not move its validator), the context-bundle route
 * uses `content` because it embeds bodies, and consumers that render no
 * notes use `none`. Every meta bump also bumps `updated_at`, so `content`
 * strictly dominates `meta`.
 *
 * Single round trip via `GREATEST` over correlated subqueries so the
 * conditional-GET path fans out one DB query per request, not several.
 *
 * @param conn - Drizzle client or transaction handle.
 * @param projectId - UUID of the project.
 * @param mode - Which clocks to fold into the validator.
 * @returns The latest clock, or `null` when the project does not exist.
 */
export async function getProjectMaxUpdatedAtRaw(
  conn: Conn,
  projectId: string,
  mode: ProjectValidatorMode = "none",
): Promise<Date | null> {
  const clock =
    mode === "meta" ? sql.raw("meta_updated_at") : sql.raw("updated_at");
  const notesTerm =
    mode === "none"
      ? sql``
      : sql`,
        COALESCE(
          (SELECT MAX(${clock}) FROM ${notes} WHERE project_id = p.id),
          p.${clock}
        )`;
  const rows = await executeRaw<{ max_updated_at: string | Date }>(
    conn,
    sql`
      SELECT GREATEST(
        p.${clock},
        COALESCE(
          (SELECT MAX(${clock}) FROM ${tasks} WHERE project_id = p.id),
          p.${clock}
        ),
        COALESCE(
          (SELECT MAX(e.${clock})
           FROM ${taskEdges} e
           WHERE e.source_task_id IN (SELECT id FROM ${tasks} WHERE project_id = p.id)
              OR e.target_task_id IN (SELECT id FROM ${tasks} WHERE project_id = p.id)),
          p.${clock}
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
