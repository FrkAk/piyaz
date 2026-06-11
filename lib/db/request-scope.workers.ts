import "server-only";

import {
  buildAppHttp,
  buildAppPool,
  buildAuthHttp,
  buildAuthPool,
  buildServiceHttp,
  buildServicePool,
} from "./_driver.workers";
import type { ClosablePool, DbBundle } from "./_driver.node";
import type {
  AppUserConn,
  RequestScopedDb,
  ServiceRoleConn,
} from "./connection";
import { requestDbStore } from "./request-store";
import type { RequestDbOutcome } from "./request-scope.node";

export type { RequestDbOutcome } from "./request-scope.node";

/**
 * Workers builds resolve DB clients exclusively from the request frame;
 * the unscoped-access guard in `./connection.ts` throws without one. Rides
 * the same webpack alias that selects the Workers driver, so the guard
 * cannot be disabled by a missing runtime var.
 */
export const requiresRequestScope = true;

/**
 * Worker DB connection strings supplied by Cloudflare bindings. Fields are
 * optional because bindings can be absent (e.g. `wrangler dev` without
 * secrets); each pool builder falls back to its `process.env` default —
 * populated from the same bindings under `nodejs_compat` — and throws its
 * own role error when both sources are missing, on first use of that role.
 */
export interface WorkerDbUrls {
  /** Application runtime role connection string. */
  databaseUrl?: string;
  /** Better-auth schema role connection string. */
  databaseAuthUrl?: string;
  /** Service role connection string. */
  databaseServiceRoleUrl?: string;
}

/**
 * Per-request pool registry drained by teardown.
 *
 * `sealed` flips just before teardown snapshots `pools` — after the
 * deferred-work settlement window, so deferred work may still build pools
 * that teardown picks up, but any later first-build throws instead of
 * minting a pool nothing would ever end.
 */
interface PoolRegistry {
  /** Role-labelled pools built for this request. */
  pools: Array<{ role: string; pool: ClosablePool }>;
  /** True once teardown has snapshotted `pools`; late builds must throw. */
  sealed: boolean;
}

/**
 * Single-flight lazy accessor for one role's Drizzle client.
 *
 * The pool is constructed (and its URL validated) on first access and
 * registered for teardown; roles a request never touches build nothing, so
 * a misconfigured binding only fails the paths that use that role and the
 * BYPASSRLS client is not materialized on every request. Once the registry
 * is sealed a first-build throws: a pool created after the teardown
 * snapshot would never be closed and would silently recreate the
 * dead-I/O-context WebSocket bug per-request pools exist to fix.
 *
 * @param role - Role label for the teardown registry and error messages.
 * @param build - Role bundle factory from the workers driver.
 * @param registry - Request pool registry the teardown drains.
 * @returns Accessor returning the memoized Drizzle client.
 * @throws Error on first access after the registry is sealed.
 */
function lazyRole<TDb>(
  role: string,
  build: () => DbBundle<TDb>,
  registry: PoolRegistry,
): () => TDb {
  let db: TDb | undefined;
  return () => {
    if (db === undefined) {
      if (registry.sealed) {
        throw new Error(
          `Request DB scope is torn down: a new "${role}" pool built now ` +
            "would never be closed. Register detached work with " +
            "deferRequestWork before the response body completes.",
        );
      }
      const bundle = build();
      registry.pools.push({ role, pool: bundle.pool });
      db = bundle.db;
    }
    return db;
  };
}

/**
 * Single-flight lazy accessor for one role's neon-http read client.
 *
 * HTTP clients are stateless — every batch is one self-contained fetch —
 * so unlike {@link lazyRole} there is no pool registry, no teardown
 * registration, and no seal check. A read fired after the response body
 * completes is still the documented `deferRequestWork` landmine (the
 * Workers I/O context may be gone), but it cannot leak a connection.
 *
 * @param build - Role HTTP client factory from the workers driver.
 * @returns Accessor returning the memoized client.
 */
function lazyHttpRole<TDb>(build: () => TDb): () => TDb {
  let db: TDb | undefined;
  return () => {
    if (db === undefined) db = build();
    return db;
  };
}

/**
 * Grace period held after `pool.end()` so WebSocket close handshakes
 * finish inside a live request context.
 *
 * `pool.end()` resolves before the WS close round-trip completes; if the
 * teardown promise settles immediately, `waitUntil` releases the context
 * and workerd severs the half-closed sockets — surfacing as uncaught
 * "Network connection lost" errors because the Neon shim re-emits the
 * failure on a deferred tick against a client `end()` already removed
 * from the pool. 100ms covers the close round-trip; the cost is idle
 * `waitUntil` wall time after the response, never user-facing latency.
 */
const WS_CLOSE_GRACE_MS = 100;

/**
 * Settle deferred request work, then seal the registry and end every pool.
 *
 * Never rejects: `pool.end()` failures are logged as structured
 * `neon_pool_teardown_error` events so the `waitUntil` chain cannot
 * surface unhandled rejections and the error path cannot mask the
 * request's own failure. Deferred work settles first (single pass) so
 * detached queries finish before their pools close; the registry is sealed
 * and snapshotted after that await, picking up any pool the deferred work
 * built while making any later first-build throw in `lazyRole`. When at
 * least one pool was built, the context is held for
 * {@link WS_CLOSE_GRACE_MS} after `end()` so the close handshakes drain
 * cleanly instead of being severed at context teardown.
 *
 * @param deferred - Promises registered via `deferRequestWork`.
 * @param registry - Request pool registry; sealed here.
 */
async function settleAndEnd(
  deferred: ReadonlySet<Promise<unknown>>,
  registry: PoolRegistry,
): Promise<void> {
  if (deferred.size > 0) {
    await Promise.allSettled(deferred);
  }
  registry.sealed = true;
  const entries = [...registry.pools];
  const results = await Promise.allSettled(
    entries.map(({ pool }) => pool.end()),
  );
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(
        JSON.stringify({
          event: "neon_pool_teardown_error",
          role: entries[index].role,
          message:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        }),
      );
    }
  });
  if (entries.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, WS_CLOSE_GRACE_MS));
  }
}

/**
 * Workers implementation of the per-request DB scope.
 *
 * Exposes lazy single-flight role accessors through a `requestDbStore` ALS
 * frame so the `appDb` / `authDb` / `serviceRoleDb` proxies resolve to the
 * request's own clients, building each role's Neon Pool on first access.
 * Returns a memoized teardown that settles `deferRequestWork` promises and
 * then ends every built pool; it never rejects (failures are logged), so
 * the error path below cannot replace the request's own failure. Teardown
 * is NOT invoked here: when to end pools depends on the response body
 * lifecycle (`scheduleRequestDbTeardown`), which only the worker entry can
 * see. If `fn` throws, teardown runs before rethrowing.
 *
 * @param fn - The request-handler body.
 * @param urls - Explicit Cloudflare binding DB URLs; see {@link WorkerDbUrls}.
 * @returns The body's result plus the idempotent pool teardown.
 * @throws Whatever `fn` throws, after the request's pools are ended.
 */
export async function withRequestDb<T>(
  fn: () => Promise<T>,
  urls?: WorkerDbUrls,
): Promise<RequestDbOutcome<T>> {
  const registry: PoolRegistry = { pools: [], sealed: false };
  const deferred = new Set<Promise<unknown>>();
  const app = lazyRole("app", () => buildAppPool(urls?.databaseUrl), registry);
  const auth = lazyRole(
    "auth",
    () => buildAuthPool(urls?.databaseAuthUrl),
    registry,
  );
  const service = lazyRole(
    "service",
    () => buildServicePool(urls?.databaseServiceRoleUrl),
    registry,
  );
  const appRead = lazyHttpRole(() => buildAppHttp(urls?.databaseUrl));
  const authRead = lazyHttpRole(() => buildAuthHttp(urls?.databaseAuthUrl));
  const serviceRead = lazyHttpRole(() =>
    buildServiceHttp(urls?.databaseServiceRoleUrl),
  );

  let ending: Promise<void> | undefined;
  const teardown = (): Promise<void> => {
    ending ??= settleAndEnd(deferred, registry);
    return ending;
  };

  const frame: RequestScopedDb = {
    get appDb() {
      return app() as AppUserConn;
    },
    get authDb() {
      return auth();
    },
    get serviceRoleDb() {
      return service() as ServiceRoleConn;
    },
    get appDbRead() {
      return appRead();
    },
    get authDbRead() {
      return authRead();
    },
    get serviceRoleDbRead() {
      return serviceRead();
    },
    deferred,
  };

  try {
    const result = await requestDbStore.run(frame, fn);
    return { result, teardown };
  } catch (error) {
    await teardown();
    throw error;
  }
}

/** Constructor shape shared by `IdentityTransformStream` and `TransformStream`. */
type IdentityStreamCtor = new () => {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

/**
 * workerd's native C++ pass-through stream when available (production),
 * falling back to the spec `TransformStream` elsewhere (bun tests, Node).
 * The native stream avoids per-chunk JS dispatch on every streamed byte.
 */
const IdentityStream: IdentityStreamCtor =
  (globalThis as { IdentityTransformStream?: IdentityStreamCtor })
    .IdentityTransformStream ?? (TransformStream as IdentityStreamCtor);

/**
 * Schedule pool teardown for after the response is fully delivered.
 *
 * `pool.end()` starts draining immediately and rejects any later
 * `connect()` with "Cannot use a pool after calling end", while
 * `openNextHandler.fetch` resolves as soon as the Response object exists —
 * RSC/HTML bodies keep streaming (and keep issuing queries) after that.
 * Ending pools at handler return would kill in-flight rendering queries,
 * so the body is piped through an identity stream and teardown runs only
 * once the source closes or the consumer cancels. On consumer cancel the
 * render may still be mid-query; its rejections are logged, not surfaced —
 * the client is gone. Every bodied response is wrapped (even ones that
 * built no pool yet) because lazily-built pools can appear mid-stream.
 *
 * Null-body responses (204/3xx/HEAD) tear down immediately. WebSocket
 * upgrade responses (status 101 / `webSocket` set) are returned untouched
 * because wrapping the body would break the upgrade; the Durable Object
 * broker path behind them does not use these pools.
 *
 * @param response - Response produced inside the `withRequestDb` frame.
 * @param teardown - Idempotent, non-rejecting teardown from
 *   {@link withRequestDb}.
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

  const { readable, writable } = new IdentityStream();
  const bodyDone = response.body.pipeTo(writable).catch(() => undefined);
  waitUntil(bodyDone.then(teardown));
  return new Response(readable, response);
}
