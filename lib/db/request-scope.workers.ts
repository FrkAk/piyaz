import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  buildAppPool,
  buildAuthPool,
  buildServicePool,
} from "./_driver.workers";
import { requestDbStore } from "./connection";

/**
 * Wrap a request-scoped operation with per-request Pool lifecycle.
 *
 * Cloudflare Workers cannot persist WebSocket connections beyond a single
 * request, so the Neon `Pool` for each role must be created inside the
 * handler and closed before the response is fully delivered. This helper
 * builds fresh Drizzle clients for the three roles, runs `fn` inside an
 * AsyncLocalStorage frame so the proxy exports in `./connection.ts`
 * resolve to those clients, and schedules `pool.end()` via
 * `ctx.waitUntil` so socket teardown does not block the response.
 *
 * @param fn - The request-handler body.
 * @returns Whatever `fn` returns.
 */
export async function withRequestDb<T>(fn: () => Promise<T>): Promise<T> {
  const { ctx } = getCloudflareContext();
  const appBundle = buildAppPool();
  const authBundle = buildAuthPool();
  const serviceBundle = buildServicePool();

  try {
    return await requestDbStore.run(
      {
        appDb: appBundle.db,
        authDb: authBundle.db,
        serviceRoleDb: serviceBundle.db,
      },
      fn,
    );
  } finally {
    ctx.waitUntil(Promise.resolve(appBundle.pool.end()));
    ctx.waitUntil(Promise.resolve(authBundle.pool.end()));
    ctx.waitUntil(Promise.resolve(serviceBundle.pool.end()));
  }
}
