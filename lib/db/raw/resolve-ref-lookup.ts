/**
 * Raw lookup statements for ref resolution (`lib/data/resolve-ref.ts`):
 * org-bounded taskRef and project-identifier matches plus the near-miss
 * probe. Kept in `lib/db/raw/` per the raw-statement convention so the
 * read-path `.execute()` calls stay in one audited module.
 */

import { sql, type SQL } from "drizzle-orm";
import { notes, projects, tasks } from "@/lib/db/schema";
import { type ReadConn } from "@/lib/db/raw";

/** Row shape returned by the task-ref lookup query. */
export type TaskRefRow = {
  task_id: string;
  project_id: string;
  identifier: string;
  sequence_number: number;
  project_title: string;
  organization_id: string;
  team_name: string;
};

/** Row shape returned by the project-ref lookup query. */
export type ProjectRefRow = {
  project_id: string;
  identifier: string;
  organization_id: string;
  project_title: string;
  team_name: string;
};

/** Row shape returned by the near-miss probe query, one per visible project. */
export type NearMissRow = {
  identifier: string;
  team_name: string;
  max_sequence_number: number | null;
};

/** A parsed task-ref group: one project prefix and the sequence numbers under it. */
export type TaskRefGroup = { prefix: string; seqs: number[] };

/**
 * Build the org-bounded task-ref lookup SQL. Joins `tasks` and `projects`
 * to `current_user_orgs()` so the read is bounded by the caller's team
 * memberships (defense-in-depth over RLS) and yields the team name for
 * candidate rendering.
 *
 * @param groups - Non-empty prefix groups to match, OR-joined.
 * @returns Parameterized read statement SQL.
 */
function taskRefLookupSql(groups: TaskRefGroup[]): SQL {
  const clauses = groups.map(
    (g) =>
      sql`(${projects.identifier} = ${g.prefix} AND ${tasks.sequenceNumber} IN (${sql.join(
        g.seqs.map((s) => sql`${s}`),
        sql`, `,
      )}))`,
  );
  return sql`
    SELECT
      ${tasks.id} AS task_id,
      ${tasks.projectId} AS project_id,
      ${projects.identifier} AS identifier,
      ${tasks.sequenceNumber} AS sequence_number,
      ${projects.title} AS project_title,
      ${projects.organizationId} AS organization_id,
      cuo.name AS team_name
    FROM ${tasks}
    JOIN ${projects} ON ${projects.id} = ${tasks.projectId}
    JOIN public.current_user_orgs() AS cuo ON cuo.org_id = ${projects.organizationId}
    WHERE ${sql.join(clauses, sql` OR `)}
  `;
}

/**
 * The org-bounded task-ref lookup as a lazy batch statement. An empty
 * group list yields a zero-row statement so the caller can batch it
 * unconditionally.
 *
 * @param read - Read statement-building handle.
 * @param groups - Prefix groups to match.
 * @returns Lazy raw statement yielding {@link TaskRefRow}s.
 */
export function taskRefLookupStmt(read: ReadConn, groups: TaskRefGroup[]) {
  return read.execute(
    groups.length === 0
      ? sql`SELECT NULL WHERE FALSE`
      : taskRefLookupSql(groups),
  );
}

/**
 * The near-miss probe as a lazy batch statement: does the prefix resolve to
 * a project the caller can see, and what is each such project's highest
 * task sequence number. Grouped per project (not per identifier) so two
 * teams sharing an identifier yield one row each instead of a blended MAX.
 *
 * @param read - Read statement-building handle.
 * @param prefix - Uppercase project identifier.
 * @returns Lazy raw statement yielding zero or more {@link NearMissRow}s.
 */
export function taskRefNearMissStmt(read: ReadConn, prefix: string) {
  return read.execute(sql`
    SELECT
      ${projects.identifier} AS identifier,
      cuo.name AS team_name,
      MAX(${tasks.sequenceNumber}) AS max_sequence_number
    FROM ${projects}
    JOIN public.current_user_orgs() AS cuo ON cuo.org_id = ${projects.organizationId}
    LEFT JOIN ${tasks} ON ${tasks.projectId} = ${projects.id}
    WHERE ${projects.identifier} = ${prefix}
    GROUP BY ${projects.id}, ${projects.identifier}, cuo.name
  `);
}

/** Row shape returned by the note-ref lookup query. */
export type NoteRefRow = {
  note_id: string;
  project_id: string;
  identifier: string;
  sequence_number: number;
  project_title: string;
  organization_id: string;
  team_name: string;
};

/**
 * The org-bounded note-ref lookup as a lazy batch statement. Live notes
 * only: a trashed note's ref does not resolve (restore addresses the note
 * by UUID from the delete response). RLS additionally hides other
 * members' private notes, so their refs 404-shape for everyone else.
 *
 * @param read - Read statement-building handle.
 * @param prefix - Uppercase project identifier.
 * @param seq - Per-project note sequence number.
 * @returns Lazy raw statement yielding {@link NoteRefRow}s.
 */
export function noteRefLookupStmt(read: ReadConn, prefix: string, seq: number) {
  return read.execute(sql`
    SELECT
      ${notes.id} AS note_id,
      ${notes.projectId} AS project_id,
      ${projects.identifier} AS identifier,
      ${notes.sequenceNumber} AS sequence_number,
      ${projects.title} AS project_title,
      ${projects.organizationId} AS organization_id,
      cuo.name AS team_name
    FROM ${notes}
    JOIN ${projects} ON ${projects.id} = ${notes.projectId}
    JOIN public.current_user_orgs() AS cuo ON cuo.org_id = ${projects.organizationId}
    WHERE ${projects.identifier} = ${prefix}
      AND ${notes.sequenceNumber} = ${seq}
      AND ${notes.deletedAt} IS NULL
  `);
}

/**
 * The note near-miss probe as a lazy batch statement: does the prefix
 * resolve to a visible project, and what is each such project's highest
 * live note sequence number. Grouped per project so two teams sharing an
 * identifier yield one row each.
 *
 * @param read - Read statement-building handle.
 * @param prefix - Uppercase project identifier.
 * @returns Lazy raw statement yielding zero or more {@link NearMissRow}s.
 */
export function noteRefNearMissStmt(read: ReadConn, prefix: string) {
  return read.execute(sql`
    SELECT
      ${projects.identifier} AS identifier,
      cuo.name AS team_name,
      MAX(${notes.sequenceNumber}) AS max_sequence_number
    FROM ${projects}
    JOIN public.current_user_orgs() AS cuo ON cuo.org_id = ${projects.organizationId}
    LEFT JOIN ${notes} ON ${notes.projectId} = ${projects.id} AND ${notes.deletedAt} IS NULL
    WHERE ${projects.identifier} = ${prefix}
    GROUP BY ${projects.id}, ${projects.identifier}, cuo.name
  `);
}

/**
 * The project-scoped note-slug lookup as a lazy batch statement. Live
 * notes only; the partial unique index guarantees at most one row.
 *
 * @param read - Read statement-building handle.
 * @param projectId - Owning project UUID.
 * @param slug - Note slug within the project.
 * @returns Lazy raw statement yielding zero or one {@link NoteRefRow}s.
 */
export function noteSlugLookupStmt(
  read: ReadConn,
  projectId: string,
  slug: string,
) {
  return read.execute(sql`
    SELECT
      ${notes.id} AS note_id,
      ${notes.projectId} AS project_id,
      ${projects.identifier} AS identifier,
      ${notes.sequenceNumber} AS sequence_number,
      ${projects.title} AS project_title,
      ${projects.organizationId} AS organization_id,
      cuo.name AS team_name
    FROM ${notes}
    JOIN ${projects} ON ${projects.id} = ${notes.projectId}
    JOIN public.current_user_orgs() AS cuo ON cuo.org_id = ${projects.organizationId}
    WHERE ${notes.projectId} = ${projectId}
      AND ${notes.slug} = ${slug}
      AND ${notes.deletedAt} IS NULL
  `);
}

/**
 * The org-bounded project-ref lookup as a lazy batch statement.
 *
 * @param read - Read statement-building handle.
 * @param identifier - Uppercase project identifier.
 * @returns Lazy raw statement yielding {@link ProjectRefRow}s.
 */
export function projectRefLookupStmt(read: ReadConn, identifier: string) {
  return read.execute(sql`
    SELECT
      ${projects.id} AS project_id,
      ${projects.identifier} AS identifier,
      ${projects.organizationId} AS organization_id,
      ${projects.title} AS project_title,
      cuo.name AS team_name
    FROM ${projects}
    JOIN public.current_user_orgs() AS cuo ON cuo.org_id = ${projects.organizationId}
    WHERE ${projects.identifier} = ${identifier}
  `);
}
