/** Raw clock restoration for imported organization workspace rows. */

import { sql } from "drizzle-orm";
import { notes, projects, taskEdges, tasks } from "@/lib/db/schema";
import { executeRawDiscard, type RlsTx } from "@/lib/db/raw";

/**
 * Workspace tables whose trigger-mutated clocks are restored after import.
 *
 * Coupled to docker/rls-functions.sql: today only the touch_projects_*
 * triggers (on tasks and task_edges inserts) clobber archived clocks, and
 * projects must be restored last because these very UPDATEs re-fire them.
 * A migration that adds a clock-mutating trigger on another imported table
 * must add that table here and in importOrganizationWorkspace.
 */
export type ArchiveClockTable = "taskEdges" | "notes" | "tasks" | "projects";

/** One imported row's archived clock values. */
export type ArchiveClockRow = {
  id: string;
  createdAt: string;
  updatedAt: string;
  metaUpdatedAt: string;
};

/**
 * Restore archived clocks in one bounded update statement.
 *
 * @param tx - Active caller-scoped import transaction.
 * @param table - Supported workspace table to update.
 * @param rows - Fresh row ids paired with archived clock values.
 * @returns Promise that resolves after the clocks are restored.
 */
export async function restoreArchiveClocks(
  tx: RlsTx,
  table: ArchiveClockTable,
  rows: readonly ArchiveClockRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const payload = JSON.stringify(
    rows.map((row) => ({
      id: row.id,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      meta_updated_at: row.metaUpdatedAt,
    })),
  );
  const targetTable = { taskEdges, notes, tasks, projects }[table];

  await executeRawDiscard(
    tx,
    sql`UPDATE ${targetTable} AS target
        SET created_at = source.created_at,
            updated_at = source.updated_at,
            meta_updated_at = source.meta_updated_at
        FROM jsonb_to_recordset(${payload}::jsonb)
          AS source(
            id uuid,
            created_at timestamptz,
            updated_at timestamptz,
            meta_updated_at timestamptz
          )
        WHERE target.id = source.id`,
  );
}
