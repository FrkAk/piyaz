import "server-only";

import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { Pool as NeonPool } from "@neondatabase/serverless";
import * as appSchema from "./schema";
import * as authSchema from "./auth-schema";
import type { AppDb, AuthDb, DbBundle } from "./_driver.node";

export type { AppDb, AuthDb, DbBundle, ClosablePool } from "./_driver.node";

const NEON_OPTS = { max: 3, idleTimeoutMillis: 10_000 } as const;

/**
 * Build the application Drizzle client backed by `@neondatabase/serverless`.
 * Creates a fresh `NeonPool` per call; callers MUST close it via
 * `ctx.waitUntil(pool.end())` once the request completes.
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
  const pool = new NeonPool({ connectionString: url, ...NEON_OPTS });
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
  const pool = new NeonPool({ connectionString: url, ...NEON_OPTS });
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
  const pool = new NeonPool({ connectionString: url, ...NEON_OPTS });
  return {
    pool,
    db: drizzleNeon(pool, { schema: appSchema }) as unknown as AppDb,
  };
}
