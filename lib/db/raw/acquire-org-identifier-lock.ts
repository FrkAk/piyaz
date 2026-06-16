import { sql } from "drizzle-orm";
import { executeRawDiscard, type Conn } from "@/lib/db/raw";

/**
 * Acquire a transaction-scoped advisory lock that serializes project
 * identifier allocation (auto-suffix) and rename within a single team.
 * Two teams allocate identifiers in parallel because the lock is
 * per-organization.
 *
 * Must be called inside a transaction.
 *
 * @param tx - Drizzle transaction handle.
 * @param organizationId - UUID of the organization to scope the lock to.
 */
export async function acquireOrgIdentifierLock(
  tx: Conn,
  organizationId: string,
): Promise<void> {
  await executeRawDiscard(
    tx,
    sql`SELECT pg_advisory_xact_lock(
      hashtext(${`piyaz:project-identifier:${organizationId}`})
    )`,
  );
}
