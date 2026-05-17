import { expect } from "bun:test";

/**
 * Drop-in replacement for `expect(query).rejects.toThrow(regex)` when
 * `query` is a postgres-js Query (the thenable returned by `sql\`...\``
 * or `sql.unsafe(...)`). Bun's `expect.rejects` does NOT terminate on
 * postgres-js Query objects — the awaited assertion hangs until the
 * test's wall-clock timeout fires.
 *
 * Reason: postgres-js Queries are thenable but not actual Promises; the
 * Bun expect-rejects path attaches a handler that postgres-js's Query
 * shape never invokes. A direct `await` in a try/catch DOES drain the
 * thenable correctly, which is what this helper does internally.
 *
 * @param query - Awaitable that should reject (postgres-js Query).
 * @param pattern - Regex the caught error's message must match.
 * @throws Error when the query resolves instead of rejecting.
 */
export async function expectQueryRejects(
  query: PromiseLike<unknown>,
  pattern: RegExp,
): Promise<void> {
  let resolved = false;
  try {
    await query;
    resolved = true;
  } catch (e) {
    expect((e as Error).message).toMatch(pattern);
    return;
  }
  if (resolved) {
    throw new Error(
      `expectQueryRejects: expected rejection matching ${pattern.source}, ` +
        `but the query resolved successfully.`,
    );
  }
}
