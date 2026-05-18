import "server-only";
import type { RequestScopedDb } from "./connection";

/**
 * Self-host no-op for the per-request DB seeding helper.
 *
 * On Node / Docker self-host, the globalThis-cached pools in
 * `./connection.ts` are reused across requests, so the per-request
 * lifecycle wrapper degenerates to invoking the body directly. The Workers
 * build replaces this implementation via webpack alias with the real
 * version in `./request-scope.workers.ts`.
 *
 * @param fn - The request-handler body.
 * @returns Whatever `fn` returns.
 */
export async function withRequestDb<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

/**
 * Self-host stub for {@link autoSeedRequestDb}. The connection proxy uses
 * the globalThis fallback on self-host and never reaches the lazy seeder,
 * so this body must never execute. Throwing rather than no-op keeps a
 * misrouted call surfacing instead of silently corrupting state.
 *
 * @throws Always.
 */
export function autoSeedRequestDb(): RequestScopedDb {
  throw new Error(
    "autoSeedRequestDb is Workers-only; the self-host build should never " +
      "call it (the connection proxy uses the globalThis cache). If you " +
      "see this on self-host, the webpack alias indirection is broken.",
  );
}
