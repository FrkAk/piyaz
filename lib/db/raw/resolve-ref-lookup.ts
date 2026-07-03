/**
 * Raw lookup statements for ref resolution (`lib/data/resolve-ref.ts`):
 * org-bounded taskRef and project-identifier matches plus the near-miss
 * probe. Kept in `lib/db/raw/` per the raw-statement convention so the
 * read-path `.execute()` calls stay in one audited module.
 */

import { sql, type SQL } from "drizzle-orm";
import { projects, tasks } from "@/lib/db/schema";
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

/** Row shape returned by the near-miss probe query. */
export type NearMissRow = {
  identifier: string;
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
 * a project the caller can see, and what is its highest task sequence
 * number.
 *
 * @param read - Read statement-building handle.
 * @param prefix - Uppercase project identifier.
 * @returns Lazy raw statement yielding zero or one {@link NearMissRow}.
 */
export function taskRefNearMissStmt(read: ReadConn, prefix: string) {
  return read.execute(sql`
    SELECT
      ${projects.identifier} AS identifier,
      MAX(${tasks.sequenceNumber}) AS max_sequence_number
    FROM ${projects}
    JOIN public.current_user_orgs() AS cuo ON cuo.org_id = ${projects.organizationId}
    LEFT JOIN ${tasks} ON ${tasks.projectId} = ${projects.id}
    WHERE ${projects.identifier} = ${prefix}
    GROUP BY ${projects.identifier}
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
