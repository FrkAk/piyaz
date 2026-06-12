import "server-only";

import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import {
  drizzle as drizzleHttp,
  type NeonHttpDatabase,
} from "drizzle-orm/neon-http";
import { neon, neonConfig, Pool as NeonPool } from "@neondatabase/serverless";
import * as appSchema from "./schema";
import * as authSchema from "./auth-schema";
import type { AppDb, AuthDb, DbBundle } from "./_driver.node";

export type { AppDb, AuthDb, DbBundle, ClosablePool } from "./_driver.node";

/** Drizzle client over the neon-http driver, bound to the public schema. */
export type AppHttpDb = NeonHttpDatabase<typeof appSchema>;

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
 * Disable the connect-time pipelined startup that batches the TLS handshake
 * with the Postgres startup packet. The pipelined path produced observed
 * production "WebSocket closed before greeting" failures when the server
 * closed the WS between the pipelined send and its reply; the race is a
 * connect-time window, so per-request pools (which still open a fresh WS
 * per interactive transaction) do not remove it. Sequential startup trades
 * ~1 RTT on WS connects for a quiet connect path; revisit with
 * post-deploy observability evidence.
 */
neonConfig.pipelineConnect = false;

/** Per-role connection-string guard messages, one source for WS + HTTP builders. */
const DB_URL_REQUIRED = {
  app: "DATABASE_URL is required for the app runtime connection (app_user role).",
  auth:
    "DATABASE_AUTH_URL is required — Better Auth must connect via auth_role " +
    "(DML on neon_auth.*, no public-schema access).",
  service: "DATABASE_SERVICE_ROLE_URL is required for service-role data access",
} as const;

/**
 * Per-request Pool options. `connectionTimeoutMillis` bounds
 * `pool.connect()` waits so an unresponsive Neon endpoint fails the request
 * fast instead of riding the Workers 30s wall clock — and so a stuck
 * connect cannot wedge `pool.end()` during teardown (it only settles once
 * every client drains). 10s clears Neon cold starts where the old 5s was
 * tight. `max` stays at the driver default: a per-request pool is already
 * lifetime-bounded by the request.
 */
const POOL_OPTS = { connectionTimeoutMillis: 10_000 } as const;

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
    throw new Error(DB_URL_REQUIRED.app);
  }
  const pool = attachPoolErrorLogger(
    new NeonPool({ connectionString: url, ...POOL_OPTS }),
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
    throw new Error(DB_URL_REQUIRED.auth);
  }
  const pool = attachPoolErrorLogger(
    new NeonPool({ connectionString: url, ...POOL_OPTS }),
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
    throw new Error(DB_URL_REQUIRED.service);
  }
  const pool = attachPoolErrorLogger(
    new NeonPool({ connectionString: url, ...POOL_OPTS }),
    "service",
  );
  return {
    pool,
    db: drizzleNeon(pool, { schema: appSchema }) as unknown as AppDb,
  };
}

/**
 * Transaction defaults baked into every neon-http read client. Drizzle's
 * `db.batch()` forwards no per-call transaction options to the driver
 * (verified against `drizzle-orm@0.45.2` `neon-http/session.js:131`), so
 * `READ ONLY` + `ReadCommitted` must ride the client construction — they
 * become the `Neon-Batch-*` headers on every batch this client sends.
 */
const HTTP_TX_OPTS = {
  readOnly: true,
  isolationLevel: "ReadCommitted",
} as const;

/**
 * Build the application read client backed by the neon-http driver.
 * Stateless — each batch is one self-contained HTTP request with no
 * connection to tear down, so callers register nothing with the request
 * teardown. Consumed by `withUserContextRead` for the RLS read path.
 *
 * @param url - Connection string, defaulting to `DATABASE_URL`.
 * @returns Drizzle neon-http client bound to the public schema.
 * @throws Error when `DATABASE_URL` is unset.
 */
export function buildAppHttp(url = process.env.DATABASE_URL): AppHttpDb {
  if (!url) {
    throw new Error(DB_URL_REQUIRED.app);
  }
  return drizzleHttp(neon(url, HTTP_TX_OPTS), { schema: appSchema });
}
