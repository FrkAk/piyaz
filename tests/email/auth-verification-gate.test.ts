import { test, expect, afterAll, afterEach, beforeEach, mock } from "bun:test";
import { FakeEmailSender, settle } from "@/tests/setup/fake-email";
import { truncateAll } from "@/tests/setup/schema";
import type { EmailSender } from "@/lib/email/types";

/**
 * Coverage for the explicit email-verification gate
 * (`REQUIRE_EMAIL_VERIFICATION`): gated sign-up sends a verification email
 * and mints no session, unverified sign-in is blocked with 403 while the
 * `sendOnSignIn` re-send stays inside the recipient's cooldown, the emailed
 * link verifies and auto-signs-in, and — the self-host invariant — an ungated
 * instance never sends verification mail or blocks sign-ins regardless of
 * transport availability.
 *
 * Also covers the one honest-response path: an unverified caller holding a
 * session (the ungated shape, which is what `/verify-email` renders the resend
 * form for) is told a withheld resend was withheld, where an anonymous caller
 * keeps the neutral success that stops the endpoint confirming an address.
 *
 * Both instances are constructed locally via `createAuth()` under the
 * matching env; the module-level singleton stays ungated.
 *
 * Uses the `127.0.5.x` loopback range via `cf-connecting-ip`
 * (`127.0.4.x` is owned by auth-email-flows).
 */

let _platformSender: EmailSender | null = null;
let _platformConfigured = false;

// Behavior-preserving defaults; see tests/email/resolver.test.ts on the
// process-global, unrestoreable nature of mock.module.
mock.module("@/lib/email/_sender", () => ({
  getPlatformSender: () => _platformSender,
  platformEmailConfigured: () => _platformConfigured,
}));

const { createAuth } = await import("@/lib/auth");

const ORIGINAL_GATE = process.env.REQUIRE_EMAIL_VERIFICATION;

process.env.REQUIRE_EMAIL_VERIFICATION = "true";
const authGated = createAuth();
delete process.env.REQUIRE_EMAIL_VERIFICATION;
const authUngated = createAuth();

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
  if (ORIGINAL_GATE === undefined)
    delete process.env.REQUIRE_EMAIL_VERIFICATION;
  else process.env.REQUIRE_EMAIL_VERIFICATION = ORIGINAL_GATE;
});

type AuthInstance = typeof authGated;

/**
 * POST a Better Auth endpoint through an instance's real handler.
 *
 * @param instance - The Better Auth instance under test.
 * @param path - Path under `/api/auth`.
 * @param body - JSON body.
 * @param ip - Loopback IP for the BA rate-limit bucket.
 * @param cookie - Session cookie header, for the authenticated paths.
 * @returns BA handler response.
 */
async function authPost(
  instance: AuthInstance,
  path: string,
  body: unknown,
  ip: string,
  cookie?: string,
): Promise<Response> {
  const response = await instance.handler(
    new Request(`https://example.test/api/auth${path}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(cookie !== undefined && { cookie }),
        "cf-connecting-ip": ip,
        "x-piyaz-client-ip": ip,
        origin: "https://example.test",
      },
      method: "POST",
    }),
  );
  await settle();
  return response;
}

/**
 * Extract the first action URL from a captured email's text part.
 *
 * @param text - The plain-text email body.
 * @returns The first `https://` URL in the body.
 */
function firstUrl(text: string): string {
  const match = text.match(/https?:\/\/\S+/);
  expect(match).not.toBeNull();
  return match![0];
}

test("gated: sign-up sends verification, 403s unverified sign-in, and the link unblocks", async () => {
  const email = "gate-flow@test.local";
  const password = "gate-flow-password-1";

  const signUp = await authPost(
    authGated,
    "/sign-up/email",
    { email, name: "Gate Flow", password, termsAccepted: true },
    "127.0.5.10",
  );
  expect(signUp.status).toBe(200);
  expect(((await signUp.json()) as { token: string | null }).token).toBeNull();
  expect(fake.sent.length).toBe(1);
  const verifyMail = fake.sent[0]!;
  expect(verifyMail.to).toBe(email);
  expect(verifyMail.category).toBe("verification");
  expect(verifyMail.subject).toContain("Verify");

  const blocked = await authPost(
    authGated,
    "/sign-in/email",
    { email, password },
    "127.0.5.10",
  );
  expect(blocked.status).toBe(403);
  expect(((await blocked.json()) as { code?: string }).code).toBe(
    "EMAIL_NOT_VERIFIED",
  );
  // sendOnSignIn re-sends on every blocked attempt, so the per-recipient
  // cooldown is what keeps a sign-in retry loop from mailing a link per
  // attempt and emptying the hour's allowance before the first one is read.
  // The 403 still stands; only the duplicate mail is withheld.
  expect(fake.sent.length).toBe(1);

  const link = await authGated.handler(
    new Request(firstUrl(fake.sent[0]!.text), {
      headers: {
        "cf-connecting-ip": "127.0.5.10",
        "x-piyaz-client-ip": "127.0.5.10",
      },
    }),
  );
  expect(link.status).toBeLessThan(400);
  // autoSignInAfterVerification mints a session on the verifying click.
  const sessionCookie = link.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().includes("session_token"));
  expect(sessionCookie).toBeDefined();

  const signIn = await authPost(
    authGated,
    "/sign-in/email",
    { email, password },
    "127.0.5.11",
  );
  expect(signIn.status).toBe(200);
});

test("a withheld resend is admitted to the caller who owns the address, and only to them", async () => {
  const email = "resend-owner@test.local";
  const password = "resend-owner-password";

  // Ungated, because that is the only shape where an unverified account holds
  // a session: the gate refuses to sign one in at all.
  const signUp = await authPost(
    authUngated,
    "/sign-up/email",
    { email, name: "Resend Owner", password, termsAccepted: true },
    "127.0.5.20",
  );
  expect(signUp.status).toBe(200);
  expect(fake.sent.length).toBe(0);
  const cookie = signUp.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

  const first = await authPost(
    authUngated,
    "/send-verification-email",
    { email },
    "127.0.5.20",
    cookie,
  );
  expect(first.status).toBe(200);
  expect(fake.sent.length).toBe(1);

  const second = await authPost(
    authUngated,
    "/send-verification-email",
    { email },
    "127.0.5.20",
    cookie,
  );
  expect(second.status).toBe(429);
  expect(((await second.json()) as { code?: string }).code).toBe(
    "VERIFICATION_EMAIL_WITHHELD",
  );
  expect(fake.sent.length).toBe(1);

  // Same address, no session: the response must not become an oracle for who
  // has an unverified account here.
  const anonymous = await authPost(
    authUngated,
    "/send-verification-email",
    { email },
    "127.0.5.21",
  );
  expect(anonymous.status).toBe(200);
  expect(fake.sent.length).toBe(1);
});

test("ungated: sign-up mints a session and sends nothing, sign-in is never blocked", async () => {
  const email = "ungated-flow@test.local";
  const password = "ungated-flow-password";

  const signUp = await authPost(
    authUngated,
    "/sign-up/email",
    { email, name: "Ungated Flow", password, termsAccepted: true },
    "127.0.5.20",
  );
  expect(signUp.status).toBe(200);
  expect(
    ((await signUp.json()) as { token: string | null }).token,
  ).not.toBeNull();
  // Transport is configured (fake active) — the gate, not transport
  // availability, decides that no verification mail is sent.
  expect(fake.sent.filter((m) => m.category === "verification").length).toBe(0);

  const signIn = await authPost(
    authUngated,
    "/sign-in/email",
    { email, password },
    "127.0.5.21",
  );
  expect(signIn.status).toBe(200);
});

test("config pin: the gate follows REQUIRE_EMAIL_VERIFICATION, not transport availability", () => {
  expect(authGated.options.emailAndPassword?.requireEmailVerification).toBe(
    true,
  );
  expect(authGated.options.emailVerification?.sendOnSignUp).toBe(true);
  expect(authGated.options.emailVerification?.sendOnSignIn).toBe(true);
  expect(authUngated.options.emailAndPassword?.requireEmailVerification).toBe(
    false,
  );
  expect(authUngated.options.emailVerification?.sendOnSignUp).toBe(false);
  expect(authUngated.options.emailVerification?.sendOnSignIn).toBe(false);
});
