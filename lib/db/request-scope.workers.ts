import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { AppDb, AuthDb, DbBundle } from "./_driver.node";
import {
  buildAppPool,
  buildAuthPool,
  buildServicePool,
} from "./_driver.workers";
import {
  type AppUserConn,
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
 * Testable core of {@link withRequestDb}. Takes the Cloudflare execution
 * context and the three pool factories as inputs so unit tests can
 * exercise the lifecycle without booting OpenNext or the Neon driver.
 *
 * Builds fresh Drizzle clients for the three roles, runs `fn` inside an
 * AsyncLocalStorage frame so the proxy exports in `./connection.ts`
 * resolve to those clients, and schedules `pool.end()` via
 * `ctx.waitUntil` so socket teardown does not block the response. The
 * `.catch` on each `end()` swallows rejections into a `console.error`
 * line instead of leaving them as unhandled rejections inside
 * `waitUntil`.
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
  const appBundle = builders.buildAppPool();
  const authBundle = builders.buildAuthPool();
  const serviceBundle = builders.buildServicePool();

  try {
    return await requestDbStore.run(
      {
        appDb: appBundle.db as AppUserConn,
        authDb: authBundle.db,
        serviceRoleDb: serviceBundle.db as ServiceRoleConn,
      },
      fn,
    );
  } finally {
    ctx.waitUntil(
      appBundle.pool
        .end()
        .catch((err) => console.error("[db] app pool end failed", err)),
    );
    ctx.waitUntil(
      authBundle.pool
        .end()
        .catch((err) => console.error("[db] auth pool end failed", err)),
    );
    ctx.waitUntil(
      serviceBundle.pool
        .end()
        .catch((err) => console.error("[db] service pool end failed", err)),
    );
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
