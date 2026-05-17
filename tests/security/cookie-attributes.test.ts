import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";

/**
 * AC #1 (MYMR-94): verify Better Auth's session cookie carries `Secure`,
 * `HttpOnly`, and `SameSite=Lax` at the HTTP response boundary when the
 * runtime is production.
 *
 * The `lib/auth.ts` config gates `useSecureCookies` on
 * `process.env.NODE_ENV === "production"` (mirrors `proxy.ts:35`). That
 * expression is evaluated inside `betterAuth({...})` at module
 * instantiation, so `NODE_ENV` must be flipped BEFORE `@/lib/auth`
 * loads. We do that here via dynamic import inside `beforeAll`.
 *
 * Filed under `tests/security/` rather than `tests/auth/` because
 * `tests/auth/org-permissions.test.ts` installs a process-wide
 * `mock.module("@/lib/auth", …)` stub at module-top-level. Bun has no
 * `unmock` for module mocks and the stub applies for the whole
 * `bun test` invocation regardless of file CLI order, so any test that
 * needs the real `@/lib/auth` must live in an invocation that excludes
 * `org-permissions.test.ts`. `bun run test:db` lists `tests/security`
 * separately for exactly this reason; the file is exercised cleanly
 * there. The full `bun test` glob (which includes `org-permissions`)
 * is not the canonical command for this regression.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;
const ORIGINAL_BETTER_AUTH_URL = process.env.BETTER_AUTH_URL;
let auth: typeof import("@/lib/auth").auth;

beforeAll(async () => {
  // @ts-expect-error NODE_ENV is readonly in @types/node
  process.env.NODE_ENV = "production";
  // BA refuses to boot in production without a non-default secret;
  // any non-default value satisfies the validator.
  process.env.BETTER_AUTH_SECRET ??=
    "test-only-secret-not-used-outside-this-suite-0000";
  // BA emits a base-URL warning otherwise; harmless but noisy.
  process.env.BETTER_AUTH_URL ??= "https://example.test";
  ({ auth } = await import("@/lib/auth"));
});

afterEach(async () => {
  await truncateAll();
});

afterAll(() => {
  // Restore env vars so the test process does not leak `production`
  // (or our synthetic secret/URL) into any downstream module that may
  // evaluate them lazily.
  // @ts-expect-error NODE_ENV is readonly in @types/node
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_BETTER_AUTH_SECRET === undefined) {
    delete process.env.BETTER_AUTH_SECRET;
  } else {
    process.env.BETTER_AUTH_SECRET = ORIGINAL_BETTER_AUTH_SECRET;
  }
  if (ORIGINAL_BETTER_AUTH_URL === undefined) {
    delete process.env.BETTER_AUTH_URL;
  } else {
    process.env.BETTER_AUTH_URL = ORIGINAL_BETTER_AUTH_URL;
  }
});

test("sign-in Set-Cookie carries Secure, HttpOnly, SameSite=Lax in production", async () => {
  const email = "cookie-test@test.local";
  const password = "test-password-12345";

  await auth.api.signUpEmail({
    body: { email, name: "Cookie Test", password },
  });

  const request = new Request(
    "https://example.test/api/auth/sign-in/email",
    {
      body: JSON.stringify({ email, password }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  const response = await auth.handler(request);
  expect(response.status).toBe(200);

  const setCookies = response.headers.getSetCookie?.() ?? [
    response.headers.get("set-cookie") ?? "",
  ];
  const sessionCookie = setCookies.find((c) =>
    c.toLowerCase().includes("session_token"),
  );
  expect(sessionCookie).toBeDefined();
  expect(sessionCookie!.toLowerCase()).toContain("httponly");
  expect(sessionCookie!).toContain("Secure");
  expect(sessionCookie!.toLowerCase()).toContain("samesite=lax");
});

test("production cookie name carries the __Secure- prefix", async () => {
  const email = "cookie-prefix@test.local";
  const password = "test-password-12345";

  await auth.api.signUpEmail({
    body: { email, name: "Cookie Prefix", password },
  });

  const request = new Request(
    "https://example.test/api/auth/sign-in/email",
    {
      body: JSON.stringify({ email, password }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  const response = await auth.handler(request);
  expect(response.status).toBe(200);

  const setCookies = response.headers.getSetCookie?.() ?? [
    response.headers.get("set-cookie") ?? "",
  ];
  const sessionCookie = setCookies.find((c) =>
    c.toLowerCase().includes("session_token"),
  );
  expect(sessionCookie).toBeDefined();
  expect(sessionCookie!.startsWith("__Secure-better-auth.session_token=")).toBe(
    true,
  );
});
