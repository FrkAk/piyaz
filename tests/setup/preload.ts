import { mock } from "bun:test";

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

import { setup, teardown } from "./global";
import { beforeAll, afterAll, afterEach } from "bun:test";

beforeAll(async () => {
  await setup();
}, 120000);

afterAll(async () => {
  await teardown();
}, 30000);

// Hard reset between tests so a 200-path leak can't authenticate the next
// 401-path test.
afterEach(() => {
  currentTestSession = null;
});
