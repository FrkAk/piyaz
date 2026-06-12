import "server-only";

import { sql } from "drizzle-orm";
import { requestDbStore } from "./request-store";
import type { ReadConn } from "@/lib/db/raw";
import {
  assertReadOnlyStatements,
  type ReadResults,
  type ReadStatements,
} from "./read-guard";

/**
 * Workers backend for `withUserContextRead`: one neon-http static batch
 * transaction (`READ ONLY` / `ReadCommitted`, baked into the client by
 * `buildAppHttp`) with `set_config('app.user_id', $1, true)` prepended, so
 * the GUC and the reads share a single stateless HTTP round-trip — no
 * WebSocket, no session to leak across requests. The `set_config` slot is
 * dropped from the returned results so both deploy targets share one
 * positional contract.
 *
 * Callers must come through `withUserContextRead` (`lib/db/rls.ts`), which
 * owns the userId validation.
 *
 * @param userId - Validated user id for the `app.user_id` GUC.
 * @param build - Pure statement-construction callback; must not await.
 * @returns Results positionally aligned with the build statements.
 * @throws Error when no `withRequestDb` frame is active (unscoped access).
 * @throws {ReadOnlyViolationError} When a statement is not a plain read.
 */
export async function runUserContextRead<T extends ReadStatements>(
  userId: string,
  build: (db: ReadConn) => T,
): Promise<ReadResults<T>> {
  const httpDb = requestDbStore.getStore()?.appDbRead;
  if (!httpDb) {
    throw new Error(
      "withUserContextRead requires an active withRequestDb frame on Workers " +
        "(lib/db/request-scope.workers.ts). Wrap the entry point in withRequestDb.",
    );
  }
  const statements = build(httpDb as unknown as ReadConn);
  assertReadOnlyStatements(statements);
  const batch = [
    httpDb.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`),
    ...statements,
  ] as unknown as Parameters<typeof httpDb.batch>[0];
  const results = await httpDb.batch(batch);
  return results.slice(1) as ReadResults<T>;
}
