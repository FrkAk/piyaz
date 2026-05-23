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
 * The Neon shim's WebSocket close fires in a `setTimeout(0)`
 * (`@neondatabase/serverless` `index.mjs:421`) that runs after the
 * originating Workers request returns, in a dead I/O context, and re-emits
 * the resulting DOM `ErrorEvent` as a pool-level error (`index.mjs:401-403`).
 * With `maxUses: 1` every connection is destroyed after one query, so the
 * cascade fires on each query. Routing over `fetch` removes the WS for those
 * queries entirely.
 */
neonConfig.poolQueryViaFetch = true;

/**
 * Disable the connect-time pipelined startup that batches the TLS handshake
 * with the Postgres startup packet. On Workers the pipelined path produces
 * "WebSocket closed before greeting" when the server side of the WS
 * terminates in the narrow window between pipeline send and reply;
 * sequential startup trades ~1 RTT for a quiet auth/app pool.
 *
 * Workers-only — this file is aliased out of the self-host build by
 * `next.config.ts`'s `_driver` swap.
 */
neonConfig.pipelineConnect = false;

/**
 * Per-isolate Neon Pool tuning. The Pool is shared across requests within
 * one isolate; each connection is single-use (`maxUses: 1`) so the
 * "WebSocket cannot outlive a single request" constraint is honored at the
 * connection level. `max` caps concurrent open connections per isolate.
 * `connectionTimeoutMillis` bounds `pool.connect()` waits so a dead WS
 * callback cannot stall a request to the Workers 30s wall-time.
 *
 * Pattern from OpenNext (https://opennext.js.org/cloudflare/howtos/db).
 */
const NEON_OPTS = {
  max: 5,
  maxUses: 1,
  connectionTimeoutMillis: 5_000,
} as const;

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
 * The underlying `NeonPool` is reused across requests within an isolate;
 * each query opens a fresh single-use connection (`maxUses: 1`).
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
  const pool = attachPoolErrorLogger(
    new NeonPool({ connectionString: url, ...NEON_OPTS }),
    "app",
  );
  return {
    pool,
    db: drizzleNeon(pool, { schema: appSchema }) as unknown as AppDb,
  };
}

/**
 * Build the Better-auth Drizzle client backed by `@neondatabase/serverless`.
 *
 * @returns Pool + Drizzle instance bound to the neon_auth schema.
 * @throws Error when `DATABASE_AUTH_URL` is unset.
 */
export function buildAuthPool(): DbBundle<AuthDb> {
  const url = process.env.DATABASE_AUTH_URL;
  if (!url) {
    throw new Error(
      "DATABASE_AUTH_URL is required — Better Auth must connect via auth_role " +
        "(DML on neon_auth.*, no public-schema access).",
    );
  }
  const pool = attachPoolErrorLogger(
    new NeonPool({ connectionString: url, ...NEON_OPTS }),
    "auth",
  );
  return {
    pool,
    db: drizzleNeon(pool, { schema: authSchema }) as unknown as AuthDb,
  };
}

/**
 * Build the BYPASSRLS Drizzle client backed by `@neondatabase/serverless`.
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
  const pool = attachPoolErrorLogger(
    new NeonPool({ connectionString: url, ...NEON_OPTS }),
    "service",
  );
  return {
    pool,
    db: drizzleNeon(pool, { schema: appSchema }) as unknown as AppDb,
  };
}
