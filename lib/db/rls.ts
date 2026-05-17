import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { executeRawDiscard, type RlsTx } from "@/lib/db/raw";

/**
 * Drizzle transaction handle scoped to the caller's `app.user_id` GUC.
 * Re-exported from `@/lib/db/raw` so the data ring imports one name; the
 * brand prevents helpers in `lib/data/*` from accepting a bare
 * `db.transaction(...)` handle (forbidden by lint, but the brand makes
 * it a TypeScript error too).
 */
export type Tx = RlsTx;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Thrown when `withUserContext` receives a non-UUID `userId`. Named so the
 * action layer can map it to `invalid_input` instead of the generic
 * `unknown` failure code.
 */
export class InvalidUserIdError extends Error {
  /**
   * @param message - Override the default diagnostic text.
   */
  constructor(message = "withUserContext: userId must be a valid UUID string") {
    super(message);
    this.name = "InvalidUserIdError";
  }
}

/**
 * Run `fn` inside a Drizzle transaction with `app.user_id` set to the supplied
 * user id for the lifetime of the transaction. The GUC clears automatically on
 * commit/rollback so it never leaks across pooled connections (Neon pgBouncer
 * operates in transaction-pooling mode).
 *
 * `set_config(name, value, true)` is used rather than `SET LOCAL app.user_id =
 * $1` because `SET LOCAL`'s value is a literal — `drizzle-orm`'s `sql` tag
 * parameterizes the value, which Postgres rejects for `SET`. The third arg
 * `true` is `is_local`; scope is identical to `SET LOCAL`.
 *
 * @param userId - Authenticated user id (typically `AuthContext.userId`).
 *   Must be a valid RFC 4122 UUID string.
 * @param fn - Async callback that performs the protected work.
 * @returns Whatever `fn` returns.
 * @throws {InvalidUserIdError} When `userId` is not a valid UUID string.
 *   Surfaces misuse loudly instead of silently degrading to default-deny.
 */
export async function withUserContext<T>(
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (typeof userId !== "string" || !UUID_RE.test(userId)) {
    throw new InvalidUserIdError();
  }
  return db.transaction(async (rawTx) => {
    const tx = rawTx as Tx;
    await executeRawDiscard(
      tx,
      sql`SELECT set_config('app.user_id', ${userId}, true)`,
    );
    return fn(tx);
  });
}
