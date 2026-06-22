import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestScopedDb } from "./connection";

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
 *
 * Lives in its own module (not `./connection.ts`) so the wrangler-esbuild
 * bundle can reach the store through `request-scope.workers.ts` without
 * dragging `./connection.ts`'s `@/lib/db/_driver` import — which resolves
 * to the postgres-js Node driver outside the webpack alias — into the
 * Workers artifact. `./connection.ts` re-exports it, so the import surface
 * for tests and app code is unchanged.
 */
const REQUEST_DB_STORE_KEY = Symbol.for("@piyaz/db/requestDbStore");
const symbolKeyedGlobal = globalThis as Record<symbol, unknown>;
if (!symbolKeyedGlobal[REQUEST_DB_STORE_KEY]) {
  symbolKeyedGlobal[REQUEST_DB_STORE_KEY] =
    new AsyncLocalStorage<RequestScopedDb>();
}
export const requestDbStore = symbolKeyedGlobal[
  REQUEST_DB_STORE_KEY
] as AsyncLocalStorage<RequestScopedDb>;

/**
 * Register fire-and-forget work that must finish before the request's DB
 * pools are torn down on Workers.
 *
 * Detached promises (e.g. a diagnostic query deliberately kept off the
 * response path) would otherwise race the body-gated `pool.end()` and
 * reject against an ended pool. Registered work is settled by the request
 * teardown before any pool ends. Without an active frame (self-host, no
 * `withRequestDb` wrapper) this is a no-op and the promise stays
 * fire-and-forget, matching pre-Workers behavior.
 *
 * @param work - Promise to settle before the request's pools are ended.
 */
export function deferRequestWork(work: Promise<unknown>): void {
  requestDbStore.getStore()?.deferred?.add(work);
}
