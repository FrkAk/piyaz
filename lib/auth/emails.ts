import "server-only";

import { jwtVerify } from "jose";
import { getEmailSender } from "@/lib/email";
import { enrollEmailSend } from "@/lib/email/_defer";
import {
  resolveBrandConfig,
  senderFor,
  type EmailPurpose,
} from "@/lib/email/brand";
import {
  deleteAccountEmail,
  emailChangeApprovalEmail,
  emailChangeEmail,
  newSignInEmail,
  passwordChangedEmail,
  passwordResetEmail,
  teamInviteEmail,
  verificationEmail,
  type RenderedEmail,
} from "@/lib/email/templates";
import type { BrandConfig } from "@/lib/email/types";

/**
 * Minimal recipient shape shared by every auth email. Structural subset of
 * Better Auth's `User` so callers can pass the hook/callback payloads
 * directly and tests can construct recipients without the full model.
 */
export interface EmailRecipient {
  email: string;
  name: string;
}

/**
 * Request-context display strings for the security notification templates.
 * Caller-formatted: `device` is the raw user-agent, `location` the resolved
 * client IP. Absent fields render as omitted notes.
 */
export interface SignInContext {
  device?: string;
  location?: string;
}

/**
 * Render and dispatch one auth email as a floating send.
 *
 * No-ops when `getEmailSender()` resolves null, so every auth flow behaves
 * exactly as an email-disabled deploy with zero call-site branching. The send
 * is never awaited (Better Auth timing-attack guidance); delivery failures
 * log a structured event without the recipient address, and the promise is
 * enrolled via `enrollEmailSend` so Workers cannot cancel it at response
 * return.
 *
 * @param to - Recipient address.
 * @param template - Template name for the structured failure log and category.
 * @param subject - Caller-owned subject line.
 * @param brand - Brand config, resolved once by the caller for the subject.
 * @param render - Renders the body once the capability gate has passed.
 * @param senderKind - Sender purpose for address selection; defaults to transactional (noreply).
 */
function deliverAuthEmail(
  to: string,
  template: string,
  subject: string,
  brand: BrandConfig,
  render: (brand: BrandConfig) => RenderedEmail,
  senderKind: EmailPurpose = "transactional",
): void {
  const sender = getEmailSender();
  if (sender === null) return;
  const { from, replyTo } = senderFor(senderKind, brand);
  const rendered = render(brand);
  const send = sender
    .send({
      to,
      from,
      fromName: brand.appName,
      ...(replyTo !== undefined && { replyTo }),
      subject,
      html: rendered.html,
      text: rendered.text,
      category: template,
    })
    .then((result) => {
      if (result.kind === "error") {
        console.error(
          JSON.stringify({
            event: "auth_email_send_failed",
            template,
            code: result.code,
            message: result.message,
          }),
        );
      }
    })
    .catch((err: unknown) => {
      console.error(
        JSON.stringify({
          event: "auth_email_send_failed",
          template,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  enrollEmailSend(send);
}

/**
 * Extract the change-email target address from a Better Auth verification
 * token. BA's `sendVerificationEmail` payload carries no purpose field; the
 * discriminator lives inside the HS256 JWT it signs with
 * `BETTER_AUTH_SECRET` (`updateTo` is set only on change-email tokens).
 * Mirrors BA's own verify call in `verify-email`.
 *
 * @param token - The verification token from the callback payload.
 * @returns The pending new address, or `null` for plain verification tokens
 *   and any token that fails to verify.
 */
async function changeEmailTargetFromToken(
  token: string,
): Promise<string | null> {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
      { algorithms: ["HS256"] },
    );
    return typeof payload.updateTo === "string" ? payload.updateTo : null;
  } catch {
    return null;
  }
}

/**
 * `emailVerification.sendVerificationEmail` wiring. Purpose-routed: the
 * change-email leg (token carries `updateTo`; `user.email` is already the new
 * address) renders the new-address confirmation template, every other leg
 * (sign-up, blocked sign-in re-send) renders the plain verification template.
 * Decode failure falls back to plain verification, which is safe for every
 * leg. Token TTL is `emailVerification.expiresIn` (1 hour).
 *
 * @param data - Better Auth callback payload (`user`, `url`, `token`).
 */
export async function sendVerificationEmail(data: {
  user: EmailRecipient;
  url: string;
  token: string;
}): Promise<void> {
  const brand = resolveBrandConfig();
  const newEmail = await changeEmailTargetFromToken(data.token);
  if (newEmail !== null) {
    deliverAuthEmail(
      data.user.email,
      "emailChange",
      `Confirm your new ${brand.appName} email`,
      brand,
      (b) =>
        emailChangeEmail(b, {
          confirmUrl: data.url,
          newEmail,
          expiresLabel: "1 hour",
        }),
    );
    return;
  }
  deliverAuthEmail(
    data.user.email,
    "verification",
    `Verify your ${brand.appName} email`,
    brand,
    (b) =>
      verificationEmail(b, {
        verifyUrl: data.url,
        recipientName: data.user.name || undefined,
        expiresLabel: "1 hour",
      }),
  );
}

/**
 * `emailAndPassword.sendResetPassword` wiring. Token TTL is
 * `resetPasswordTokenExpiresIn` (1 hour); the template states single-use.
 *
 * @param data - Better Auth callback payload (`user`, `url`).
 */
export async function sendResetPasswordEmail(data: {
  user: EmailRecipient;
  url: string;
}): Promise<void> {
  const brand = resolveBrandConfig();
  deliverAuthEmail(
    data.user.email,
    "passwordReset",
    `Reset your ${brand.appName} password`,
    brand,
    (b) =>
      passwordResetEmail(b, {
        resetUrl: data.url,
        recipientName: data.user.name || undefined,
        expiresLabel: "1 hour",
      }),
  );
}

/**
 * `user.changeEmail.sendChangeEmailConfirmation` wiring: the approval gate to
 * the CURRENT address, naming the pending new address. The user must approve
 * before the new-address verification is sent (OWASP change-email flow).
 *
 * @param data - Better Auth callback payload (`user`, `newEmail`, `url`).
 */
export async function sendChangeEmailApprovalEmail(data: {
  user: EmailRecipient;
  newEmail: string;
  url: string;
}): Promise<void> {
  const brand = resolveBrandConfig();
  deliverAuthEmail(
    data.user.email,
    "emailChangeApproval",
    `Approve your ${brand.appName} email change`,
    brand,
    (b) =>
      emailChangeApprovalEmail(b, {
        approveUrl: data.url,
        newEmail: data.newEmail,
        recipientName: data.user.name || undefined,
        expiresLabel: "1 hour",
      }),
  );
}

/**
 * `user.deleteUser.sendDeleteAccountVerification` wiring. The emailed link
 * completes the deletion (the signed-in user must click it); TTL is Better
 * Auth's `deleteTokenExpiresIn` default of 24 hours.
 *
 * @param data - Better Auth callback payload (`user`, `url`).
 */
export async function sendDeleteAccountEmail(data: {
  user: EmailRecipient;
  url: string;
}): Promise<void> {
  const brand = resolveBrandConfig();
  deliverAuthEmail(
    data.user.email,
    "deleteAccount",
    `Confirm ${brand.appName} account deletion`,
    brand,
    (b) =>
      deleteAccountEmail(b, {
        confirmUrl: data.url,
        recipientName: data.user.name || undefined,
        expiresLabel: "24 hours",
      }),
  );
}

/**
 * Password-changed security notification, shared by the reset path
 * (`onPasswordReset`) and the settings change-password path
 * (`changePasswordAction`). Stamped with the send instant in UTC.
 *
 * @param user - The account whose password changed.
 * @param context - Request-context display strings for the When/Device/Location notes.
 */
export function sendPasswordChangedEmail(
  user: EmailRecipient,
  context: SignInContext,
): void {
  const brand = resolveBrandConfig();
  deliverAuthEmail(
    user.email,
    "passwordChanged",
    `Your ${brand.appName} password was changed`,
    brand,
    (b) =>
      passwordChangedEmail(b, {
        recipientName: user.name || undefined,
        timestamp: new Date().toUTCString(),
        device: context.device,
        location: context.location,
      }),
  );
}

/**
 * Unrecognized-sign-in security notification. The caller decides recognition
 * (comparing the new session's context against the user's other sessions);
 * this only renders and floats the send, stamped with the send instant in UTC.
 *
 * @param user - The account that signed in.
 * @param context - Request-context display strings for the When/Device/Location notes.
 */
export function sendNewSignInEmail(
  user: EmailRecipient,
  context: SignInContext,
): void {
  const brand = resolveBrandConfig();
  deliverAuthEmail(
    user.email,
    "newSignIn",
    `New sign-in to ${brand.appName}`,
    brand,
    (b) =>
      newSignInEmail(b, {
        recipientName: user.name || undefined,
        timestamp: new Date().toUTCString(),
        device: context.device,
        location: context.location,
      }),
  );
}

/**
 * `organization.sendInvitationEmail` wiring. Builds the invitation URL from
 * the brand's `appUrl` (Better Auth provides no built-in link) and sends from
 * the personal purpose (an invite invites a reply), with a real reply-to
 * instead of noreply. TTL label mirrors the organization plugin's
 * `invitationExpiresIn` default of 48 hours.
 *
 * @param data - Better Auth invitation payload (structural subset).
 */
export async function sendTeamInviteEmail(data: {
  id: string;
  email: string;
  organization: { name: string };
  inviter: { user: { name: string; email: string } };
}): Promise<void> {
  const brand = resolveBrandConfig();
  const inviteUrl = new URL(`/invitations/${data.id}`, brand.appUrl).toString();
  deliverAuthEmail(
    data.email,
    "teamInvite",
    `Join ${data.organization.name} on ${brand.appName}`,
    brand,
    (b) =>
      teamInviteEmail(b, {
        inviteUrl,
        teamName: data.organization.name,
        inviterName: data.inviter.user.name || undefined,
        inviterEmail: data.inviter.user.email || undefined,
        recipientEmail: data.email,
        expiresLabel: "48 hours",
      }),
    "personal",
  );
}
