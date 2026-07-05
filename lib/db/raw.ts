import { sql, type SQL } from "drizzle-orm";
import { tasks } from "@/lib/db/schema";
import type {
  AppDb,
  AppUserConn,
  RlsTx,
  ServiceRoleConn,
} from "@/lib/db/connection";
import type { ReadStatement } from "@/lib/db/read-guard";

export type { AppUserConn, RlsTx, ServiceRoleConn };

/**
 * A drizzle client or a transaction handle pinned to the caller's RLS
 * scope. Use as the parameter type on every internal `lib/data/*` helper
 * so a non-RLS-scoped handle (e.g. `serviceRoleDb`, or a bare drizzle tx
 * opened outside `withUserContext`) is a TypeScript error at the call
 * site, not just an ESLint violation.
 */
export type Conn = AppUserConn | RlsTx;

declare const readConnBrand: unique symbol;
declare const rawReadRowsBrand: unique symbol;

/**
 * Opaque result of a `ReadConn.execute` batch statement. The runtime shape
 * differs per backend (postgres-js row list vs neon-http `{ rows }`), so
 * the brand blocks direct consumption — pass it through
 * {@link normalizeExecuteResult} to get typed rows on both targets.
 */
export type RawReadRows = { readonly [rawReadRowsBrand]: true };

/**
 * Statement-building handle passed to a `withUserContextRead` build
 * callback. Exposes only lazy read builders: on Workers the statements are
 * sent as ONE neon-http batch transaction with the `app.user_id` GUC set
 * first; on self-host they run inside one read-only interactive
 * transaction with the same GUC contract.
 *
 * Deliberately DISJOINT from {@link Conn}: awaiting queries one-by-one on
 * the HTTP handle outside a batch would run each as its own stateless
 * request with NO `app.user_id` set — RLS would default-deny and silently
 * return empty rows. The brand keeps a ReadConn out of every
 * interactive-transaction helper, and write builders off this surface
 * entirely.
 */
export type ReadConn = Pick<AppDb, "select"> & {
  /**
   * Build a lazy raw-SQL read statement. The branded result blocks direct
   * consumption; pass it through {@link normalizeExecuteResult}.
   */
  execute(query: SQL): ReadStatement<RawReadRows>;
  readonly [readConnBrand]: true;
};

/**
 * SQL expression deriving a task's project id from its own row, so a batch
 * statement keyed only on the task id keeps the cross-project
 * defense-in-depth filter without waiting for the task row to be read
 * first. Equal to the project id every interactive caller passes (it comes
 * from the same task row); Postgres evaluates the uncorrelated subquery
 * once as an InitPlan.
 *
 * @param taskId - UUID of the task whose project scopes the read.
 * @returns Scalar-subquery SQL fragment.
 */
export function taskProjectScopeSql(taskId: string): SQL {
  return sql`(SELECT project_id FROM ${tasks} WHERE id = ${taskId})`;
}

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
 * Coerce a driver-provided timestamp to a Date (postgres-js returns a
 * Date, neon-http returns an ISO string).
 *
 * @param value - Driver-provided timestamp.
 * @returns The timestamp as a Date.
 */
export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
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
