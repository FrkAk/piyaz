import { test, expect, afterAll, afterEach, beforeEach, mock } from "bun:test";
import { FakeEmailSender } from "@/tests/setup/fake-email";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import type { EmailSender } from "@/lib/email/types";

/**
 * End-to-end coverage for the Better Auth email flows PYZ-317 wires:
 * password reset (round-trip, revocation, changed-notification,
 * anti-enumeration), the two-leg change-email chain with purpose-routed
 * templates, email-confirmed account deletion, the unrecognized-sign-in
 * notification, email-disabled behavior parity, and the auth catch-all
 * allowlist additions.
 *
 * Flows drive `auth.handler(...)` on locally-constructed `createAuth()`
 * instances so boot-time email capability is controlled per instance; the
 * allowlist pins go through the real Next route handler (singleton `auth`,
 * constructed email-disabled under this file's mock defaults).
 *
 * Uses the `127.0.4.x` loopback range via `cf-connecting-ip`
 * (`127.0.0.x`-`127.0.3.x` are owned by cookie-attributes, rate-limit,
 * change-password, and delete-account-cascade).
 */

let _platformSender: EmailSender | null = null;
let _platformConfigured = false;

// Behavior-preserving defaults (null/false match the real node stub), so the
// process-global, unrestoreable mock is inert for any later test file.
mock.module("@/lib/email/_sender", () => ({
  getPlatformSender: () => _platformSender,
  platformEmailConfigured: () => _platformConfigured,
}));

const { createAuth } = await import("@/lib/auth");
const routeModule = await import("@/app/api/auth/[...all]/route");

_platformConfigured = true;
const authEmail = createAuth();
_platformConfigured = false;
const authDisabled = createAuth();

let fake = new FakeEmailSender();

beforeEach(() => {
  fake = new FakeEmailSender();
  _platformSender = fake;
  _platformConfigured = true;
});

afterEach(async () => {
  _platformSender = null;
  _platformConfigured = false;
  await truncateAll();
});

afterAll(() => {
  _platformSender = null;
  _platformConfigured = false;
});

type AuthInstance = typeof authEmail;

/**
 * POST a Better Auth endpoint through an instance's real handler.
 *
 * @param instance - The Better Auth instance under test.
 * @param path - Path under `/api/auth`.
 * @param body - JSON body.
 * @param ip - Loopback IP for the BA rate-limit bucket.
 * @param options - Optional cookie and user-agent headers.
 * @returns BA handler response.
 */
function authPost(
  instance: AuthInstance,
  path: string,
  body: unknown,
  ip: string,
  options: { cookie?: string; userAgent?: string } = {},
): Promise<Response> {
  return instance.handler(
    new Request(`https://example.test/api/auth${path}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
        origin: "https://example.test",
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.userAgent ? { "user-agent": options.userAgent } : {}),
      },
      method: "POST",
    }),
  );
}

/**
 * GET a URL through an instance's real handler (emailed links).
 *
 * @param instance - The Better Auth instance under test.
 * @param url - Absolute URL as it appeared in the email.
 * @param ip - Loopback IP for the BA rate-limit bucket.
 * @param cookie - Optional session cookie.
 * @returns BA handler response (redirects are not followed).
 */
function authGet(
  instance: AuthInstance,
  url: string,
  ip: string,
  cookie?: string,
): Promise<Response> {
  return instance.handler(
    new Request(url, {
      headers: {
        "cf-connecting-ip": ip,
        ...(cookie ? { cookie } : {}),
      },
    }),
  );
}

/**
 * Extract the session cookie pair from a response.
 *
 * @param response - BA handler response.
 * @returns `name=value` pair, or undefined when no session cookie was set.
 */
function sessionCookiePair(response: Response): string | undefined {
  const raw = response.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().includes("session_token"));
  return raw?.split(";")[0];
}

/**
 * Extract the first action URL from a captured email's text part
 * (templates render each action URL on its own line).
 *
 * @param text - The plain-text email body.
 * @returns The first `https://` URL in the body.
 */
function firstUrl(text: string): string {
  const match = text.match(/https?:\/\/\S+/);
  expect(match).not.toBeNull();
  return match![0];
}

/**
 * Sign up a user on an instance and mark the email verified via SQL
 * (the flows under test require a verified current address).
 *
 * @param instance - The Better Auth instance under test.
 * @param email - Account email.
 * @param password - Account password.
 * @param verified - Whether to flip `emailVerified` after signup.
 */
async function signUp(
  instance: AuthInstance,
  email: string,
  password: string,
  verified = false,
): Promise<void> {
  const signUpBody = {
    email,
    name: "Email Flows",
    password,
    termsAccepted: true,
  };
  await instance.api.signUpEmail({ body: signUpBody });
  if (verified) {
    const sql = superuserPool();
    await sql`
      UPDATE piyaz_auth."user" SET "emailVerified" = true
      WHERE email = ${email}
    `;
  }
}

test("password reset round-trips with revocation and a changed-notification", async () => {
  const email = "reset-flow@test.local";
  const password = "reset-password-original";
  await signUp(authEmail, email, password);
  const signIn = await authPost(
    authEmail,
    "/sign-in/email",
    { email, password },
    "127.0.4.10",
  );
  const oldCookie = sessionCookiePair(signIn)!;
  const sendsBefore = fake.sent.length;

  const request = await authPost(
    authEmail,
    "/request-password-reset",
    { email, redirectTo: "/reset-password" },
    "127.0.4.10",
  );
  expect(request.status).toBe(200);
  expect(fake.sent.length).toBe(sendsBefore + 1);
  const resetMail = fake.sent[fake.sent.length - 1]!;
  expect(resetMail.to).toBe(email);
  expect(resetMail.category).toBe("passwordReset");
  expect(resetMail.subject).toContain("Reset your");
  expect(resetMail.from).toBe("noreply@example.test");
  expect(resetMail.fromName).toBeDefined();

  const linkResponse = await authGet(
    authEmail,
    firstUrl(resetMail.text),
    "127.0.4.10",
  );
  expect(linkResponse.status).toBeGreaterThanOrEqual(300);
  expect(linkResponse.status).toBeLessThan(400);
  const location = linkResponse.headers.get("location")!;
  const token = new URL(location, "https://example.test").searchParams.get(
    "token",
  )!;
  expect(token.length).toBeGreaterThan(0);

  const newPassword = "reset-password-rotated";
  const reset = await authPost(
    authEmail,
    "/reset-password",
    { newPassword, token },
    "127.0.4.11",
  );
  expect(reset.status).toBe(200);

  const changedMail = fake.sent[fake.sent.length - 1]!;
  expect(changedMail.category).toBe("passwordChanged");
  expect(changedMail.to).toBe(email);

  // revokeSessionsOnPasswordReset: the pre-reset session must be dead.
  const oldSession = await authGet(
    authEmail,
    "https://example.test/api/auth/get-session",
    "127.0.4.10",
    oldCookie,
  );
  expect((await oldSession.json()) as unknown).toBeNull();

  const oldSignIn = await authPost(
    authEmail,
    "/sign-in/email",
    { email, password },
    "127.0.4.12",
  );
  expect(oldSignIn.status).toBeGreaterThanOrEqual(400);
  const newSignIn = await authPost(
    authEmail,
    "/sign-in/email",
    { email, password: newPassword },
    "127.0.4.13",
  );
  expect(newSignIn.status).toBe(200);
});

test("password reset request for an unknown email responds 200 and sends nothing", async () => {
  const response = await authPost(
    authEmail,
    "/request-password-reset",
    { email: "nobody@test.local", redirectTo: "/reset-password" },
    "127.0.4.15",
  );
  expect(response.status).toBe(200);
  expect(fake.sent.length).toBe(0);
});

test("change-email chain: approval to the old address, verification to the new, then the switch", async () => {
  const email = "change-email-old@test.local";
  const newEmail = "change-email-new@test.local";
  const password = "change-email-password";
  await signUp(authEmail, email, password, true);
  const signIn = await authPost(
    authEmail,
    "/sign-in/email",
    { email, password },
    "127.0.4.20",
  );
  const cookie = sessionCookiePair(signIn)!;
  const sendsBefore = fake.sent.length;

  const change = await authPost(
    authEmail,
    "/change-email",
    { newEmail, callbackURL: "/settings" },
    "127.0.4.20",
    { cookie },
  );
  expect(change.status).toBe(200);
  expect(fake.sent.length).toBe(sendsBefore + 1);
  const approvalMail = fake.sent[fake.sent.length - 1]!;
  expect(approvalMail.to).toBe(email);
  expect(approvalMail.category).toBe("emailChangeApproval");
  expect(approvalMail.subject).toContain("Approve");
  expect(approvalMail.text).toContain(newEmail);

  const approve = await authGet(
    authEmail,
    firstUrl(approvalMail.text),
    "127.0.4.20",
    cookie,
  );
  expect(approve.status).toBeGreaterThanOrEqual(300);
  expect(approve.status).toBeLessThan(400);
  const verifyMail = fake.sent[fake.sent.length - 1]!;
  expect(verifyMail.to).toBe(newEmail);
  expect(verifyMail.category).toBe("emailChange");
  expect(verifyMail.subject).toContain("Confirm your new");
  expect(verifyMail.text).toContain(newEmail);

  const confirm = await authGet(
    authEmail,
    firstUrl(verifyMail.text),
    "127.0.4.20",
    cookie,
  );
  expect(confirm.status).toBeGreaterThanOrEqual(300);
  expect(confirm.status).toBeLessThan(400);

  const sql = superuserPool();
  const rows = await sql<{ email: string; emailVerified: boolean }[]>`
    SELECT email, "emailVerified" FROM piyaz_auth."user"
    WHERE email = ${newEmail}
  `;
  expect(rows.length).toBe(1);
  expect(rows[0]!.emailVerified).toBe(true);
});

test("account deletion requires the emailed confirmation link when email is configured", async () => {
  const email = "delete-confirm@test.local";
  const password = "delete-confirm-password";
  await signUp(authEmail, email, password);
  const signIn = await authPost(
    authEmail,
    "/sign-in/email",
    { email, password },
    "127.0.4.30",
  );
  const cookie = sessionCookiePair(signIn)!;
  const sendsBefore = fake.sent.length;

  const deleteResponse = await authPost(
    authEmail,
    "/delete-user",
    { password, callbackURL: "/" },
    "127.0.4.30",
    { cookie },
  );
  expect(deleteResponse.status).toBe(200);
  expect(((await deleteResponse.json()) as { message?: string }).message).toBe(
    "Verification email sent",
  );
  expect(fake.sent.length).toBe(sendsBefore + 1);
  const deleteMail = fake.sent[fake.sent.length - 1]!;
  expect(deleteMail.to).toBe(email);
  expect(deleteMail.category).toBe("deleteAccount");
  expect(deleteMail.subject).toContain("account deletion");

  const sql = superuserPool();
  const before = await sql`
    SELECT id FROM piyaz_auth."user" WHERE email = ${email}
  `;
  expect(before.length).toBe(1);

  const callback = await authGet(
    authEmail,
    firstUrl(deleteMail.text),
    "127.0.4.30",
    cookie,
  );
  expect(callback.status).toBeLessThan(400);

  const after = await sql`
    SELECT id FROM piyaz_auth."user" WHERE email = ${email}
  `;
  expect(after.length).toBe(0);
});

test("new-sign-in notification fires for unrecognized context and stays silent on a match", async () => {
  const email = "signin-notify@test.local";
  const password = "signin-notify-password";
  await signUp(authEmail, email, password);
  const sendsBefore = fake.sent.length;

  // First sign-in: the only other session (from sign-up) has no UA/IP, so
  // this context is unrecognized and notifies.
  const first = await authPost(
    authEmail,
    "/sign-in/email",
    { email, password },
    "127.0.4.40",
    { userAgent: "device-a" },
  );
  expect(first.status).toBe(200);
  expect(fake.sent.length).toBe(sendsBefore + 1);
  const notifyMail = fake.sent[fake.sent.length - 1]!;
  expect(notifyMail.to).toBe(email);
  expect(notifyMail.category).toBe("newSignIn");
  expect(notifyMail.text).toContain("device-a");

  // Same UA + IP again: a matching live session exists, so no mail.
  const second = await authPost(
    authEmail,
    "/sign-in/email",
    { email, password },
    "127.0.4.40",
    { userAgent: "device-a" },
  );
  expect(second.status).toBe(200);
  expect(fake.sent.length).toBe(sendsBefore + 1);

  // New device: unrecognized again, notifies again.
  const third = await authPost(
    authEmail,
    "/sign-in/email",
    { email, password },
    "127.0.4.41",
    { userAgent: "device-b" },
  );
  expect(third.status).toBe(200);
  expect(fake.sent.length).toBe(sendsBefore + 2);
});

test("email-disabled instance behaves exactly as today: immediate delete, zero sends", async () => {
  _platformSender = null;
  _platformConfigured = false;
  const email = "disabled-parity@test.local";
  const password = "disabled-parity-password";
  await signUp(authDisabled, email, password);
  const signIn = await authPost(
    authDisabled,
    "/sign-in/email",
    { email, password },
    "127.0.4.50",
  );
  expect(signIn.status).toBe(200);
  const cookie = sessionCookiePair(signIn)!;

  const reset = await authPost(
    authDisabled,
    "/request-password-reset",
    { email, redirectTo: "/reset-password" },
    "127.0.4.50",
  );
  expect(reset.status).toBe(200);

  const deleteResponse = await authPost(
    authDisabled,
    "/delete-user",
    { password, callbackURL: "/" },
    "127.0.4.50",
    { cookie },
  );
  expect(deleteResponse.status).toBe(200);
  expect(((await deleteResponse.json()) as { message?: string }).message).toBe(
    "User deleted",
  );

  const sql = superuserPool();
  const rows = await sql`
    SELECT id FROM piyaz_auth."user" WHERE email = ${email}
  `;
  expect(rows.length).toBe(0);
  expect(fake.sent.length).toBe(0);
});

test("config pin: customRules cover the new email endpoints", () => {
  const rules = authEmail.options.rateLimit?.customRules as Record<
    string,
    { window: number; max: number }
  >;
  expect(rules["/request-password-reset"]).toEqual({ window: 60, max: 3 });
  expect(rules["/send-verification-email"]).toEqual({ window: 60, max: 3 });
  expect(rules["/reset-password"]).toEqual({ window: 60, max: 5 });
  expect(rules["/change-email"]).toBeUndefined();
});

test("route allowlist: emailed-link endpoints pass, change-email and delete-user stay denied", async () => {
  const base = "https://example.test/api/auth";
  const post = (path: string) =>
    routeModule.POST(
      new Request(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "127.0.4.60",
          origin: "https://example.test",
        },
        body: JSON.stringify({}),
      }),
    );
  const get = (pathAndQuery: string) =>
    routeModule.GET(
      new Request(`${base}${pathAndQuery}`, {
        headers: { "cf-connecting-ip": "127.0.4.60" },
      }),
    );

  // The allowlist 404 is the literal "Not Found" text; anything else means
  // the request reached Better Auth (which may itself 404, e.g. the
  // session-less delete callback).
  const denied = async (response: Response) => {
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  };
  const admitted = async (response: Response) => {
    expect(await response.text()).not.toBe("Not Found");
  };

  await denied(await post("/change-email"));
  await denied(await post("/delete-user"));

  await admitted(await post("/request-password-reset"));
  await admitted(await post("/send-verification-email"));
  await admitted(await get("/verify-email?token=not-a-token"));
  await admitted(await get("/reset-password/some-token"));
  await admitted(await get("/delete-user/callback?token=bogus"));
});
