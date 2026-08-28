import { mock } from "bun:test";

// Better Auth refuses to boot in production without a non-default secret;
// any non-default value satisfies the validator. `??=` preserves a real
// secret if the developer has loaded `.env.local` into this shell.
process.env.BETTER_AUTH_SECRET ??=
  "test-only-secret-not-used-outside-this-suite-0000";
// BA emits a base-URL warning otherwise; harmless but noisy in test logs.
process.env.BETTER_AUTH_URL ??= "https://example.test";
// A Turnstile secret inherited from the shell (deploy rehearsal, future CI)
// would arm the captcha plugin in every auth instance built by the suite and
// fail unrelated handler tests with MISSING_RESPONSE. The suite always runs
// captcha-off; tests that exercise the plugin set the secret themselves.
delete process.env.TURNSTILE_SECRET_KEY;

// Name a proxy header so the suite resolves a per-request client address
// instead of collapsing every caller into the one shared untrusted bucket.
// Auth test files each own a `127.0.x.x` range to keep their rate-limit
// buckets isolated from one another, which only works while an address
// resolves. `tests/security/client-ip.test.ts` unsets this to exercise the
// shipping self-host default, where no header is trusted. Requests built for
// direct `auth.handler` calls also set `x-piyaz-client-ip` to the same value:
// Better Auth reads only that internal header, and only the HTTP routes and
// middleware stamp it.
process.env.TRUSTED_PROXY_HEADER ??= "cf-connecting-ip";

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
 * `NODE_ENV` is declared `readonly`. Bun ≥ 1.4 rejects `process.env`
 * descriptors that are not configurable, enumerable, AND writable,
 * so all three flags are required.
 */
Object.defineProperty(process.env, "NODE_ENV", {
  value: "production",
  configurable: true,
  enumerable: true,
  writable: true,
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
import { afterEach, beforeAll } from "bun:test";

// Keep the sign-up deliverability gate off the network. Sign-up runs on nearly
// every auth test, and the live DoH probe would make each one slow, network
// dependent, and wrong: the suite's `@test.local` addresses are NXDOMAIN, so a
// real lookup rejects them. Tests that exercise the gate install their own
// resolver and restore this default afterwards.
//
// Dynamic import so it lands after the `server-only` neutralization above;
// a static import would hoist above it and throw.
const { setRecipientDomainResolver, __resetDeliverabilityCacheForTest } =
  await import("@/lib/auth/recipient-domain");
setRecipientDomainResolver(async () => "deliverable");

// The node email-budget counter is process-global; without a reset between
// tests, files that mail the same address would consume each other's budget
// in file-order-dependent ways.
const { __resetBudgetForTest } = await import("@/lib/email/_budget.node");

beforeAll(async () => {
  await setup();
}, 120000);

// Hard reset between tests so a 200-path leak can't authenticate the next
// 401-path test.
afterEach(() => {
  currentTestSession = null;
  __resetBudgetForTest();
  // The verdict memo is process-global. The permissive resolver above
  // short-circuits ahead of it, so only a file that lifts the override can
  // populate it, but a stale entry would answer a later file's canned zone.
  __resetDeliverabilityCacheForTest();
});
