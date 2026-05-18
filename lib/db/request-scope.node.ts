import "server-only";

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
