/**
 * Notes tree-list cache validator: latest `updated_at` plus the live-row
 * count for one project's notes. The count is part of the validator
 * because a soft delete removes a row without raising any surviving
 * `updated_at` — MAX alone would leave the tree ETag stale after a
 * delete. Served by the partial `notes_project_updated_idx`
 * (`WHERE deleted_at IS NULL`).
 */

import { sql } from "drizzle-orm";
import { notes } from "@/lib/db/schema";
import { type ReadConn } from "@/lib/db/raw";

/** Row shape returned by the notes tree-version query. */
export type NotesTreeVersionRow = {
  max_updated_at: string | Date | null;
  live_count: number | string;
};

/**
 * The notes tree-version read as a lazy batch statement.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project.
 * @returns Lazy raw statement yielding one {@link NotesTreeVersionRow}.
 */
export function notesTreeVersionStmt(read: ReadConn, projectId: string) {
  return read.execute(sql`
    SELECT MAX(updated_at) AS max_updated_at, COUNT(*) AS live_count
    FROM ${notes}
    WHERE project_id = ${projectId} AND deleted_at IS NULL
  `);
}
