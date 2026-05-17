import { test, expect, afterEach } from "bun:test";
import { auth } from "@/lib/auth";
import { truncateAll } from "@/tests/setup/schema";

/**
 * AC #1 (MYMR-94): verify Better Auth's session cookie carries `Secure`,
 * `HttpOnly`, and `SameSite=Lax` at the HTTP response boundary when the
 * runtime is production.
 *
 * `lib/auth.ts:45` evaluates `process.env.NODE_ENV === "production"`
 * inside `betterAuth({...})` at module instantiation. `tests/setup/preload.ts`
 * sets `NODE_ENV=production` (plus `BETTER_AUTH_SECRET` and
 * `BETTER_AUTH_URL` test-only defaults) before any test file loads, so
 * the static `import { auth } from "@/lib/auth"` here boots BA with
 * `useSecureCookies: true` regardless of which other test file imports
 * `@/lib/auth` first.
 */

afterEach(async () => {
  await truncateAll();
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
      headers: {
        "content-type": "application/json",
        // Satisfies `lib/auth.ts:54` ipAddressHeaders so BA's rate-limit
        // path doesn't WARN about a missing client IP in the test output.
        "cf-connecting-ip": "127.0.0.1",
      },
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
      headers: {
        "content-type": "application/json",
        // Satisfies `lib/auth.ts:54` ipAddressHeaders so BA's rate-limit
        // path doesn't WARN about a missing client IP in the test output.
        "cf-connecting-ip": "127.0.0.1",
      },
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
