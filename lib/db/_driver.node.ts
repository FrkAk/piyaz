import "server-only";

import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as appSchema from "./schema";
import * as authSchema from "./auth-schema";

/**
 * Drizzle clients for the postgres-js (Node TCP) driver. Pinned to one driver
 * so the type aliases stay narrow; the runtime Proxy in `./connection.ts`
 * casts the Workers driver's Drizzle instance to {@link AppDb} where needed
 * (driver shape differences in `client.execute()` are normalized by
 * `executeRaw` in `./raw.ts`, so the cast is sound at runtime).
 */
export type AppDb = ReturnType<typeof drizzlePg<typeof appSchema>>;
export type AuthDb = ReturnType<typeof drizzlePg<typeof authSchema>>;

/**
 * Portable pool shape — the only method `withRequestDb` calls is `end()`.
 * Both `postgres.Sql` and `@neondatabase/serverless.Pool` satisfy this.
 */
export interface ClosablePool {
  end: () => Promise<unknown>;
}

/** Per-role bundle returned by every pool factory. */
export interface DbBundle<TDb> {
  pool: ClosablePool;
  db: TDb;
}

/**
 * Ceiling on how long a single statement may run, in milliseconds.
 *
 * Query shape is caller-influenced (graph walks, search, tag aggregation) and
 * Postgres defaults to no limit, so one expensive statement can otherwise hold
 * a backend indefinitely. Every legitimate query here is far below this; the
 * bound exists to turn a runaway into a failed request instead of a pinned
 * database. Kept in lockstep with the Workers driver's identical setting.
 */
const STATEMENT_TIMEOUT_MS = 15_000;

const POSTGRES_OPTS = {
  max: 3,
  idle_timeout: 10,
  connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
} as const;

/**
 * Build the application Drizzle client backed by postgres-js.
 *
 * @returns Pool + Drizzle instance bound to the public schema.
 * @throws Error when `DATABASE_URL` is unset.
 */
export function buildAppPool(): DbBundle<AppDb> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for the app runtime connection (app_user role).",
    );
  }
  const pool = postgres(url, POSTGRES_OPTS);
  return { pool, db: drizzlePg(pool, { schema: appSchema }) };
}

/**
 * Build the Better-auth Drizzle client backed by postgres-js.
 *
 * @returns Pool + Drizzle instance bound to the piyaz_auth schema.
 * @throws Error when `DATABASE_AUTH_URL` is unset.
 */
export function buildAuthPool(): DbBundle<AuthDb> {
  const url = process.env.DATABASE_AUTH_URL;
  if (!url) {
    throw new Error(
      "DATABASE_AUTH_URL is required — Better Auth must connect via auth_role " +
        "(DML on piyaz_auth.*, no public-schema access).",
    );
  }
  const pool = postgres(url, POSTGRES_OPTS);
  return { pool, db: drizzlePg(pool, { schema: authSchema }) };
}

/**
 * Build the BYPASSRLS Drizzle client backed by postgres-js. Wired against
 * `DATABASE_SERVICE_ROLE_URL` (a separate connection string for a role with
 * BYPASSRLS).
 *
 * @returns Pool + Drizzle instance bound to the public schema.
 * @throws Error when `DATABASE_SERVICE_ROLE_URL` is unset.
 */
export function buildServicePool(): DbBundle<AppDb> {
  const url = process.env.DATABASE_SERVICE_ROLE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_SERVICE_ROLE_URL is required for service-role data access",
    );
  }
  const pool = postgres(url, POSTGRES_OPTS);
  return { pool, db: drizzlePg(pool, { schema: appSchema }) };
}
