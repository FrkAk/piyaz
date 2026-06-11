import "server-only";

/**
 * Self-host builds resolve DB clients from the `globalThis` singleton when
 * no frame is active; the unscoped-access guard in `./connection.ts` stays
 * off. The Workers sibling exports `true`, riding the same webpack alias
 * that selects the driver.
 */
export const requiresRequestScope = false;

/**
 * Outcome of running a request body inside the per-request DB scope.
 * Shared shape across both deploy targets so callers compile against
 * either implementation of the `request-scope` indirection.
 */
export interface RequestDbOutcome<T> {
  /** Whatever the wrapped request body returned. */
  result: T;
  /**
   * Release the request's DB resources. Idempotent. On self-host this is
   * a no-op (pools are `globalThis`-cached and reused across requests);
   * on Workers it ends every request-scoped Neon Pool.
   */
  teardown: () => Promise<void>;
}

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
 * @returns The body's result plus a no-op teardown.
 */
export async function withRequestDb<T>(
  fn: () => Promise<T>,
): Promise<RequestDbOutcome<T>> {
  return { result: await fn(), teardown: async () => {} };
}
