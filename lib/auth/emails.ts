import "server-only";

import { jwtVerify } from "jose";
import { getEmailSender } from "@/lib/email";
import { enrollEmailSend } from "@/lib/email/_defer";
import { resolveBrandConfig, senderFor } from "@/lib/email/brand";
import {
  deleteAccountEmail,
  emailChangeApprovalEmail,
  emailChangeEmail,
  newSignInEmail,
  passwordChangedEmail,
  passwordResetEmail,
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
 * @param render - Renders the body once the capability gate has passed.
 */
function deliverAuthEmail(
  to: string,
  template: string,
  subject: string,
  render: (brand: BrandConfig) => RenderedEmail,
): void {
  const sender = getEmailSender();
  if (sender === null) return;
  const brand = resolveBrandConfig();
  const { from, replyTo } = senderFor("transactional");
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
    (b) =>
      newSignInEmail(b, {
        recipientName: user.name || undefined,
        timestamp: new Date().toUTCString(),
        device: context.device,
        location: context.location,
      }),
  );
}
