import "server-only";

import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { Pool as NeonPool } from "@neondatabase/serverless";
import postgres from "postgres";
import * as appSchema from "./schema";
import * as authSchema from "./auth-schema";

/**
 * Drizzle clients for both drivers conform to the same `PgDatabase` interface
 * but their `ReturnType<>` aliases diverge in method overloads (notably
 * `.returning({...})` and `.delete(...).returning()`), so unioning them
 * produces a method set TypeScript can't pick a callable signature from.
 *
 * Pin the alias to the postgres-js shape — the dev/self-host default — and
 * cast the neon-built instance via `as unknown as AppDb`. Driver shape
 * differences inside `client.execute()` are normalized by `executeRaw` in
 * `./raw.ts`, so the cast is sound at runtime.
 */
type AppDb = ReturnType<typeof drizzlePg<typeof appSchema>>;
type AuthDb = ReturnType<typeof drizzlePg<typeof authSchema>>;

declare const appUserBrand: unique symbol;
declare const serviceRoleBrand: unique symbol;
declare const rlsScopedBrand: unique symbol;

/** Drizzle client pinned to the `app_user` pool (NOBYPASSRLS). */
export type AppUserConn = AppDb & {
  readonly [appUserBrand]: true;
};

/**
 * Drizzle client pinned to the `service_role` pool (BYPASSRLS). Reserved
 * for the documented bypass sites enumerated below. Distinct from
 * {@link AppUserConn} so the type system rejects passing `serviceRoleDb`
 * into a `Conn`-typed helper by mistake.
 */
export type ServiceRoleConn = AppDb & {
  readonly [serviceRoleBrand]: true;
};

/**
 * Transaction handle returned by `db.transaction(...)` inside a
 * `withUserContext` frame. Carries a brand so a helper that opens a bare
 * `db.transaction(...)` outside `withUserContext` (forbidden by the
 * ESLint rule) cannot satisfy the `Conn` contract through structural
 * typing.
 */
export type RlsTx = Parameters<Parameters<AppDb["transaction"]>[0]>[0] & {
  readonly [rlsScopedBrand]: true;
};

declare global {
  var __mymirAppDb: AppDb | undefined;
  var __mymirAuthDb: AuthDb | undefined;
  var __mymirServiceRoleDb: AppDb | undefined;
}

const isNeon = (): boolean => process.env.MYMIR_DB_DRIVER === "neon";

// Pool size budget: the Next.js `output: "standalone"` server runs as a
// single Node process, but the three pools (app_user, auth_role,
// service_role) coexist plus dev/test parallelism. Neon Launch tier caps
// per-branch connections at ~100. `max: 3` keeps total open connections
// well under the cap while leaving headroom for migration runs and the
// testcontainer setup. Bump if the deploy target adds replicas or runs on
// a higher Neon tier.

/**
 * Build the application Drizzle client for the active driver.
 *
 * @returns Drizzle instance bound to the public schema.
 * @throws Error when `DATABASE_URL` is unset.
 */
function buildAppDb(): AppDb {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for the app runtime connection (app_user role).",
    );
  }
  if (isNeon()) {
    const pool = new NeonPool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 10_000,
    });
    return drizzleNeon(pool, { schema: appSchema }) as unknown as AppDb;
  }
  return drizzlePg(postgres(url, { max: 3, idle_timeout: 10 }), {
    schema: appSchema,
  });
}

/**
 * Build the Better-auth Drizzle client for the active driver.
 *
 * @returns Drizzle instance bound to the neon_auth schema.
 * @throws Error when `DATABASE_AUTH_URL` is unset.
 */
function buildAuthDb(): AuthDb {
  const url = process.env.DATABASE_AUTH_URL;
  if (!url) {
    throw new Error(
      "DATABASE_AUTH_URL is required — Better Auth must connect via auth_role " +
        "(DML on neon_auth.*, no public-schema access).",
    );
  }
  if (isNeon()) {
    const pool = new NeonPool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 10_000,
    });
    return drizzleNeon(pool, { schema: authSchema }) as unknown as AuthDb;
  }
  return drizzlePg(postgres(url, { max: 3, idle_timeout: 10 }), {
    schema: authSchema,
  });
}

/**
 * Build the BYPASSRLS Drizzle client for the active driver. Wired against
 * `DATABASE_SERVICE_ROLE_URL` — a separate connection string for a role with
 * BYPASSRLS (Neon `service_role` in prod, `service_role` in self-host).
 *
 * @returns Drizzle instance bound to the public schema.
 * @throws Error when `DATABASE_SERVICE_ROLE_URL` is unset.
 */
function buildServiceRoleDb(): AppDb {
  const url = process.env.DATABASE_SERVICE_ROLE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_SERVICE_ROLE_URL is required for service-role data access",
    );
  }
  if (isNeon()) {
    const pool = new NeonPool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 10_000,
    });
    return drizzleNeon(pool, { schema: appSchema }) as unknown as AppDb;
  }
  return drizzlePg(postgres(url, { max: 3, idle_timeout: 10 }), {
    schema: appSchema,
  });
}

/**
 * Lazily initialized application Drizzle client.
 *
 * Driver chosen at first access via `MYMIR_DB_DRIVER`:
 * - `neon` → `drizzle-orm/neon-serverless` + WebSocket `Pool`
 * - unset / anything else → `drizzle-orm/postgres-js` + `postgres` TCP
 *
 * Cached on `globalThis` so a warm Node process reuses the connection
 * across requests instead of paying the WebSocket handshake each time.
 */
export const appDb = new Proxy({} as AppUserConn, {
  get(_target, prop, receiver) {
    if (!globalThis.__mymirAppDb) globalThis.__mymirAppDb = buildAppDb();
    return Reflect.get(globalThis.__mymirAppDb, prop, receiver);
  },
});

/**
 * Lazily initialized Better-auth Drizzle client.
 *
 * Same driver-selection and caching semantics as {@link appDb} but bound
 * to the `neon_auth` schema used by `drizzleAdapter` in {@link auth}.
 */
export const authDb = new Proxy({} as AuthDb, {
  get(_target, prop, receiver) {
    if (!globalThis.__mymirAuthDb) globalThis.__mymirAuthDb = buildAuthDb();
    return Reflect.get(globalThis.__mymirAuthDb, prop, receiver);
  },
});

/**
 * Lazily initialized BYPASSRLS Drizzle client. Reserved for the documented
 * bypass sites — adding a new one requires auditing whether a SECURITY
 * DEFINER function in `docker/rls-functions.sql` can replace it.
 *
 * Current sites:
 *   - `lib/data/account.ts:clearOrgMembershipArtifacts`
 *   - `lib/data/project.ts:listOrgProjectIdsAsAdmin`
 *   - `lib/data/membership.ts:findOrgMemberUserIdsAsAdmin`
 *   - `lib/data/oauth-session.ts` (app_user has no grants on the
 *     oauth* tables; rows are not tenant-scoped so RLS does not apply).
 */
export const serviceRoleDb = new Proxy({} as ServiceRoleConn, {
  get(_target, prop, receiver) {
    if (!globalThis.__mymirServiceRoleDb) {
      globalThis.__mymirServiceRoleDb = buildServiceRoleDb();
    }
    return Reflect.get(globalThis.__mymirServiceRoleDb, prop, receiver);
  },
});
