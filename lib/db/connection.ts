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

declare global {
  var __mymirAppDb: AppDb | undefined;
  var __mymirAuthDb: AuthDb | undefined;
}

const isNeon = (): boolean => process.env.MYMIR_DB_DRIVER === "neon";

/**
 * Build the application Drizzle client for the active driver.
 *
 * @returns Drizzle instance bound to the public schema.
 */
function buildAppDb(): AppDb {
  const url = process.env.DATABASE_URL!;
  console.log(
    `[mymir/db] buildAppDb fired driver=${isNeon() ? "neon" : "postgres-js"} ts=${new Date().toISOString()}`,
  );
  if (isNeon()) {
    const pool = new NeonPool({ connectionString: url });
    return drizzleNeon(pool, { schema: appSchema }) as unknown as AppDb;
  }
  return drizzlePg(postgres(url), { schema: appSchema });
}

/**
 * Build the Better-auth Drizzle client for the active driver.
 *
 * @returns Drizzle instance bound to the neon_auth schema.
 */
function buildAuthDb(): AuthDb {
  const url = process.env.DATABASE_URL!;
  console.log(
    `[mymir/db] buildAuthDb fired driver=${isNeon() ? "neon" : "postgres-js"} ts=${new Date().toISOString()}`,
  );
  if (isNeon()) {
    const pool = new NeonPool({ connectionString: url });
    return drizzleNeon(pool, { schema: authSchema }) as unknown as AuthDb;
  }
  return drizzlePg(postgres(url), { schema: authSchema });
}

/**
 * Lazily initialized application Drizzle client.
 *
 * Driver chosen at first access via `MYMIR_DB_DRIVER`:
 * - `neon` → `drizzle-orm/neon-serverless` + WebSocket `Pool`
 * - unset / anything else → `drizzle-orm/postgres-js` + `postgres` TCP
 *
 * Cached on `globalThis` so warm Workers isolates reuse the connection
 * across requests instead of paying the WebSocket handshake each time.
 */
export const appDb = new Proxy({} as AppDb, {
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
