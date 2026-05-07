import { sql } from "drizzle-orm";
import { executeRawDiscard, type Conn } from "@/lib/db/raw";

/**
 * Acquire a transaction-scoped advisory lock keyed on a project UUID.
 * Serializes per-project mutations that race on the same `tasks` rows
 * (e.g. `sequenceNumber` allocation in `createTask`).
 *
 * Must be called inside a transaction — the lock releases on commit/rollback.
 *
 * @param tx - Drizzle transaction handle.
 * @param projectId - UUID of the project to lock.
 */
export async function acquireProjectLock(
  tx: Conn,
  projectId: string,
): Promise<void> {
  await executeRawDiscard(
    tx,
    sql`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`,
  );
}
