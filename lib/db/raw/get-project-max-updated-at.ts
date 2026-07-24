import { sql } from "drizzle-orm";
import { notes, projects, tasks, taskEdges } from "@/lib/db/schema";
import { executeRaw, type Conn } from "@/lib/db/raw";

/** Which clocks the project validator reads: `none` reads content clocks
 *  and ignores notes, `content` also folds the notes content clock, and
 *  `graph` matches the slim graph payload: content clocks for the
 *  project row and tasks (the payload renders their `updatedAt`), meta
 *  clocks for edges and notes. Note body autosaves leave the validator
 *  unmoved; edge annotation edits move it anyway through the project
 *  term, because the edge touch trigger bumps `projects.updated_at` on
 *  every edge update (a spurious full response, never a stale 304). */
export type ProjectValidatorMode = "none" | "graph" | "content";

/**
 * Resolve the latest clock across a project's row, every task in the
 * project, and every edge whose source OR target is in the project.
 * `mode` picks the clocks: the graph route uses `graph` (the payload
 * renders each task's content clock, so heavy task writes must move the
 * validator, while note body autosaves must not), the context-bundle
 * route uses `content` because it embeds bodies, and consumers that
 * render no notes use `none`. Every edge and note meta bump rides a
 * write that also bumps `updated_at`, so the `content` validator never
 * sleeps through a change `graph` observes.
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
  const slimClock =
    mode === "graph" ? sql.raw("meta_updated_at") : sql.raw("updated_at");
  const notesTerm =
    mode === "none"
      ? sql``
      : sql`,
        COALESCE(
          (SELECT MAX(${slimClock}) FROM ${notes} WHERE project_id = p.id),
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
          (SELECT MAX(e.${slimClock})
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
