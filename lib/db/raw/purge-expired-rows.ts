import { sql } from "drizzle-orm";
import { executeRaw, type ServiceRoleConn } from "@/lib/db/raw";

/** Rows the nightly sweep may delete per table per run; leftovers roll to the next run. */
export const HOUSEKEEPING_BATCH_LIMIT = 5000;

/** One per-table result row from `public.purge_expired_rows`. */
export interface PurgeResultRow {
  /** Table the row reports on (fixed order, one row per table per run). */
  table_name: string;
  /** Rows deleted (live run) or rows that would be deleted (dry run). */
  row_count: number;
}

/**
 * Run the housekeeping sweep via `public.purge_expired_rows` (SECURITY
 * DEFINER, service_role-only; retention windows live in
 * `docker/rls-functions.sql`). Dry runs count the same victims a live run
 * would delete without mutating anything.
 *
 * @param conn - BYPASSRLS service-role client.
 * @param dryRun - True to count would-be deletions without deleting.
 * @param batchLimit - Per-table row cap for this run (1..50000).
 * @returns One result row per swept table, fixed order.
 */
export async function purgeExpiredRows(
  conn: ServiceRoleConn,
  dryRun: boolean,
  batchLimit: number,
): Promise<PurgeResultRow[]> {
  return executeRaw<PurgeResultRow>(
    conn,
    sql`SELECT table_name, row_count FROM public.purge_expired_rows(${dryRun}, ${batchLimit})`,
  );
}
