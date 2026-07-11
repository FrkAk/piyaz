import { sql } from "drizzle-orm";
import { type ReadConn } from "@/lib/db/raw";

/**
 * Build the last-editor identity read as a lazy batch statement. Resolves
 * `updated_by` through `activity_actors_for_project_visible` (SECURITY
 * DEFINER, org-scoped), the same identity source the History timeline
 * uses, with the project id taken from the RLS-scoped notes row inline.
 * An invisible note yields zero rows and the caller's gate 404s
 * regardless.
 *
 * @param read - Read statement-building handle.
 * @param noteId - UUID of the note.
 * @returns Lazy raw statement yielding zero or one `{ name }` rows.
 */
export function noteUpdaterNameStmt(read: ReadConn, noteId: string) {
  return read.execute(sql`
    SELECT a.name
    FROM public.notes n
    LEFT JOIN public.activity_actors_for_project_visible(n.project_id) a
      ON a.user_id = n.updated_by
    WHERE n.id = ${noteId}::uuid AND n.deleted_at IS NULL`);
}
