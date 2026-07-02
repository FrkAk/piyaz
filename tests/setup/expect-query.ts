import { expect } from "bun:test";
import type postgres from "postgres";
import { appUserConnect } from "./seed";

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

/**
 * Run `work` as `app_user` with `app.user_id` set to `userId`, and capture the
 * rejection's `{ message, code }`. The SQLSTATE (`code`) is what distinguishes
 * a trigger rejection (23514) from an RLS WITH CHECK rejection (42501), so
 * tests assert the code, not just a message substring. Drains the postgres-js
 * thenable via a direct try/await like `expectQueryRejects` above (Bun's
 * `expect.rejects` hangs on it).
 *
 * @param userId - Value for the `app.user_id` GUC.
 * @param work - Statements to run inside the RLS-scoped transaction.
 * @returns The caught error's message and SQLSTATE code.
 * @throws Error when `work` resolves instead of rejecting.
 */
export async function captureAppUserError(
  userId: string,
  work: (tx: postgres.TransactionSql) => Promise<unknown>,
): Promise<{ message: string; code: string | undefined }> {
  const c = appUserConnect();
  try {
    await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await work(tx);
    });
  } catch (err) {
    const e = err as { message: string; code?: string };
    return { message: e.message, code: e.code };
  }
  throw new Error("expected the statement to reject, but it succeeded");
}
