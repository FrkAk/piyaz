import { test, expect, afterEach } from "bun:test";
import { auth } from "@/lib/auth";
import { truncateAll } from "@/tests/setup/schema";

/**
 * AC #1 (MYMR-94): pin Better Auth's session cookie hardening at the
 * HTTP response boundary plus attack paths that must NOT issue a
 * session cookie.
 *
 * `lib/auth.ts:45` evaluates `process.env.NODE_ENV === "production"`
 * inside `betterAuth({...})` at module instantiation.
 * `tests/setup/preload.ts` forces `NODE_ENV=production` (plus test-only
 * `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`) before any test file
 * loads, so the static `import { auth } from "@/lib/auth"` here boots
 * BA with `useSecureCookies: true` regardless of import order. The
 * preload also installs a hard guard against later `NODE_ENV` drift.
 *
 * Each test uses a unique loopback IP via the `cf-connecting-ip`
 * header (`lib/auth.ts:54` `ipAddressHeaders`) so BA's in-memory
 * rate-limiter (`/sign-in/email`: 5/60s) cannot cross-contaminate
 * between tests in this file or with `tests/auth/rate-limit.test.ts`.
 * This file owns the `127.0.0.x` range; the rate-limit test owns
 * `127.0.1.x`.
 */

const PROD_COOKIE_NAME = "__Secure-better-auth.session_token";

/**
 * Build a sign-in POST pinned to a unique loopback IP.
 *
 * @param email - Account email.
 * @param password - Account password.
 * @param ip - Loopback IP (e.g. `"127.0.0.10"`). Must be unique per
 *             test to keep the BA rate-limit bucket isolated.
 * @param body - Optional raw body override. When omitted, JSON-encodes
 *               `{ email, password }`. Malformed-body tests pass an
 *               explicit string.
 * @returns A `Request` suitable for `auth.handler(...)`.
 */
function signInRequest(
  email: string,
  password: string,
  ip: string,
  body?: string,
): Request {
  return new Request("https://example.test/api/auth/sign-in/email", {
    body: body ?? JSON.stringify({ email, password }),
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
    },
    method: "POST",
  });
}

/**
 * Extract the session-token `Set-Cookie` entry from a BA response.
 *
 * Bun's `Headers` ships the standard `getSetCookie()` — the previous
 * `?? [response.headers.get("set-cookie")]` fallback was dead code
 * that would have silently truncated multi-cookie responses.
 *
 * @param response - BA handler response.
 * @returns Matching `Set-Cookie` header value, or `undefined` if BA
 *          chose not to issue a session cookie (auth failure,
 *          malformed-body path, etc.).
 */
function findSessionCookie(response: Response): string | undefined {
  return response.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().includes("session_token"));
}

/**
 * Sign up a user through the BA API with Terms acceptance, which the
 * `user.create.before` gate now requires. The body is passed as a typed
 * variable so the transient `termsAccepted` consent flag reaches
 * `ctx.body` without being declared as a persisted additional field.
 *
 * @param email - Account email.
 * @param name - Display name.
 * @param password - Account password.
 * @returns Resolves once the account is created.
 */
async function signUpUser(
  email: string,
  name: string,
  password: string,
): Promise<void> {
  const body = { email, name, password, termsAccepted: true };
  await auth.api.signUpEmail({ body });
}

afterEach(async () => {
  await truncateAll();
});

test("config pin: revokeSessionsOnPasswordReset stays armed", () => {
  // The reset flow (`sendResetPassword` callback + `/reset-password`
  // route) is not yet wired in `lib/auth.ts` / `app/`, so behavioral
  // E2E coverage is deferred to whoever lands that feature. Until
  // then this guard keeps the flag from being silently dropped — a
  // post-reset session-fixation regression would otherwise be
  // invisible to the test suite.
  expect(auth.options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(
    true,
  );
});

test("sign-in Set-Cookie carries Secure, HttpOnly, SameSite=Lax, Path=/ in production", async () => {
  const email = "cookie-flags@test.local";
  const password = "test-password-12345";

  await signUpUser(email, "Cookie Flags", password);

  const response = await auth.handler(
    signInRequest(email, password, "127.0.0.10"),
  );
  expect(response.status).toBe(200);

  const sessionCookie = findSessionCookie(response);
  expect(sessionCookie).toBeDefined();
  expect(sessionCookie!.toLowerCase()).toContain("httponly");
  expect(sessionCookie!).toContain("Secure");
  expect(sessionCookie!.toLowerCase()).toContain("samesite=lax");
  // `Path=/` pins BA's default scope. A narrower path (e.g. `/api`)
  // would let a sibling path host a credential-stealing endpoint
  // under the same origin without ever seeing the cookie itself.
  expect(sessionCookie!).toContain("Path=/");
});

test("production cookie name carries the __Secure- prefix", async () => {
  const email = "cookie-prefix@test.local";
  const password = "test-password-12345";

  await signUpUser(email, "Cookie Prefix", password);

  const response = await auth.handler(
    signInRequest(email, password, "127.0.0.11"),
  );
  expect(response.status).toBe(200);

  const sessionCookie = findSessionCookie(response);
  expect(sessionCookie).toBeDefined();
  // `__Secure-` forces compliant browsers to reject the cookie if it
  // is ever set without `Secure` or over HTTP — defense in depth on
  // top of `useSecureCookies: true` and the explicit `Secure` flag
  // asserted above.
  expect(sessionCookie!.startsWith(`${PROD_COOKIE_NAME}=`)).toBe(true);
});

test("attack: wrong password issues no session cookie", async () => {
  const email = "wrong-password@test.local";
  const password = "real-password-12345";

  await signUpUser(email, "Wrong Password", password);

  const response = await auth.handler(
    signInRequest(email, "totally-wrong-password", "127.0.0.12"),
  );
  // BA returns 4xx on credential failure; the exact code is BA's to
  // pick. The security invariant is the absence of a session cookie.
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(findSessionCookie(response)).toBeUndefined();
});

test("attack: malformed JSON body issues no session cookie", async () => {
  const response = await auth.handler(
    signInRequest("", "", "127.0.0.13", "{not-json,,"),
  );
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(findSessionCookie(response)).toBeUndefined();
});

test("attack: empty body issues no session cookie", async () => {
  const response = await auth.handler(signInRequest("", "", "127.0.0.14", ""));
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(findSessionCookie(response)).toBeUndefined();
});

test("attack: missing password field issues no session cookie", async () => {
  // Pins against the class of bug where a password comparator
  // short-circuits on `undefined` and matches any account.
  const email = "no-password-field@test.local";
  await signUpUser(email, "No Password", "real-password-12345");

  const response = await auth.handler(
    signInRequest(email, "", "127.0.0.15", JSON.stringify({ email })),
  );
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(findSessionCookie(response)).toBeUndefined();
});
