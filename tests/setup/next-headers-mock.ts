/**
 * Shared factory for `mock.module("next/headers", nextHeadersMockModule)`
 * in test files that drive Better Auth or server actions outside a Next
 * request scope.
 *
 * `headers()` resolves to an empty `Headers` so session lookups and
 * rate-limit IP extraction run without a request. `cookies()` throws BA's
 * recognized out-of-scope message: the `nextCookies()` plugin (last in
 * `lib/auth.ts`) probes `cookies()` on every BA response, and its guard
 * only swallows this exact message — a missing export or a different
 * error rethrows and 500s unrelated auth tests in the same process.
 * Keeping the message here, in one place, pins that coupling to BA's
 * guard string.
 *
 * @returns Module shape for `mock.module("next/headers", ...)`.
 */
export function nextHeadersMockModule(): {
  headers: () => Promise<Headers>;
  cookies: () => Promise<never>;
} {
  return {
    headers: async () => new Headers(),
    cookies: async () => {
      throw new Error(
        "`cookies` was called outside a request scope. (test mock)",
      );
    },
  };
}
