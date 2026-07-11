import { test, expect, afterEach } from "bun:test";
import { auth } from "@/lib/auth";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";

/**
 * Behavioral coverage for the BA `changePassword` endpoint the MYMR-235
 * server action invokes: `nextCookies` plugin ordering, wrong-current and
 * unauthenticated rejection, `revokeOtherSessions` session rotation, and
 * the `account.update.after` OAuth-artifact cascade.
 *
 * These drive `auth.handler("/change-password")` directly to exercise the
 * endpoint's real logic (scrypt verify, rotation, cascade). In production
 * the HTTP path is default-denied by the auth catch-all allowlist
 * (`app/api/auth/[...all]/route.ts`); the feature reaches the same endpoint
 * through `changePasswordAction` calling `auth.api.changePassword`. The
 * action's own rate-limit and input-bound coverage lives in
 * `tests/actions/change-password-action.test.ts`.
 *
 * Uses the `127.0.2.x` loopback range via `cf-connecting-ip`.
 * `tests/auth/cookie-attributes.test.ts` owns `127.0.0.x` and
 * `tests/auth/rate-limit.test.ts` owns `127.0.1.x`; each test additionally
 * uses its own IP because sign-in requests here count against the 5/60
 * `/sign-in/email` rule.
 */

afterEach(async () => {
  await truncateAll();
});

/**
 * POST a Better Auth endpoint through the real handler.
 *
 * @param path - Path under `/api/auth` (e.g. `"/change-password"`).
 * @param body - JSON body.
 * @param ip - Loopback IP for the BA rate-limit bucket.
 * @param cookie - Optional `Cookie` header value (session).
 * @returns BA handler response.
 */
function authPost(
  path: string,
  body: unknown,
  ip: string,
  cookie?: string,
): Promise<Response> {
  return auth.handler(
    new Request(`https://example.test/api/auth${path}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
        // BA's CSRF check rejects cookie-bearing state changes whose
        // Origin is absent or not in trustedOrigins
        // (MISSING_OR_NULL_ORIGIN). Browsers always send Origin on
        // cross-and-same-origin POSTs, so the tests mirror that.
        origin: "https://example.test",
        ...(cookie ? { cookie } : {}),
      },
      method: "POST",
    }),
  );
}

/**
 * Extract the `name=value` pair of the session cookie from a response.
 *
 * @param response - BA handler response.
 * @returns Cookie pair suitable for a `Cookie` request header, or
 *          undefined when no session cookie was issued.
 */
function sessionCookiePair(response: Response): string | undefined {
  const raw = response.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().includes("session_token"));
  return raw?.split(";")[0];
}

/**
 * Sign up a user and sign in once, returning the session cookie pair.
 *
 * @param email - Account email.
 * @param password - Account password.
 * @param ip - Loopback IP for both requests.
 * @returns Session cookie pair for authenticated follow-up requests.
 */
async function signUpAndSignIn(
  email: string,
  password: string,
  ip: string,
): Promise<string> {
  const signUpBody = {
    email,
    name: "Change Password",
    password,
    termsAccepted: true,
  };
  await auth.api.signUpEmail({ body: signUpBody });
  const response = await authPost("/sign-in/email", { email, password }, ip);
  expect(response.status).toBe(200);
  const cookie = sessionCookiePair(response);
  expect(cookie).toBeDefined();
  return cookie!;
}

test("config pin: nextCookies is the last plugin", () => {
  // BA documents that nextCookies() must be last so its after-hook sees
  // every other plugin's Set-Cookie writes. Without this plugin the
  // session rotated by changePassword({ revokeOtherSessions: true })
  // never reaches the browser from a server action and the user is
  // silently signed out after a successful change.
  const plugins = auth.options.plugins ?? [];
  expect(plugins.length).toBeGreaterThan(0);
  expect(plugins[plugins.length - 1]?.id).toBe("next-cookies");
});

test("attack: wrong current password is rejected and changes nothing", async () => {
  const email = "wrong-current@test.local";
  const password = "real-password-12345";
  const cookie = await signUpAndSignIn(email, password, "127.0.2.10");

  const response = await authPost(
    "/change-password",
    {
      currentPassword: "guessed-wrong-password",
      newPassword: "attacker-chosen-pw-1",
      revokeOtherSessions: true,
    },
    "127.0.2.10",
    cookie,
  );
  expect(response.status).toBeGreaterThanOrEqual(400);
  const body = (await response.json()) as { code?: string };
  expect(body.code).toBe("INVALID_PASSWORD");
  expect(sessionCookiePair(response)).toBeUndefined();

  // The stored credential must be untouched: the original password still
  // signs in.
  const signInAgain = await authPost(
    "/sign-in/email",
    { email, password },
    "127.0.2.11",
  );
  expect(signInAgain.status).toBe(200);
});

test("attack: unauthenticated change-password request is rejected", async () => {
  const response = await authPost(
    "/change-password",
    {
      currentPassword: "whatever-password",
      newPassword: "attacker-chosen-pw-1",
    },
    "127.0.2.15",
  );
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(sessionCookiePair(response)).toBeUndefined();
});

test("revokeOtherSessions rotates the caller's session and kills the others", async () => {
  const email = "rotate-sessions@test.local";
  const password = "original-password-1";
  const newPassword = "rotated-password-22";

  const cookieA = await signUpAndSignIn(email, password, "127.0.2.20");
  const signInB = await authPost(
    "/sign-in/email",
    { email, password },
    "127.0.2.21",
  );
  expect(signInB.status).toBe(200);
  const cookieB = sessionCookiePair(signInB)!;

  const response = await authPost(
    "/change-password",
    { currentPassword: password, newPassword, revokeOtherSessions: true },
    "127.0.2.20",
    cookieA,
  );
  expect(response.status).toBe(200);

  // The caller gets a fresh session cookie: BA deletes ALL sessions
  // (including the caller's) and mints a replacement in the same response.
  const rotated = sessionCookiePair(response);
  expect(rotated).toBeDefined();
  expect(rotated).not.toBe(cookieA);

  // The rotated cookie must be a LIVE session — a deletion header
  // (`session_token=; Max-Age=0`) would also satisfy the two assertions
  // above while shipping the silent-signout regression this test guards.
  const getSessionA = await auth.handler(
    new Request("https://example.test/api/auth/get-session", {
      headers: { cookie: rotated!, "cf-connecting-ip": "127.0.2.20" },
    }),
  );
  expect((await getSessionA.json()) as unknown).not.toBeNull();

  // The second device's session must be dead.
  const getSessionB = await auth.handler(
    new Request("https://example.test/api/auth/get-session", {
      headers: { cookie: cookieB, "cf-connecting-ip": "127.0.2.21" },
    }),
  );
  const sessionB = (await getSessionB.json()) as unknown;
  expect(sessionB).toBeNull();

  // Old password rejected, new password accepted.
  const oldSignIn = await authPost(
    "/sign-in/email",
    { email, password },
    "127.0.2.22",
  );
  expect(oldSignIn.status).toBeGreaterThanOrEqual(400);
  const newSignIn = await authPost(
    "/sign-in/email",
    { email, password: newPassword },
    "127.0.2.23",
  );
  expect(newSignIn.status).toBe(200);
});

test("password change wipes the user's OAuth agent tokens (account.update.after cascade)", async () => {
  const email = "agent-cascade@test.local";
  const password = "cascade-password-1";
  const cookie = await signUpAndSignIn(email, password, "127.0.2.30");

  const sql = superuserPool();
  const [{ id: userId }] = await sql<{ id: string }[]>`
    SELECT id FROM piyaz_auth."user" WHERE email = ${email}
  `;
  await sql`
    INSERT INTO piyaz_auth."oauthAccessToken"
      ("token", "clientId", "userId", "scopes", "expiresAt")
    VALUES ('test-access-token', 'test-client', ${userId}::uuid,
            '{openid}', now() + interval '1 hour')
  `;
  await sql`
    INSERT INTO piyaz_auth."oauthRefreshToken"
      ("token", "clientId", "userId", "scopes", "expiresAt")
    VALUES ('test-refresh-token', 'test-client', ${userId}::uuid,
            '{openid}', now() + interval '7 days')
  `;

  const response = await authPost(
    "/change-password",
    {
      currentPassword: password,
      newPassword: "cascade-password-2",
      revokeOtherSessions: true,
    },
    "127.0.2.30",
    cookie,
  );
  expect(response.status).toBe(200);

  const accessRows = await sql`
    SELECT id FROM piyaz_auth."oauthAccessToken" WHERE "userId" = ${userId}::uuid
  `;
  const refreshRows = await sql`
    SELECT id FROM piyaz_auth."oauthRefreshToken" WHERE "userId" = ${userId}::uuid
  `;
  expect(accessRows.length).toBe(0);
  expect(refreshRows.length).toBe(0);
});
