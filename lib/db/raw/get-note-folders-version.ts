/**
 * Explicit note-folders cache validator: latest `created_at` plus the row
 * count for one project's folder markers. Sound because folder moves
 * rewrite rows as delete-then-insert, so every mutation shifts MAX or
 * COUNT.
 */

import { sql } from "drizzle-orm";
import { noteFolders } from "@/lib/db/schema";
import { type ReadConn } from "@/lib/db/raw";

/** Row shape returned by the note-folders version query. */
export type NoteFoldersVersionRow = {
  max_created_at: string | Date | null;
  live_count: number | string;
};

/**
 * The note-folders version read as a lazy batch statement. Batch alongside
 * `projectAccessGateStmt` and evaluate the gate rows first.
 *
 * @param read - Read statement-building handle.
 * @param projectId - UUID of the project.
 * @returns Lazy raw statement yielding one {@link NoteFoldersVersionRow}.
 */
export function noteFoldersVersionStmt(read: ReadConn, projectId: string) {
  return read.execute(sql`
    SELECT MAX(created_at) AS max_created_at, COUNT(*) AS live_count
    FROM ${noteFolders}
    WHERE project_id = ${projectId}
  `);
}
