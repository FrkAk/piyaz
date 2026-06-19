import { sql } from "drizzle-orm";
import { projects, tasks, taskEdges } from "@/lib/db/schema";
import { executeRaw, type Conn } from "@/lib/db/raw";

/**
 * Resolve the latest `updated_at` across every project the caller can
 * access, plus every task and edge belonging to those projects. Used as
 * the conditional-GET validator on `GET /api/projects` so the home grid
 * receives a 304 when nothing in the caller's accessible scope has moved.
 *
 * Access scoping is delegated to RLS: `projects`, `tasks`, and `task_edges`
 * all carry `app_user`-bound policies that restrict visible rows to the
 * membership-derived scope (`docker/rls-policies.sql`). The helper must
 * therefore run inside `withUserContext` so `app.user_id` is set.
 *
 * Three independent table aggregates — no `piyaz_auth.member` join
 * (app_user has no grant there). Each `MAX(updated_at)` runs over the
 * RLS-filtered row set, so non-members see zero rows and GREATEST
 * collapses to epoch-0.
 *
 * @param conn - Drizzle client or transaction handle. Must already be
 *   RLS-bound — see {@link getProjectListMaxUpdatedAt}.
 * @returns The latest `updated_at`, or epoch-0 when the caller has no
 *   accessible projects (so a missing-data response still carries a
 *   stable validator the client can revalidate against).
 */
export async function getProjectListMaxUpdatedAtRaw(conn: Conn): Promise<Date> {
  const rows = await executeRaw<{ max_updated_at: string | Date | null }>(
    conn,
    sql`
      SELECT GREATEST(
        COALESCE((SELECT MAX(updated_at) FROM ${projects}), TO_TIMESTAMP(0)),
        COALESCE((SELECT MAX(updated_at) FROM ${tasks}), TO_TIMESTAMP(0)),
        COALESCE((SELECT MAX(updated_at) FROM ${taskEdges}), TO_TIMESTAMP(0))
      ) AS max_updated_at
    `,
  );
  const value = rows[0]?.max_updated_at ?? null;
  if (value === null) return new Date(0);
  return value instanceof Date ? value : new Date(value);
}
