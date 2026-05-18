import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { AppDb, AuthDb, ClosablePool, DbBundle } from "./_driver.node";
import {
  buildAppPool,
  buildAuthPool,
  buildServicePool,
} from "./_driver.workers";
import {
  type AppUserConn,
  type RequestScopedDb,
  type ServiceRoleConn,
  requestDbStore,
} from "./connection";

/**
 * Minimal `ctx.waitUntil` shape used by {@link withRequestDbCore}. Defined
 * locally so the file does not depend on `@cloudflare/workers-types`
 * (forbidden by `eslint.config.mjs`: pulling its ambient declarations
 * clobbers DOM `Request`/`Response`).
 */
interface RequestCtx {
  waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Bundle of per-role pool factories injected into {@link withRequestDbCore}.
 * The production wrapper passes the real `_driver.workers` builders; tests
 * substitute fakes that return sentinel `db` handles and instrumented
 * `pool.end()` implementations.
 */
export interface PoolBuilders {
  buildAppPool: () => DbBundle<AppDb>;
  buildAuthPool: () => DbBundle<AuthDb>;
  buildServicePool: () => DbBundle<AppDb>;
}

/**
 * Build the three role pools, closing any already-created pool if a later
 * builder throws. Returns a {@link RequestScopedDb} ready for ALS seeding
 * plus the underlying pools so the caller can schedule `pool.end()` after
 * the body completes.
 *
 * @param builders - Per-role pool factories.
 * @returns Pools plus the matching `db` clients keyed by role.
 * @throws Whatever a builder throws, with previously-built pools already
 *   scheduled for teardown via {@link closePoolsAfterError}.
 */
function buildRolePools(builders: PoolBuilders): {
  pools: ClosablePool[];
  scoped: RequestScopedDb;
} {
  const opened: ClosablePool[] = [];
  try {
    const app = builders.buildAppPool();
    opened.push(app.pool);
    const auth = builders.buildAuthPool();
    opened.push(auth.pool);
    const service = builders.buildServicePool();
    opened.push(service.pool);
    return {
      pools: opened,
      scoped: {
        appDb: app.db as AppUserConn,
        authDb: auth.db,
        serviceRoleDb: service.db as ServiceRoleConn,
      },
    };
  } catch (err) {
    closePoolsAfterError(opened);
    throw err;
  }
}

/**
 * Close pools that were opened before a later builder threw. Fire-and-forget
 * by design: if `end()` rejects the only sane outlet is the log, since the
 * surrounding control flow is already unwinding the original failure.
 *
 * @param pools - Pools to close.
 */
function closePoolsAfterError(pools: ClosablePool[]): void {
  for (const pool of pools) {
    void pool.end().catch((err) => {
      console.error("[db] pool cleanup after build failure failed", err);
    });
  }
}

/**
 * Schedule `pool.end()` for every role pool through a single `ctx.waitUntil`
 * registration so one promise tracks the entire teardown. Halves the
 * `waitUntil` bookkeeping vs registering three independent promises and
 * keeps the response-blocking budget tight.
 *
 * @param ctx - Cloudflare execution context.
 * @param pools - Pools opened for this request.
 */
function schedulePoolTeardown(ctx: RequestCtx, pools: ClosablePool[]): void {
  ctx.waitUntil(
    Promise.allSettled(pools.map((pool) => pool.end())).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("[db] pool end failed", result.reason);
        }
      }
    }),
  );
}

/**
 * Testable core of {@link withRequestDb}. Takes the Cloudflare execution
 * context and the three pool factories as inputs so unit tests can
 * exercise the lifecycle without booting OpenNext or the Neon driver.
 *
 * Builds fresh Drizzle clients for the three roles via
 * {@link buildRolePools} (which guarantees no leaked pools if a later
 * builder throws), runs `fn` inside an AsyncLocalStorage frame so the
 * proxy exports in `./connection.ts` resolve to those clients, and
 * schedules `pool.end()` for every pool via a single `ctx.waitUntil` so
 * socket teardown does not block the response and only one promise is
 * tracked.
 *
 * @param ctx - Cloudflare execution context exposing `waitUntil`.
 * @param builders - Per-role pool factories.
 * @param fn - The request-handler body.
 * @returns Whatever `fn` returns.
 */
export async function withRequestDbCore<T>(
  ctx: RequestCtx,
  builders: PoolBuilders,
  fn: () => Promise<T>,
): Promise<T> {
  const { pools, scoped } = buildRolePools(builders);
  try {
    return await requestDbStore.run(scoped, fn);
  } finally {
    schedulePoolTeardown(ctx, pools);
  }
}

/**
 * Wrap a request-scoped operation with per-request Pool lifecycle.
 *
 * Cloudflare Workers cannot persist WebSocket connections beyond a single
 * request, so the Neon `Pool` for each role must be created inside the
 * handler and closed before the response is fully delivered. Thin wrapper
 * over {@link withRequestDbCore} that wires in the live Cloudflare context
 * and the real Neon pool builders from `./_driver.workers`.
 *
 * @param fn - The request-handler body.
 * @returns Whatever `fn` returns.
 */
export async function withRequestDb<T>(fn: () => Promise<T>): Promise<T> {
  const { ctx } = getCloudflareContext();
  return withRequestDbCore(
    ctx,
    { buildAppPool, buildAuthPool, buildServicePool },
    fn,
  );
}

/**
 * Lazy auto-seed entry point for the {@link requestDbStore} proxy fallback.
 *
 * Called from `./connection.ts:getScopedOrGlobal` on Cloudflare Workers
 * when a route reads `appDb` / `authDb` / `serviceRoleDb` outside an
 * explicit {@link withRequestDb} frame. Builds the three role pools,
 * registers a single `ctx.waitUntil(pool.end())` for teardown, then uses
 * `AsyncLocalStorage.enterWith` to seed the frame for the rest of the
 * request's async tree.
 *
 * Each Workers fetch invocation runs in its own root async context, so
 * `enterWith` cannot leak the seeded store across requests. Callers that
 * still want explicit scoping (e.g. background tasks that share a fetch
 * handler) can wrap with {@link withRequestDb} directly.
 *
 * @returns The seeded scope (also entered into the ALS frame).
 * @throws Error when `getCloudflareContext()` is unavailable — running on
 *   Workers without an active fetch context (scheduled handler, DO alarm,
 *   etc.) means we cannot register `pool.end()` for teardown, and
 *   silently seeding without teardown would leak sockets across
 *   invocations. The caller is expected to wrap with {@link withRequestDb}
 *   explicitly in those contexts.
 */
export function autoSeedRequestDb(): RequestScopedDb {
  let ctx: RequestCtx;
  try {
    ctx = getCloudflareContext({ async: false }).ctx;
  } catch (err) {
    throw new Error(
      "autoSeedRequestDb: Cloudflare execution context is unavailable " +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        "This usually means a non-fetch Workers handler (scheduled, alarm, " +
        "queue consumer) accessed appDb/authDb/serviceRoleDb without " +
        "wrapping the body in withRequestDb(() => ...).",
    );
  }
  const { pools, scoped } = buildRolePools({
    buildAppPool,
    buildAuthPool,
    buildServicePool,
  });
  schedulePoolTeardown(ctx, pools);
  requestDbStore.enterWith(scoped);
  return scoped;
}
