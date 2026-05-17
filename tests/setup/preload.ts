import { mock } from "bun:test";

// Better Auth refuses to boot in production without a non-default secret;
// any non-default value satisfies the validator. `??=` preserves a real
// secret if the developer has loaded `.env.local` into this shell.
process.env.BETTER_AUTH_SECRET ??=
  "test-only-secret-not-used-outside-this-suite-0000";
// BA emits a base-URL warning otherwise; harmless but noisy in test logs.
process.env.BETTER_AUTH_URL ??= "https://example.test";

// Bun sets `NODE_ENV=test` by default. Force production at the test
// process boundary so `betterAuth({...})` in `lib/auth.ts:45` initializes
// `useSecureCookies: true` regardless of which test file imports
// `@/lib/auth` first. The only test that asserts on NODE_ENV at request
// time is `tests/api/error.test.ts`, which mutates per-test and restores
// in `afterEach` — so a production baseline does not change observable
// behavior anywhere except cookie tests, which expect it.
// @ts-expect-error NODE_ENV is readonly in @types/node
process.env.NODE_ENV = "production";

// Neutralize `server-only` so lib/ modules can be imported in the test process.
mock.module("server-only", () => ({}));

/**
 * Mutable test-session container. Tests flip `currentTestSession` via
 * {@link setTestSession} (or the equivalent globalThis hook) to drive the
 * route's `getAuthContext` without forcing a module re-import. The mocked
 * session functions close over THIS variable, so swapping it is enough —
 * no cache-busting query strings on the dynamic route imports.
 */
type TestSession = { user: { id: string } } | null;
let currentTestSession: TestSession = null;

/**
 * Override the test session. Pass `null` to simulate an unauthenticated
 * caller (the default).
 *
 * Exposed on `globalThis.__setTestSession` so test files can reach it
 * without crossing the `tests/setup` import boundary in their imports.
 *
 * @param session - The stub session, or null to clear.
 */
export function setTestSession(session: TestSession): void {
  currentTestSession = session;
}

(globalThis as unknown as { __setTestSession: typeof setTestSession })
  .__setTestSession = setTestSession;

// Stub Better Auth initialization to prevent URL-parse errors in test process.
// The factory closes over `currentTestSession` so `setTestSession` updates
// are seen by every subsequent `requireSession()` call.
mock.module("@/lib/auth/session", () => ({
  getSession: async () => currentTestSession,
  requireSession: async () => {
    if (!currentTestSession) {
      throw new Error("requireSession is not available in tests");
    }
    return currentTestSession;
  },
}));

import { setup } from "./global";
import { beforeAll, afterEach } from "bun:test";

beforeAll(async () => {
  await setup();
}, 120000);

// Hard reset between tests so a 200-path leak can't authenticate the next
// 401-path test.
afterEach(() => {
  currentTestSession = null;
});
