import "server-only";

import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { neonConfig, Pool as NeonPool } from "@neondatabase/serverless";
import * as appSchema from "./schema";
import * as authSchema from "./auth-schema";
import type { AppDb, AuthDb, DbBundle } from "./_driver.node";

export type { AppDb, AuthDb, DbBundle, ClosablePool } from "./_driver.node";

/**
 * Route non-transactional `pool.query()` calls over HTTP `fetch` instead of
 * WebSocket. Transactions still open a WS (the SQL protocol requires the
 * round-trip) but they become the exception.
 *
 * Caveat from the driver (`@neondatabase/serverless` `index.d.mts:598-605`):
 * fetch-routing only applies while the Pool has NO listeners for `connect`,
 * `acquire`, `release`, or `remove`. The `error` listener attached below is
 * safe; do not add any of those four or fetch-routing silently turns off.
 *
 * Workers-only — this file is aliased out of the self-host build by
 * `next.config.ts`'s `_driver` swap.
 */
neonConfig.poolQueryViaFetch = true;

/**
 * Attach a Pool-level error listener so unhandled idle-client errors from
 * `pg` do not surface as `EventEmitter` uncaught events (which terminate the
 * isolate and drop every in-flight request). Logged only; the Pool recovers
 * by creating a fresh connection on the next `connect()`.
 *
 * @param pool - Neon pool to instrument.
 * @param role - Role tag included in the log payload.
 * @returns The same pool, with the listener attached.
 */
function attachPoolErrorLogger<P extends NeonPool>(pool: P, role: string): P {
  pool.on("error", (err: unknown) => {
    // The Neon serverless shim re-emits the raw DOM `ErrorEvent` from a
    // dying WebSocket (`@neondatabase/serverless` `index.mjs:401-403`);
    // a plain stringify yields `"[object ErrorEvent]"`. Unpack the fields
    // observability needs to filter on.
    const evt = err as {
      type?: string;
      code?: string | number;
      message?: string;
      reason?: string;
    } | null;
    console.error(
      JSON.stringify({
        event: "neon_pool_background_error",
        role,
        name: err instanceof Error ? err.name : undefined,
        message:
          err instanceof Error
            ? err.message
            : (evt?.message ?? evt?.reason ?? String(err)),
        type: evt?.type,
        code: evt?.code,
      }),
    );
  });
  return pool;
}

/**
 * Build the application Drizzle client backed by `@neondatabase/serverless`.
 * Returns a fresh `NeonPool` on every call: pools are request-scoped on
 * Workers (created by `withRequestDb`, ended via `ctx.waitUntil` after the
 * response body completes) per Neon's documented Workers lifecycle — a Pool
 * that outlives its request fires WebSocket close callbacks in a dead I/O
 * context.
 *
 * @param url - Connection string, defaulting to `DATABASE_URL`.
 * @returns Pool + Drizzle instance bound to the public schema.
 * @throws Error when `DATABASE_URL` is unset.
 */
export function buildAppPool(url = process.env.DATABASE_URL): DbBundle<AppDb> {
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for the app runtime connection (app_user role).",
    );
  }
  const pool = attachPoolErrorLogger(
    new NeonPool({ connectionString: url }),
    "app",
  );
  return {
    pool,
    db: drizzleNeon(pool, { schema: appSchema }) as unknown as AppDb,
  };
}

/**
 * Build the Better-auth Drizzle client backed by `@neondatabase/serverless`.
 * Fresh request-scoped Pool per call; see {@link buildAppPool}.
 *
 * @param url - Connection string, defaulting to `DATABASE_AUTH_URL`.
 * @returns Pool + Drizzle instance bound to the neon_auth schema.
 * @throws Error when `DATABASE_AUTH_URL` is unset.
 */
export function buildAuthPool(
  url = process.env.DATABASE_AUTH_URL,
): DbBundle<AuthDb> {
  if (!url) {
    throw new Error(
      "DATABASE_AUTH_URL is required — Better Auth must connect via auth_role " +
        "(DML on neon_auth.*, no public-schema access).",
    );
  }
  const pool = attachPoolErrorLogger(
    new NeonPool({ connectionString: url }),
    "auth",
  );
  return {
    pool,
    db: drizzleNeon(pool, { schema: authSchema }) as unknown as AuthDb,
  };
}

/**
 * Build the BYPASSRLS Drizzle client backed by `@neondatabase/serverless`.
 * Fresh request-scoped Pool per call; see {@link buildAppPool}.
 *
 * @param url - Connection string, defaulting to `DATABASE_SERVICE_ROLE_URL`.
 * @returns Pool + Drizzle instance bound to the public schema.
 * @throws Error when `DATABASE_SERVICE_ROLE_URL` is unset.
 */
export function buildServicePool(
  url = process.env.DATABASE_SERVICE_ROLE_URL,
): DbBundle<AppDb> {
  if (!url) {
    throw new Error(
      "DATABASE_SERVICE_ROLE_URL is required for service-role data access",
    );
  }
  const pool = attachPoolErrorLogger(
    new NeonPool({ connectionString: url }),
    "service",
  );
  return {
    pool,
    db: drizzleNeon(pool, { schema: appSchema }) as unknown as AppDb,
  };
}
