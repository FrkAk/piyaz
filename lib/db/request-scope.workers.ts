import "server-only";

import {
  buildAppPool,
  buildAuthPool,
  buildServicePool,
} from "./_driver.workers";
import type {
  AppUserConn,
  RequestScopedDb,
  ServiceRoleConn,
} from "./connection";
import { requestDbStore } from "./request-store";
import type { RequestDbOutcome } from "./request-scope.node";

export type { RequestDbOutcome } from "./request-scope.node";

/**
 * Workers implementation of the per-request DB scope.
 *
 * Builds a fresh Neon Pool per role, runs `fn` inside a `requestDbStore`
 * ALS frame so the `appDb` / `authDb` / `serviceRoleDb` proxies resolve to
 * the request's own clients, and returns a teardown that ends every pool.
 * Teardown is NOT invoked here: when to end pools depends on the response
 * body lifecycle (`scheduleRequestDbTeardown`), which only the worker
 * entry can see. If `fn` throws, the pools are ended before rethrowing so
 * a failed request cannot leak WebSocket connections.
 *
 * The teardown is memoized — the vendored pg BoundPool rejects a second
 * `end()` with "Called end on pool more than once", so repeat calls reuse
 * the first promise.
 *
 * @param fn - The request-handler body.
 * @returns The body's result plus the idempotent pool teardown.
 * @throws Whatever `fn` throws, after ending the request's pools.
 */
export async function withRequestDb<T>(
  fn: () => Promise<T>,
): Promise<RequestDbOutcome<T>> {
  const app = buildAppPool();
  const auth = buildAuthPool();
  const service = buildServicePool();
  const pools = [app.pool, auth.pool, service.pool];

  let ending: Promise<void> | undefined;
  const teardown = (): Promise<void> => {
    ending ??= Promise.all(pools.map((pool) => pool.end())).then(
      () => undefined,
    );
    return ending;
  };

  const frame: RequestScopedDb = {
    appDb: app.db as AppUserConn,
    authDb: auth.db,
    serviceRoleDb: service.db as ServiceRoleConn,
  };

  try {
    const result = await requestDbStore.run(frame, fn);
    return { result, teardown };
  } catch (error) {
    await teardown();
    throw error;
  }
}

/**
 * Schedule pool teardown for after the response is fully delivered.
 *
 * `pool.end()` starts draining immediately and rejects any later
 * `connect()` with "Cannot use a pool after calling end", while
 * `openNextHandler.fetch` resolves as soon as the Response object exists —
 * RSC/HTML bodies keep streaming (and keep issuing queries) after that.
 * Ending pools at handler return would kill in-flight rendering queries,
 * so the body is piped through an identity `TransformStream` and teardown
 * runs only once the source closes or the consumer cancels.
 *
 * Null-body responses (204/3xx/HEAD) tear down immediately. WebSocket
 * upgrade responses (status 101 / `webSocket` set) are returned untouched
 * because wrapping the body would break the upgrade; the Durable Object
 * broker path behind them does not use these pools.
 *
 * @param response - Response produced inside the `withRequestDb` frame.
 * @param teardown - Idempotent pool teardown from {@link withRequestDb}.
 * @param waitUntil - `ctx.waitUntil` (or equivalent) to extend the request
 *   lifetime until teardown settles.
 * @returns The response to return to the client (body-wrapped when it
 *   streams, the original instance otherwise).
 */
export function scheduleRequestDbTeardown(
  response: Response,
  teardown: () => Promise<void>,
  waitUntil: (promise: Promise<unknown>) => void,
): Response {
  const upgraded =
    response.status === 101 ||
    (response as { webSocket?: unknown }).webSocket != null;
  if (upgraded || response.body === null) {
    waitUntil(teardown());
    return response;
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const bodyDone = response.body.pipeTo(writable).catch(() => undefined);
  waitUntil(bodyDone.then(teardown));
  return new Response(readable, response);
}
