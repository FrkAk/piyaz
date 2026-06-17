import "server-only";

import {
  buildAppPool,
  buildAuthPool,
  buildServicePool,
} from "@/lib/db/_driver";
import type { AppDb, AuthDb } from "@/lib/db/_driver.node";
import type { AppHttpDb } from "@/lib/db/_driver.workers";
import { requiresRequestScope } from "@/lib/db/request-scope";
import { requestDbStore } from "./request-store";

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
  var __piyazAppDb: AppDb | undefined;
  var __piyazAuthDb: AuthDb | undefined;
  var __piyazServiceRoleDb: AppDb | undefined;
}

/** Per-request DB bundle seeded by `withRequestDb` on Cloudflare Workers. */
export interface RequestScopedDb {
  appDb: AppUserConn;
  authDb: AuthDb;
  serviceRoleDb: ServiceRoleConn;
  /**
   * Lazy neon-http read client for the app role (Workers only; type-only
   * import keeps the HTTP driver out of the self-host bundle). Stateless —
   * no teardown registration. Backs `withUserContextRead`'s batch path.
   * Optional so tests can seed minimal sentinel frames.
   */
  appDbRead?: AppHttpDb;
  /**
   * Detached promises registered via `deferRequestWork`; the request
   * teardown settles them before ending any pool. Optional so tests can
   * seed minimal sentinel frames.
   */
  deferred?: Set<Promise<unknown>>;
}

export { requestDbStore } from "./request-store";

type GlobalKey = "__piyazAppDb" | "__piyazAuthDb" | "__piyazServiceRoleDb";

type RoleKey = "appDb" | "authDb" | "serviceRoleDb";

/**
 * Resolve the active Drizzle client for a role.
 *
 * The {@link requestDbStore} ALS frame is consulted first. On Workers
 * builds it is the ONLY production source: pools are built per request by
 * `withRequestDb` (`lib/db/request-scope.workers.ts`) and ended after the
 * response body completes, so unscoped access throws loudly instead of
 * minting a Pool that would outlive its request and fire WebSocket close
 * callbacks in a dead I/O context. The guard fires on two belts:
 * {@link requiresRequestScope} from the target-aliased request-scope
 * module (same build axis that selects the driver, so a missing wrangler
 * var cannot silently disable it) and the `DEPLOY_TARGET` runtime var
 * (which keeps the branch testable where the alias is absent).
 * Development is exempt: `next dev` has no worker entry to install the
 * frame and runs in Node, where a long-lived pool is legal.
 *
 * On self-host the frame is optional (tests inject sentinel clients via
 * `requestDbStore.run`); without one, a `globalThis`-cached singleton is
 * built lazily and reused across requests via standard pg pooling.
 *
 * @param key - Which role to read from the request-scope bundle.
 * @param globalKey - Matching `globalThis.__piyaz*` slot (self-host only).
 * @param builder - Factory invoked at most once to populate the slot.
 * @returns Drizzle instance for the role.
 * @throws Error on Workers when no request frame is active.
 */
function getScopedOrGlobal<TDb extends AppDb | AuthDb>(
  key: RoleKey,
  globalKey: GlobalKey,
  builder: () => { db: TDb },
): TDb {
  const scoped = requestDbStore.getStore();
  if (scoped) return scoped[key] as TDb;
  const workersBuild =
    requiresRequestScope || process.env.DEPLOY_TARGET === "cloudflare";
  if (workersBuild && process.env.NODE_ENV !== "development") {
    throw new Error(
      `Unscoped DB access on Workers: "${key}" is only available inside an ` +
        "active withRequestDb frame (lib/db/request-scope.workers.ts). " +
        "Wrap the entry point in withRequestDb.",
    );
  }
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
    const db = getScopedOrGlobal<AppDb>("appDb", "__piyazAppDb", buildAppPool);
    return Reflect.get(db, prop, receiver);
  },
});

/**
 * Lazily initialized Better-auth Drizzle client.
 *
 * Same driver-selection and caching semantics as {@link appDb} but bound
 * to the `piyaz_auth` schema used by `drizzleAdapter` in {@link auth}.
 */
export const authDb = new Proxy({} as AuthDb, {
  get(_target, prop, receiver) {
    const db = getScopedOrGlobal<AuthDb>(
      "authDb",
      "__piyazAuthDb",
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
      "__piyazServiceRoleDb",
      buildServicePool,
    );
    return Reflect.get(db, prop, receiver);
  },
});
