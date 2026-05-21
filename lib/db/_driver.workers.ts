import "server-only";

import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { Pool as NeonPool } from "@neondatabase/serverless";
import * as appSchema from "./schema";
import * as authSchema from "./auth-schema";
import type { AppDb, AuthDb, DbBundle } from "./_driver.node";

export type { AppDb, AuthDb, DbBundle, ClosablePool } from "./_driver.node";

/**
 * Per-isolate Neon Pool tuning. The Pool is shared across requests within
 * one isolate; each connection is single-use (`maxUses: 1`) so the
 * "WebSocket cannot outlive a single request" constraint is honored at the
 * connection level — a connection serves one query then is destroyed.
 *
 * `max` caps concurrent open connections per isolate. The pattern is the
 * one recommended by OpenNext (https://opennext.js.org/cloudflare/howtos/db).
 */
const NEON_OPTS = { max: 5, maxUses: 1 } as const;

/**
 * Attach a Pool-level error listener so unhandled idle-client errors from
 * `pg` do not surface as `EventEmitter` uncaught events (which terminate
 * the isolate and drop every in-flight request). Logged only; the Pool
 * itself recovers by creating a fresh connection on the next `connect()`.
 *
 * @param pool - Neon pool to instrument.
 * @param role - Role tag included in the log prefix.
 * @returns The same pool, with the listener attached.
 */
function attachPoolErrorLogger<P extends NeonPool>(pool: P, role: string): P {
  pool.on("error", (err: unknown) => {
    console.error(`[db:${role}] neon pool background error`, err);
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
