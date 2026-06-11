import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { executeRawDiscard, type ReadConn, type RlsTx } from "@/lib/db/raw";
import {
  assertReadOnlyStatements,
  type ReadResults,
  type ReadStatements,
} from "./read-guard";

/**
 * Self-host backend for `withUserContextRead`: one postgres-js interactive
 * transaction opened `READ ONLY` / `READ COMMITTED`, with
 * `set_config('app.user_id', $1, true)` run before the statements so both
 * deploy targets share the exact GUC contract. Statements execute
 * sequentially on the transaction's connection and results return in
 * build order.
 *
 * Callers must come through `withUserContextRead` (`lib/db/rls.ts`), which
 * owns the userId validation.
 *
 * @param userId - Validated user id for the `app.user_id` GUC.
 * @param build - Pure statement-construction callback; must not await.
 * @returns Results positionally aligned with the build statements.
 * @throws {ReadOnlyViolationError} When a statement is not a plain read.
 */
export async function runUserContextRead<T extends ReadStatements>(
  userId: string,
  build: (db: ReadConn) => T,
): Promise<ReadResults<T>> {
  return db.transaction(
    async (rawTx) => {
      const statements = build(rawTx as unknown as ReadConn);
      assertReadOnlyStatements(statements);
      await executeRawDiscard(
        rawTx as RlsTx,
        sql`SELECT set_config('app.user_id', ${userId}, true)`,
      );
      const results: unknown[] = [];
      for (const statement of statements) {
        results.push(await statement);
      }
      return results as ReadResults<T>;
    },
    { isolationLevel: "read committed", accessMode: "read only" },
  );
}
