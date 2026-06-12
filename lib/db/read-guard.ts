import "server-only";

/**
 * Thrown when a statement handed to `withUserContextRead` is not a plain
 * read. Named so callers (and tests) can distinguish the client-side guard
 * from Postgres's own `cannot execute ... in a read-only transaction`
 * errors, which remain the database-level backstop.
 */
export class ReadOnlyViolationError extends Error {
  /**
   * @param message - Diagnostic text naming the offending statement.
   */
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyViolationError";
  }
}

/**
 * One read statement produced by a `withUserContextRead` build callback: a
 * lazy drizzle query (select builder or `db.execute(sql)` raw) that has not
 * been awaited. The `_` marker mirrors drizzle's `RunnableQuery` so batch
 * result types map positionally.
 */
export interface ReadStatement<TResult = unknown> extends PromiseLike<TResult> {
  /** Drizzle runnable-query result marker (type-level only). */
  readonly _: { readonly result: TResult };
}

/** Non-empty tuple of read statements returned by a build callback. */
export type ReadStatements = readonly [
  ReadStatement<unknown>,
  ...ReadStatement<unknown>[],
];

/** Positional result tuple for a {@link ReadStatements} tuple. */
export type ReadResults<T extends ReadStatements> = {
  -readonly [K in keyof T]: T[K] extends ReadStatement<infer R> ? R : never;
};

/** Statements must start as plain reads; anything else fails loudly. */
const READ_HEAD_RE = /^\s*(?:select|with)\b/i;

/**
 * Tokens that have no business inside a read batch. Write verbs and DDL are
 * also rejected by the `READ ONLY` transaction itself; `set_config` and
 * advisory locks are NOT (they are legal in read-only transactions), which
 * is why this client-side scan exists — a build statement must never be
 * able to re-point `app.user_id` or take a lock over the stateless path.
 *
 * Known false-positive surface, accepted for a defense belt: statements
 * must START with SELECT/WITH (no leading SQL comments), and identifiers,
 * aliases, or literals containing a forbidden token (e.g. a column named
 * "merge") are rejected. Keep read SQL clear of both; the database-level
 * READ ONLY transaction remains the backstop for anything the scan misses.
 */
const FORBIDDEN_SQL_RE =
  /\b(?:insert|update|delete|merge|alter|drop|truncate|create|grant|revoke|copy|set_config|pg_advisory_\w+)\b/i;

/** Structural surface for extracting SQL text from a lazy drizzle query. */
type SqlCarrier = {
  toSQL?: () => { sql: string };
  getQuery?: () => { sql: string };
};

/**
 * Render the SQL text of a lazy drizzle statement without executing it.
 * Select builders expose `toSQL()`; `db.execute(sql)` raws expose
 * `getQuery()`.
 *
 * @param statement - Lazy drizzle query from a build callback.
 * @returns The parameterized SQL text.
 * @throws {ReadOnlyViolationError} When the value exposes neither accessor.
 */
function statementSql(statement: unknown): string {
  const carrier = statement as SqlCarrier;
  const query = carrier.toSQL?.() ?? carrier.getQuery?.();
  if (!query) {
    throw new ReadOnlyViolationError(
      "withUserContextRead: statement does not expose its SQL " +
        "(expected a drizzle select builder or db.execute(sql`...`))",
    );
  }
  return query.sql;
}

/**
 * Assert every build statement is a plain read before anything is sent.
 * Belt one of three: this scan fails loudly client-side, the batch runs
 * `READ ONLY` at the database, and RLS scopes every visible row.
 *
 * @param statements - Statements returned by the build callback.
 * @throws {ReadOnlyViolationError} On an empty array, a statement that does
 *   not start with SELECT/WITH, or one containing a write / GUC / advisory
 *   lock token.
 */
export function assertReadOnlyStatements(statements: readonly unknown[]): void {
  if (statements.length === 0) {
    throw new ReadOnlyViolationError(
      "withUserContextRead: build must return at least one statement",
    );
  }
  statements.forEach((statement, index) => {
    const text = statementSql(statement);
    if (!READ_HEAD_RE.test(text)) {
      throw new ReadOnlyViolationError(
        `withUserContextRead: statement ${index} is not read-only ` +
          `(must start with SELECT or WITH): ${text.slice(0, 120)}`,
      );
    }
    const banned = text.match(FORBIDDEN_SQL_RE);
    if (banned) {
      throw new ReadOnlyViolationError(
        `withUserContextRead: statement ${index} is not read-only ` +
          `(contains "${banned[0]}"): ${text.slice(0, 120)}`,
      );
    }
  });
}
