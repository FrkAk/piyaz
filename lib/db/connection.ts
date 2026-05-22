import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import {
  buildAppPool,
  buildAuthPool,
  buildServicePool,
} from "@/lib/db/_driver";
import type { AppDb, AuthDb } from "@/lib/db/_driver.node";

export type { AppDb, AuthDb } from "@/lib/db/_driver.node";

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

/** Per-request DB bundle seeded by `withRequestDb` on Cloudflare Workers. */
export interface RequestScopedDb {
  appDb: AppUserConn;
  authDb: AuthDb;
  serviceRoleDb: ServiceRoleConn;
}

/**
 * AsyncLocalStorage frame populated by the Workers request-scope helper.
 *
 * Pinned to a `globalThis` slot keyed by `Symbol.for(...)` so every bundle
 * that imports this module observes the same instance — on Workers the
 * final artifact contains two copies of this file (one bundled by Next's
 * webpack into `.open-next/worker.js`, another by wrangler's esbuild from
 * `worker-cf.ts`), and without the global pin each would instantiate its
 * own `AsyncLocalStorage`. OpenNext's `init.js` uses the same pattern for
 * `__cloudflare-context__`.
 */
const REQUEST_DB_STORE_KEY = Symbol.for("@mymir/db/requestDbStore");
const symbolKeyedGlobal = globalThis as Record<symbol, unknown>;
if (!symbolKeyedGlobal[REQUEST_DB_STORE_KEY]) {
  symbolKeyedGlobal[REQUEST_DB_STORE_KEY] =
    new AsyncLocalStorage<RequestScopedDb>();
}
export const requestDbStore = symbolKeyedGlobal[
  REQUEST_DB_STORE_KEY
] as AsyncLocalStorage<RequestScopedDb>;

type GlobalKey = "__mymirAppDb" | "__mymirAuthDb" | "__mymirServiceRoleDb";

/**
 * Resolve the active Drizzle client for a role.
 *
 * Both deploy targets use a `globalThis`-cached singleton built lazily on
 * first read. On self-host the Node `Pool` warms up once and serves every
 * request via standard pg pooling. On Cloudflare Workers the Neon Pool is
 * configured with `maxUses: 1` (see `lib/db/_driver.workers.ts`), so each
 * connection is single-use even though the Pool instance persists across
 * requests within an isolate — the "WebSocket cannot outlive a request"
 * constraint is honored at the connection level, not the Pool level.
 *
 * The {@link requestDbStore} ALS frame is consulted first for explicit
 * scoping (e.g. tests that want to inject sentinel clients via
 * `requestDbStore.run`). Production fetch paths simply hit the cache.
 *
 * @param key - Which role to read from the request-scope bundle (used only
 *   when an ALS frame is explicitly active).
 * @param globalKey - Matching `globalThis.__mymir*` slot.
 * @param builder - Factory invoked at most once to populate the slot.
 * @returns Drizzle instance for the role.
 */
function getScopedOrGlobal<TDb extends AppDb | AuthDb>(
  key: keyof RequestScopedDb,
  globalKey: GlobalKey,
  builder: () => { db: TDb },
): TDb {
  const scoped = requestDbStore.getStore();
  if (scoped) return scoped[key] as TDb;
  const cached = globalThis[globalKey];
  if (cached) return cached as TDb;
  const built = builder().db;
  globalThis[globalKey] = built as never;
  return built;
}

/**
 * Lazily initialized application Drizzle client.
 *
 * On Workers, resolves to the per-request bundle seeded by `withRequestDb`
 * (see `lib/db/request-scope.workers.ts`). On self-host, falls back to a
 * `globalThis` singleton built from the postgres-js driver so a warm Node
 * process reuses the connection across requests.
 */
export const appDb = new Proxy({} as AppUserConn, {
  get(_target, prop, receiver) {
    const db = getScopedOrGlobal<AppDb>("appDb", "__mymirAppDb", buildAppPool);
    return Reflect.get(db, prop, receiver);
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
    const db = getScopedOrGlobal<AuthDb>(
      "authDb",
      "__mymirAuthDb",
      buildAuthPool,
    );
    return Reflect.get(db, prop, receiver);
  },
});

/**
 * Lazily initialized BYPASSRLS Drizzle client. Reserved for the documented
 * bypass sites — adding a new one requires auditing whether a SECURITY
 * DEFINER function in `docker/rls-functions.sql` can replace it.
 *
 * Current bypass sites (direct method access — require eslint.config.mjs ignores entry):
 *   - `lib/data/account.ts:clearOrgMembershipArtifacts`
 *   - `lib/data/membership.ts:findOrgMemberUserIdsAsAdmin`
 *   - `lib/data/oauth-session.ts` (app_user has no grants on the
 *     oauth* tables; rows are not tenant-scoped so RLS does not apply;
 *     uses both method access and `executeRaw`).
 *
 * Indirect bypass sites (`executeRaw(serviceRoleDb, ...)` — no ignores entry needed):
 *   - `lib/data/project.ts:listOrgProjectIdsAsAdmin`
 */
export const serviceRoleDb = new Proxy({} as ServiceRoleConn, {
  get(_target, prop, receiver) {
    const db = getScopedOrGlobal<AppDb>(
      "serviceRoleDb",
      "__mymirServiceRoleDb",
      buildServicePool,
    );
    return Reflect.get(db, prop, receiver);
  },
});
