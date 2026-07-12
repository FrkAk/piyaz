import { sql } from "drizzle-orm";
import { type ReadConn } from "@/lib/db/raw";

/**
 * Build the last-editor identity read as a lazy batch statement. Resolves
 * `updated_by` through `activity_actors_for_project_visible` (SECURITY
 * DEFINER, org-scoped), the same identity source the History timeline
 * uses, with the project id taken from the RLS-scoped notes row inline.
 * `is_agent` comes from the updater's latest activity event on the note
 * (`source = 'mcp'`), the same signal the History timeline renders, so
 * agent attribution costs no second statement. Seeks the partial
 * `activity_events_note_id_created_idx`. An invisible note yields zero
 * rows and the caller's gate 404s regardless.
 *
 * @param read - Read statement-building handle.
 * @param noteId - UUID of the note.
 * @returns Lazy raw statement yielding zero or one `{ name, is_agent }`
 *   rows.
 */
export function noteUpdaterNameStmt(read: ReadConn, noteId: string) {
  return read.execute(sql`
    SELECT a.name, COALESCE(e.source = 'mcp', false) AS is_agent
    FROM public.notes n
    LEFT JOIN public.activity_actors_for_project_visible(n.project_id) a
      ON a.user_id = n.updated_by
    LEFT JOIN LATERAL (
      SELECT ev.source
      FROM public.activity_events ev
      WHERE ev.note_id = n.id AND ev.actor_user_id = n.updated_by
      ORDER BY ev.created_at DESC
      LIMIT 1
    ) e ON true
    WHERE n.id = ${noteId}::uuid AND n.deleted_at IS NULL`);
}
