import { test, expect, afterAll, afterEach, beforeEach, mock } from "bun:test";
import { FakeEmailSender } from "@/tests/setup/fake-email";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import type { EmailSender } from "@/lib/email/types";

/**
 * End-to-end coverage for the email-auth UI backends PYZ-318 wires: the
 * `/verify-email` landing redirects (success, reuse, tampered token, and
 * the invite `next` param surviving both legs), the `/reset-password`
 * error leg, invitation delivery through `sendInvitationEmail` with the
 * personal sender, recipient view/accept/reject without email
 * verification (`requireEmailVerificationOnInvitation: false`), resend
 * refreshing the same row, and the account-deletion callback landing on
 * `/account-deleted`.
 *
 * Flows drive `auth.handler(...)` on locally-constructed `createAuth()`
 * instances (one email-enabled ungated, one email-enabled gated), so
 * neither the route allowlist (org endpoints stay denied there) nor the
 * module-level singleton is involved.
 *
 * Uses the `127.0.6.x` loopback range via `cf-connecting-ip`
 * (`127.0.0.x`-`127.0.5.x` are owned by cookie-attributes, rate-limit,
 * change-password, delete-account-cascade, auth-email-flows, and
 * auth-verification-gate).
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

_platformConfigured = true;
const authEmail = createAuth();
process.env.REQUIRE_EMAIL_VERIFICATION = "true";
const authGated = createAuth();
if (ORIGINAL_GATE === undefined) delete process.env.REQUIRE_EMAIL_VERIFICATION;
else process.env.REQUIRE_EMAIL_VERIFICATION = ORIGINAL_GATE;
_platformConfigured = false;

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
 * @param options - Optional cookie header.
 * @returns BA handler response.
 */
function authPost(
  instance: AuthInstance,
  path: string,
  body: unknown,
  ip: string,
  options: { cookie?: string } = {},
): Promise<Response> {
  return instance.handler(
    new Request(`https://example.test/api/auth${path}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
        origin: "https://example.test",
        ...(options.cookie ? { cookie: options.cookie } : {}),
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
 * Parse a redirect's Location against the test origin.
 *
 * @param response - A 3xx BA handler response.
 * @returns The resolved redirect URL.
 */
function redirectUrl(response: Response): URL {
  expect(response.status).toBeGreaterThanOrEqual(300);
  expect(response.status).toBeLessThan(400);
  return new URL(response.headers.get("location")!, "https://example.test");
}

/**
 * Sign up through the handler and return the minted session cookie
 * (undefined when the instance's verification gate blocks the session).
 *
 * @param instance - The Better Auth instance under test.
 * @param email - Account email.
 * @param password - Account password.
 * @param ip - Loopback IP for the BA rate-limit bucket.
 * @param callbackURL - Optional verification callback carried in the body.
 * @returns Session cookie pair, or undefined.
 */
async function signUpWithCookie(
  instance: AuthInstance,
  email: string,
  password: string,
  ip: string,
  callbackURL?: string,
): Promise<string | undefined> {
  const response = await authPost(
    instance,
    "/sign-up/email",
    {
      email,
      name: "Invite Flows",
      password,
      termsAccepted: true,
      ...(callbackURL ? { callbackURL } : {}),
    },
    ip,
  );
  expect(response.status).toBe(200);
  return sessionCookiePair(response);
}

/** Captured invitation emails, in send order. */
function inviteMails() {
  return fake.sent.filter((m) => m.category === "teamInvite");
}

/**
 * Create a team through the handler (DPA-accepted).
 *
 * @param cookie - Owner's session cookie.
 * @param name - Team name.
 * @param slug - Team slug.
 * @param ip - Loopback IP for the BA rate-limit bucket.
 * @returns The new organization's id.
 */
async function createTeam(
  cookie: string,
  name: string,
  slug: string,
  ip: string,
): Promise<string> {
  const response = await authPost(
    authEmail,
    "/organization/create",
    { name, slug, dpaAccepted: true },
    ip,
    { cookie },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { id?: string };
  expect(body.id).toBeDefined();
  return body.id!;
}

/**
 * List a team's invitations through the handler.
 *
 * @param cookie - Admin's session cookie.
 * @param organizationId - Target team.
 * @param ip - Loopback IP for the BA rate-limit bucket.
 * @returns Raw invitation rows.
 */
async function listInvitations(
  cookie: string,
  organizationId: string,
  ip: string,
): Promise<Array<{ id: string; status: string; expiresAt: string }>> {
  const response = await authGet(
    authEmail,
    `https://example.test/api/auth/organization/list-invitations?organizationId=${organizationId}`,
    ip,
    cookie,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Array<{
    id: string;
    status: string;
    expiresAt: string;
  }>;
}

/**
 * Invite an address to a team and return the invitation id extracted
 * from the delivered email's link.
 *
 * @param cookie - Admin's session cookie.
 * @param organizationId - Target team.
 * @param email - Invited address.
 * @param ip - Loopback IP for the BA rate-limit bucket.
 * @returns The invitation id from the emailed `/invitations/<id>` URL.
 */
async function inviteAndExtractId(
  cookie: string,
  organizationId: string,
  email: string,
  ip: string,
): Promise<string> {
  const response = await authPost(
    authEmail,
    "/organization/invite-member",
    { email, role: "member", organizationId },
    ip,
    { cookie },
  );
  expect(response.status).toBe(200);
  const mail = inviteMails()[inviteMails().length - 1]!;
  const match = firstUrl(mail.text).match(/\/invitations\/([0-9a-f-]{36})/);
  expect(match).not.toBeNull();
  return match![1]!;
}

test("gated sign-up with a verify-email callback lands on the page; link reuse stays error-free", async () => {
  const email = "verify-landing@test.local";
  await signUpWithCookie(
    authGated,
    email,
    "verify-landing-pw",
    "127.0.6.10",
    "/verify-email",
  );
  const mail = fake.sent.find((m) => m.category === "verification")!;
  expect(mail).toBeDefined();
  expect(mail.to).toBe(email);
  const link = firstUrl(mail.text);

  const first = await authGet(authGated, link, "127.0.6.10");
  const firstTarget = redirectUrl(first);
  expect(firstTarget.pathname).toBe("/verify-email");
  expect(firstTarget.searchParams.get("error")).toBeNull();
  expect(sessionCookiePair(first)).toBeDefined();

  // A reused link redirects with NO error param — the landing derives
  // already-verified from session state, exactly as the page assumes.
  const reuse = await authGet(authGated, link, "127.0.6.11");
  const reuseTarget = redirectUrl(reuse);
  expect(reuseTarget.pathname).toBe("/verify-email");
  expect(reuseTarget.searchParams.get("error")).toBeNull();
});

test("the invite next param survives both verification redirect legs", async () => {
  const email = "verify-next@test.local";
  await signUpWithCookie(
    authGated,
    email,
    "verify-next-pw",
    "127.0.6.15",
    "/verify-email?next=%2Finvitations%2Fabc",
  );
  const mail = fake.sent.find((m) => m.category === "verification")!;
  const link = firstUrl(mail.text);

  // Tampered token first: redirectOnError must append `&error=` because
  // the callback already carries a query — the page depends on both
  // params arriving together.
  const tampered = new URL(link);
  tampered.searchParams.set(
    "token",
    `${tampered.searchParams.get("token")}tampered`,
  );
  const errorLeg = await authGet(authGated, tampered.toString(), "127.0.6.15");
  const errorTarget = redirectUrl(errorLeg);
  expect(errorTarget.pathname).toBe("/verify-email");
  expect(errorTarget.searchParams.get("next")).toBe("/invitations/abc");
  expect(errorTarget.searchParams.get("error")).toBe("INVALID_TOKEN");

  const successLeg = await authGet(authGated, link, "127.0.6.16");
  const successTarget = redirectUrl(successLeg);
  expect(successTarget.pathname).toBe("/verify-email");
  expect(successTarget.searchParams.get("next")).toBe("/invitations/abc");
  expect(successTarget.searchParams.get("error")).toBeNull();
});

test("a tampered reset link redirects to /reset-password with INVALID_TOKEN", async () => {
  const email = "reset-error-leg@test.local";
  await signUpWithCookie(authEmail, email, "reset-error-leg-pw", "127.0.6.20");
  const request = await authPost(
    authEmail,
    "/request-password-reset",
    { email, redirectTo: "/reset-password" },
    "127.0.6.20",
  );
  expect(request.status).toBe(200);
  const mail = fake.sent.find((m) => m.category === "passwordReset")!;
  const link = firstUrl(mail.text);

  const bad = link.replace(/\/reset-password\/[^/?]+/, "/reset-password/bogus");
  expect(bad).not.toBe(link);
  const response = await authGet(authEmail, bad, "127.0.6.21");
  const target = redirectUrl(response);
  expect(target.pathname).toBe("/reset-password");
  expect(target.searchParams.get("error")).toBe("INVALID_TOKEN");
});

test("invitation delivers via the personal sender and an unverified recipient views and accepts", async () => {
  const inviterEmail = "invite-owner@test.local";
  const recipientEmail = "invite-recipient@test.local";
  const inviterCookie = (await signUpWithCookie(
    authEmail,
    inviterEmail,
    "invite-owner-pw",
    "127.0.6.30",
  ))!;
  const organizationId = await createTeam(
    inviterCookie,
    "Invite Flow Team",
    "invite-flow-team",
    "127.0.6.30",
  );

  const invitationId = await inviteAndExtractId(
    inviterCookie,
    organizationId,
    recipientEmail,
    "127.0.6.30",
  );
  const mail = inviteMails()[0]!;
  expect(mail.to).toBe(recipientEmail);
  expect(mail.subject).toContain("Invite Flow Team");
  expect(mail.replyTo).toBeDefined();
  expect(mail.text).toContain(inviterEmail);

  // Recipient stays UNVERIFIED: pins requireEmailVerificationOnInvitation
  // false — without it BA 403s get/accept for every unverified account
  // (the generateId:false interaction).
  const recipientCookie = (await signUpWithCookie(
    authEmail,
    recipientEmail,
    "invite-recipient-pw",
    "127.0.6.31",
  ))!;

  const view = await authGet(
    authEmail,
    `https://example.test/api/auth/organization/get-invitation?id=${invitationId}`,
    "127.0.6.31",
    recipientCookie,
  );
  expect(view.status).toBe(200);
  const detail = (await view.json()) as { organizationName?: string };
  expect(detail.organizationName).toBe("Invite Flow Team");

  const accept = await authPost(
    authEmail,
    "/organization/accept-invitation",
    { invitationId },
    "127.0.6.31",
    { cookie: recipientCookie },
  );
  expect(accept.status).toBe(200);
});

test("wrong recipient and unknown invitation ids collapse to non-200s", async () => {
  const inviterCookie = (await signUpWithCookie(
    authEmail,
    "enum-owner@test.local",
    "enum-owner-pw",
    "127.0.6.40",
  ))!;
  const organizationId = await createTeam(
    inviterCookie,
    "Enum Team",
    "enum-team",
    "127.0.6.40",
  );
  const invitationId = await inviteAndExtractId(
    inviterCookie,
    organizationId,
    "enum-invited@test.local",
    "127.0.6.40",
  );

  const outsiderCookie = (await signUpWithCookie(
    authEmail,
    "enum-outsider@test.local",
    "enum-outsider-pw",
    "127.0.6.41",
  ))!;
  const wrongRecipient = await authGet(
    authEmail,
    `https://example.test/api/auth/organization/get-invitation?id=${invitationId}`,
    "127.0.6.41",
    outsiderCookie,
  );
  expect(wrongRecipient.status).toBe(403);

  const unknown = await authGet(
    authEmail,
    `https://example.test/api/auth/organization/get-invitation?id=${crypto.randomUUID()}`,
    "127.0.6.41",
    outsiderCookie,
  );
  expect(unknown.status).toBe(400);
});

test("resend refreshes the same invitation's expiry and refires its email", async () => {
  const recipientEmail = "resend-invited@test.local";
  const inviterCookie = (await signUpWithCookie(
    authEmail,
    "resend-owner@test.local",
    "resend-owner-pw",
    "127.0.6.50",
  ))!;
  const organizationId = await createTeam(
    inviterCookie,
    "Resend Team",
    "resend-team",
    "127.0.6.50",
  );
  const invitationId = await inviteAndExtractId(
    inviterCookie,
    organizationId,
    recipientEmail,
    "127.0.6.50",
  );
  const before = await listInvitations(
    inviterCookie,
    organizationId,
    "127.0.6.50",
  );
  expect(before.length).toBe(1);
  const expiresBefore = new Date(before[0]!.expiresAt).getTime();

  await Bun.sleep(10);
  const resend = await authPost(
    authEmail,
    "/organization/invite-member",
    { email: recipientEmail, role: "member", organizationId, resend: true },
    "127.0.6.51",
    { cookie: inviterCookie },
  );
  expect(resend.status).toBe(200);

  const mails = inviteMails();
  expect(mails.length).toBe(2);
  expect(firstUrl(mails[1]!.text)).toContain(`/invitations/${invitationId}`);

  const after = await listInvitations(
    inviterCookie,
    organizationId,
    "127.0.6.50",
  );
  expect(after.length).toBe(1);
  expect(after[0]!.id).toBe(invitationId);
  expect(new Date(after[0]!.expiresAt).getTime()).toBeGreaterThan(
    expiresBefore,
  );
});

test("reject clears the invitation from pending", async () => {
  const recipientEmail = "reject-invited@test.local";
  const inviterCookie = (await signUpWithCookie(
    authEmail,
    "reject-owner@test.local",
    "reject-owner-pw",
    "127.0.6.60",
  ))!;
  const organizationId = await createTeam(
    inviterCookie,
    "Reject Team",
    "reject-team",
    "127.0.6.60",
  );
  const invitationId = await inviteAndExtractId(
    inviterCookie,
    organizationId,
    recipientEmail,
    "127.0.6.60",
  );

  const recipientCookie = (await signUpWithCookie(
    authEmail,
    recipientEmail,
    "reject-invited-pw",
    "127.0.6.61",
  ))!;
  const reject = await authPost(
    authEmail,
    "/organization/reject-invitation",
    { invitationId },
    "127.0.6.61",
    { cookie: recipientCookie },
  );
  expect(reject.status).toBe(200);

  const rows = await listInvitations(
    inviterCookie,
    organizationId,
    "127.0.6.60",
  );
  const row = rows.find((r) => r.id === invitationId)!;
  expect(row.status).toBe("rejected");
});

test("the emailed delete link redirects to /account-deleted", async () => {
  const email = "delete-landing@test.local";
  const password = "delete-landing-pw";
  const cookie = (await signUpWithCookie(
    authEmail,
    email,
    password,
    "127.0.6.70",
  ))!;

  const deleteResponse = await authPost(
    authEmail,
    "/delete-user",
    { password, callbackURL: "/account-deleted" },
    "127.0.6.70",
    { cookie },
  );
  expect(deleteResponse.status).toBe(200);
  const mail = fake.sent.find((m) => m.category === "deleteAccount")!;

  const callback = await authGet(
    authEmail,
    firstUrl(mail.text),
    "127.0.6.70",
    cookie,
  );
  const target = redirectUrl(callback);
  expect(target.pathname).toBe("/account-deleted");

  const sql = superuserPool();
  const rows = await sql`
    SELECT id FROM piyaz_auth."user" WHERE email = ${email}
  `;
  expect(rows.length).toBe(0);
});
