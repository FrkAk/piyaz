import type { SQL } from "drizzle-orm";
import type { db as appDb } from "@/lib/db";

/**
 * A drizzle client or a transaction handle. Use as a parameter type when a
 * helper must be callable both standalone and inside `db.transaction`.
 */
export type Conn =
  | typeof appDb
  | Parameters<Parameters<typeof appDb.transaction>[0]>[0];

/**
 * Drizzle's `client.execute()` returns one of two shapes depending on the
 * underlying driver. Normalize to a plain row array.
 *
 * - `drizzle-orm/postgres-js` returns `RowList<Row[]>` — array-like with
 *   `.count`, `.command` decorations attached.
 * - `drizzle-orm/neon-serverless` (and `node-postgres`) returns
 *   `pg.QueryResult` — an object with a `rows` field.
 *
 * Centralizing the shape check here is the only way to keep call sites
 * driver-agnostic without monkey-patching the drizzle instance.
 *
 * @param result - Raw return value from `client.execute()`.
 * @returns The row array, typed as `T[]`.
 * @throws Error when the input matches neither shape.
 */
export function normalizeExecuteResult<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error(
    "executeRaw: unrecognized client.execute() result shape — expected RowList or { rows }",
  );
}

/**
 * Run a raw SQL query against either the application client or an active
 * transaction handle and return rows as `T[]`. The single supported escape
 * hatch for SQL the type-safe builder cannot express (recursive CTEs,
 * jsonb operators, LATERAL subqueries).
 *
 * @param conn - Drizzle client or transaction handle.
 * @param query - SQL fragment built with `drizzle-orm`'s `sql\`\`` tag.
 * @returns Result rows.
 */
export async function executeRaw<T = Record<string, unknown>>(
  conn: Conn,
  query: SQL,
): Promise<T[]> {
  const raw = await conn.execute(query);
  return normalizeExecuteResult<T>(raw);
}

/**
 * Run a raw SQL statement whose return value is intentionally discarded
 * (advisory locks, `SET` statements). Distinct from {@link executeRaw} so
 * accidental "I forgot to consume the result" cases stand out at call sites.
 *
 * @param conn - Drizzle client or transaction handle.
 * @param query - SQL fragment.
 */
export async function executeRawDiscard(
  conn: Conn,
  query: SQL,
): Promise<void> {
  await conn.execute(query);
}
