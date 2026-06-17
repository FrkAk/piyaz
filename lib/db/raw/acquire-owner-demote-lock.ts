import { sql } from "drizzle-orm";
import { executeRawDiscard, type Conn } from "@/lib/db/raw";

/**
 * Acquire a transaction-scoped advisory lock that serializes concurrent
 * owner-role demotes within a single team. Two browsers demoting two
 * different owners simultaneously serialize on this lock so the
 * second sees the first's committed effect (one owner left) and the
 * last-owner guard fails closed.
 *
 * Must be called inside a transaction.
 *
 * @param tx - Drizzle transaction handle.
 * @param organizationId - UUID of the team being mutated.
 */
export async function acquireOwnerDemoteLock(
  tx: Conn,
  organizationId: string,
): Promise<void> {
  await executeRawDiscard(
    tx,
    sql`SELECT pg_advisory_xact_lock(
      hashtext(${`piyaz:team-owners:${organizationId}`})
    )`,
  );
}
