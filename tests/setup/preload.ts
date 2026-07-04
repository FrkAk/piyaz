import { mock } from "bun:test";

// Better Auth refuses to boot in production without a non-default secret;
// any non-default value satisfies the validator. `??=` preserves a real
// secret if the developer has loaded `.env.local` into this shell.
process.env.BETTER_AUTH_SECRET ??=
  "test-only-secret-not-used-outside-this-suite-0000";
// BA emits a base-URL warning otherwise; harmless but noisy in test logs.
process.env.BETTER_AUTH_URL ??= "https://example.test";

/**
 * Force `NODE_ENV=production` at the test process boundary.
 *
 * Bun defaults to `NODE_ENV=test`. `lib/auth.ts:45` evaluates
 * `process.env.NODE_ENV === "production"` inside `betterAuth({...})`
 * at module instantiation, so the value at preload time is the value
 * BA freezes into `useSecureCookies`. This also matches the deployed
 * Cloudflare Worker runtime, where `NODE_ENV` is `"production"` —
 * tests therefore exercise the same gate the deployed app will see.
 *
 * Consumers that branch on NODE_ENV (`lib/api/error.ts`,
 * `lib/graph/tools/shared.ts`, `lib/mcp/create-server.ts`) all gate
 * verbose output on `=== "development"`, so production is the
 * fail-safe default. `tests/api/error.test.ts` mutates per-test via
 * `Object.defineProperty` and restores in `afterEach`.
 *
 * Uses `Object.defineProperty` (matching `tests/api/error.test.ts:9`)
 * so the assignment is type-safe under `@types/node` ≥ 20 where
 * `NODE_ENV` is declared `readonly`.
 */
Object.defineProperty(process.env, "NODE_ENV", {
  value: "production",
  configurable: true,
});

// Load-bearing invariant guard. If a future contributor flips
// `NODE_ENV` higher up the load order (e.g. via a `bun --define` or
// an additional preload), cookie tests would silently lose the
// `Secure` / `__Secure-` flags and the failure would look like a BA
// regression. Fail loud here instead.
if (process.env.NODE_ENV !== "production") {
  throw new Error(
    `tests/setup/preload.ts requires NODE_ENV=production at boot; ` +
      `got ${JSON.stringify(process.env.NODE_ENV)}. ` +
      `lib/auth.ts:45 evaluates this once at module load and bakes ` +
      `useSecureCookies into the auth instance.`,
  );
}

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

(
  globalThis as unknown as { __setTestSession: typeof setTestSession }
).__setTestSession = setTestSession;

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
