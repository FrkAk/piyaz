import { sql, type SQL } from "drizzle-orm";
import type {
  AppUserConn,
  RlsTx,
  ServiceRoleConn,
} from "@/lib/db/connection";

export type { AppUserConn, RlsTx, ServiceRoleConn };

/**
 * A drizzle client or a transaction handle pinned to the caller's RLS
 * scope. Use as the parameter type on every internal `lib/data/*` helper
 * so a non-RLS-scoped handle (e.g. `serviceRoleDb`, or a bare drizzle tx
 * opened outside `withUserContext`) is a TypeScript error at the call
 * site, not just an ESLint violation.
 */
export type Conn = AppUserConn | RlsTx;

/**
 * Internal: any drizzle handle the `executeRaw` helpers accept. Broader
 * than {@link Conn} because the bypass sites (`clearOrgMembershipArtifacts`,
 * `listOrgProjectIdsAsAdmin`, etc.) legitimately route raw SQL through
 * the BYPASSRLS pool.
 */
type AnyConn = AppUserConn | ServiceRoleConn | RlsTx;

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
  conn: AnyConn,
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
  conn: AnyConn,
  query: SQL,
): Promise<void> {
  await conn.execute(query);
}

/**
 * Build a Postgres `uuid[]` expression from a JS `string[]`. Drizzle's
 * `sql` tag expands a raw JS array interpolation into a parenthesized
 * list of scalar placeholders (`($1, $2, ...)`), which Postgres cannot
 * cast to `uuid[]` — the cast attempt yields `malformed array literal`.
 *
 * Emit an explicit `ARRAY[$1::uuid, $2::uuid, ...]` constructor instead so
 * each id binds as its own parameter through postgres-js's standard path
 * (no string concatenation, no injection surface). The per-element cast
 * gives Postgres a typed scalar to fold into the array.
 *
 * @param ids - UUID strings (validated by the caller). Empty arrays yield
 *   `ARRAY[]::uuid[]` so the result is always a typed `uuid[]`.
 * @returns A drizzle `sql` fragment that evaluates to `uuid[]`.
 */
export function uuidArray(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`ARRAY[]::uuid[]`;
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;
}
