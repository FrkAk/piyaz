import "server-only";

/**
 * Workers-side counterpart to {@link ./request-scope.node:withRequestDb}.
 *
 * The Workers DB pool is a per-isolate singleton with single-use
 * connections (`maxUses: 1`), so request scoping happens at the
 * connection level inside `lib/db/_driver.workers.ts`; this wrapper is a
 * pass-through identical to the Node sibling. Kept exported so callers
 * compile against both targets without target-specific imports.
 *
 * @param fn - The request-handler body.
 * @returns Whatever `fn` returns.
 */
export async function withRequestDb<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}
