import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { executeRawDiscard, type ReadConn, type RlsTx } from "@/lib/db/raw";
import { runUserContextRead } from "@/lib/db/rls-read";
import {
  assertReadOnlyStatements,
  type ReadResults,
  type ReadStatement,
  type ReadStatements,
} from "@/lib/db/read-guard";

export { ReadOnlyViolationError } from "@/lib/db/read-guard";
export type { ReadConn } from "@/lib/db/raw";

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
 * Reject a non-UUID `userId` before any GUC or statement work. Shared by
 * both RLS entry points so the acceptance rule cannot drift between the
 * interactive and batch read paths.
 *
 * @param userId - Candidate user id.
 * @param message - Entry-point-specific diagnostic text.
 * @throws {InvalidUserIdError} When `userId` is not a valid UUID string.
 */
function assertValidUserId(userId: string, message?: string): void {
  if (typeof userId !== "string" || !UUID_RE.test(userId)) {
    throw new InvalidUserIdError(message);
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
  assertValidUserId(userId);
  return db.transaction(async (rawTx) => {
    const tx = rawTx as Tx;
    await executeRawDiscard(
      tx,
      sql`SELECT set_config('app.user_id', ${userId}, true)`,
    );
    return fn(tx);
  });
}

/** Sequential statement executor bound to one read-only snapshot. */
export type SnapshotRead = {
  /** Lazy Drizzle read builder pinned to the snapshot transaction. */
  read: ReadConn;
  /**
   * Validate and execute one lazy read statement.
   *
   * @param statement - Lazy Drizzle select or raw read statement.
   * @returns Driver result for the statement.
   * @throws {ReadOnlyViolationError} When the statement is not a plain read.
   */
  run<TStatement extends ReadStatement<unknown>>(
    statement: TStatement,
  ): Promise<TStatement["_"]["result"]>;
};

/**
 * Run sequential reads under one stable RLS-scoped database snapshot.
 *
 * @param userId - Authenticated user id. Must be a valid UUID string.
 * @param fn - Callback that executes bounded reads in sequence.
 * @returns Whatever the callback returns.
 * @throws {InvalidUserIdError} When `userId` is not a valid UUID string.
 * @throws {ReadOnlyViolationError} When a statement is not a plain read.
 */
export async function withUserContextReadTransaction<T>(
  userId: string,
  fn: (snapshot: SnapshotRead) => Promise<T>,
): Promise<T> {
  assertValidUserId(
    userId,
    "withUserContextReadTransaction: userId must be a valid UUID string",
  );
  return db.transaction(
    async (rawTx) => {
      const tx = rawTx as Tx;
      await executeRawDiscard(
        tx,
        sql`SELECT set_config('app.user_id', ${userId}, true)`,
      );
      const read = tx as unknown as ReadConn;
      return fn({
        read,
        run: async <TStatement extends ReadStatement<unknown>>(
          statement: TStatement,
        ): Promise<TStatement["_"]["result"]> => {
          assertReadOnlyStatements([statement]);
          return (await (statement as unknown as Promise<
            TStatement["_"]["result"]
          >)) as TStatement["_"]["result"];
        },
      });
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * Run sequential reads under one stable RLS-scoped database snapshot.
 *
 * This path uses an interactive transaction on both targets so callers can
 * await a cheap gate before loading bulk rows. The database enforces
 * `READ ONLY`, while `REPEATABLE READ` keeps every later query on the same
 * snapshot. Prefer {@link withUserContextRead} when all reads can be issued as
 * one static batch.
 *
 * @param userId - Authenticated user id. Must be a valid UUID string.
 * @param preflight - Lazy read that must clear before bulk reads are built.
 * @param validate - Callback that accepts or rejects the preflight result.
 * @param build - Lazy bulk-read statement builder.
 * @returns Results positionally aligned with the bulk statements.
 * @throws {InvalidUserIdError} When `userId` is not a valid UUID string.
 * @throws {ReadOnlyViolationError} When any statement is not a plain read.
 */
export async function withUserContextReadSnapshot<
  TPreflightResult,
  TStatements extends ReadStatements,
>(
  userId: string,
  preflight: (read: ReadConn) => ReadStatement<TPreflightResult>,
  validate: (result: TPreflightResult) => void | Promise<void>,
  build: (read: ReadConn) => TStatements,
): Promise<ReadResults<TStatements>> {
  return withUserContextReadTransaction(userId, async (snapshot) => {
    const preflightResult = await snapshot.run(preflight(snapshot.read));
    await validate(preflightResult);
    const statements = build(snapshot.read);
    assertReadOnlyStatements(statements);
    const results = await Promise.all(
      statements.map((statement) => snapshot.run(statement)),
    );
    return results as unknown as ReadResults<TStatements>;
  });
}

/**
 * Run a non-empty tuple of read statements under the caller's RLS scope
 * without an interactive WebSocket transaction. The build callback receives
 * a {@link ReadConn} statement-building handle and must return lazy,
 * un-awaited drizzle queries; `set_config('app.user_id', $1, true)` is
 * prepended inside the same transaction on both deploy targets.
 *
 * On Workers the statements ship as ONE neon-http static batch
 * (`READ ONLY`, `ReadCommitted`) — a single stateless HTTP round-trip with
 * no cross-request session state. On self-host they run inside one
 * read-only postgres-js interactive transaction. Three belts keep this
 * path read-only: a client-side statement scan ({@link
 * ReadOnlyViolationError}), the database-level `READ ONLY` transaction,
 * and RLS row policies.
 *
 * @param userId - Authenticated user id (typically `AuthContext.userId`).
 *   Must be a valid RFC 4122 UUID string.
 * @param build - Pure statement-construction callback; must not await.
 * @returns Results positionally aligned with the build statements.
 * @throws {InvalidUserIdError} When `userId` is not a valid UUID string.
 * @throws {ReadOnlyViolationError} When a statement is not a plain read.
 */
export async function withUserContextRead<T extends ReadStatements>(
  userId: string,
  build: (db: ReadConn) => T,
): Promise<ReadResults<T>> {
  assertValidUserId(
    userId,
    "withUserContextRead: userId must be a valid UUID string",
  );
  return runUserContextRead(userId, build);
}
