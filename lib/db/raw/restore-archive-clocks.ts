/** Raw clock restoration for imported organization workspace rows. */

import { sql } from "drizzle-orm";
import {
  notes,
  projects,
  taskAcceptanceCriteria,
  taskDecisions,
  taskEdges,
  tasks,
} from "@/lib/db/schema";
import { executeRawDiscard, type RlsTx } from "@/lib/db/raw";

/** Workspace tables whose trigger-mutated clocks are restored after import. */
export type ArchiveClockTable =
  | "taskEdges"
  | "taskAcceptanceCriteria"
  | "taskDecisions"
  | "notes"
  | "tasks"
  | "projects";

/** One imported row's archived clock values. */
export type ArchiveClockRow = {
  id: string;
  createdAt: string;
  updatedAt: string;
  metaUpdatedAt?: string;
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
      meta_updated_at: row.metaUpdatedAt ?? null,
    })),
  );
  const targetTable = {
    taskEdges,
    taskAcceptanceCriteria,
    taskDecisions,
    notes,
    tasks,
    projects,
  }[table];

  if (table === "taskAcceptanceCriteria" || table === "taskDecisions") {
    await executeRawDiscard(
      tx,
      sql`UPDATE ${targetTable} AS target
          SET created_at = source.created_at,
              updated_at = source.updated_at
          FROM jsonb_to_recordset(${payload}::jsonb)
            AS source(id uuid, created_at timestamptz, updated_at timestamptz)
          WHERE target.id = source.id`,
    );
    return;
  }

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
