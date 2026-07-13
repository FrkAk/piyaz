/**
 * The seven transactional email templates as pure functions of a `BrandConfig`
 * plus per-email params. Each returns a matched `{ html, text }` pair through
 * the shared shell in `render.ts`, which owns all escaping, URL scheme checks,
 * and the branded-vs-neutral gating. Params are treated as untrusted; the shell
 * escapes every interpolated value, so templates compose plain strings.
 *
 * These param shapes are the contract PYZ-273 (Better Auth wiring) and PYZ-153
 * (invite email) call, so field names stay explicit. Subjects are the caller's
 * responsibility; templates own body content only.
 */
import type { BrandConfig } from "../types";
import { type EmailBlock, renderShell, renderText } from "./render";

/** A rendered email: matched HTML and plain-text parts. */
export interface RenderedEmail {
  html: string;
  text: string;
}

/** Opening line, personalized when a recipient name is known. */
function greeting(recipientName?: string): string {
  return recipientName ? `Hi ${recipientName},` : "Hi,";
}

/** Run one content definition through both shell renderers into a matched pair. */
function render(
  brand: BrandConfig,
  preheader: string,
  heading: string,
  blocks: EmailBlock[],
): RenderedEmail {
  const content = { preheader, heading, blocks };
  return {
    html: renderShell(brand, content),
    text: renderText(brand, content),
  };
}

/** Params for the email-verification email. */
export interface VerificationParams {
  verifyUrl: string;
  recipientName?: string;
  /** Human-readable expiry label (e.g. "1 hour"); owned by the caller so no TTL is baked in here. */
  expiresLabel?: string;
}

/** Sign-up email verification: one action link to confirm the address. */
export function verificationEmail(
  brand: BrandConfig,
  params: VerificationParams,
): RenderedEmail {
  const blocks: EmailBlock[] = [
    { kind: "paragraph", text: greeting(params.recipientName) },
    {
      kind: "paragraph",
      text: `Confirm your email address to finish setting up your ${brand.appName} account.`,
    },
    { kind: "action", label: "Confirm email", url: params.verifyUrl },
  ];
  if (params.expiresLabel) {
    blocks.push({
      kind: "note",
      text: `This link expires in ${params.expiresLabel}.`,
    });
  }
  blocks.push({
    kind: "note",
    text: "If you didn't create this account, you can safely ignore this email.",
  });
  return render(
    brand,
    `Confirm your email for ${brand.appName}`,
    "Confirm your email",
    blocks,
  );
}

/** Params for the password-reset email. */
export interface PasswordResetParams {
  resetUrl: string;
  recipientName?: string;
  /** Human-readable expiry label (e.g. "1 hour"); owned by the caller so no TTL is baked in here. */
  expiresLabel?: string;
}

/** Password reset: reset action link, optional expiry note, didn't-request reassurance. */
export function passwordResetEmail(
  brand: BrandConfig,
  params: PasswordResetParams,
): RenderedEmail {
  const blocks: EmailBlock[] = [
    { kind: "paragraph", text: greeting(params.recipientName) },
    {
      kind: "paragraph",
      text: `We received a request to reset the password for your ${brand.appName} account. Choose a new password with the button below.`,
    },
    { kind: "action", label: "Reset password", url: params.resetUrl },
  ];
  if (params.expiresLabel) {
    blocks.push({
      kind: "note",
      text: `This link expires in ${params.expiresLabel}.`,
    });
  }
  blocks.push({
    kind: "note",
    text: "This link can only be used once.",
  });
  blocks.push({
    kind: "note",
    text: "If you didn't request a password reset, you can ignore this email and your password will stay the same.",
  });
  return render(brand, "Reset your password", "Reset your password", blocks);
}

/** Params for the email-change confirmation email, sent to the new address. */
export interface EmailChangeParams {
  confirmUrl: string;
  newEmail: string;
}

/** Email-change confirmation: names the new address and links its confirmation. */
export function emailChangeEmail(
  brand: BrandConfig,
  params: EmailChangeParams,
): RenderedEmail {
  return render(
    brand,
    "Confirm your new email address",
    "Confirm your new email",
    [
      {
        kind: "paragraph",
        text: `Confirm that you want to use ${params.newEmail} for your ${brand.appName} account.`,
      },
      { kind: "action", label: "Confirm email change", url: params.confirmUrl },
      {
        kind: "note",
        text: "If you didn't request this change, ignore this email and your address will stay the same.",
      },
    ],
  );
}

/** Params for the password-changed notification; context fields are caller-formatted display strings. */
export interface PasswordChangedParams {
  recipientName?: string;
  /** Absolute UTC timestamp of the change as a display string. */
  timestamp?: string;
  /** Device or browser description of the request. */
  device?: string;
  /** Approximate location or IP address of the request. */
  location?: string;
}

/** Password-changed notice: no action link; wasn't-you pointer gated on `supportEmail`. */
export function passwordChangedEmail(
  brand: BrandConfig,
  params: PasswordChangedParams,
): RenderedEmail {
  const blocks: EmailBlock[] = [
    { kind: "paragraph", text: greeting(params.recipientName) },
    {
      kind: "paragraph",
      text: `The password for your ${brand.appName} account was just changed.`,
    },
  ];
  if (params.timestamp)
    blocks.push({ kind: "note", text: `When: ${params.timestamp}` });
  if (params.device)
    blocks.push({ kind: "note", text: `Device: ${params.device}` });
  if (params.location)
    blocks.push({ kind: "note", text: `Location: ${params.location}` });
  blocks.push({
    kind: "note",
    text: brand.supportEmail
      ? `If this wasn't you, contact ${brand.supportEmail} right away to secure your account.`
      : "If this wasn't you, reset your password right away to secure your account.",
  });
  return render(
    brand,
    "Your password was changed",
    "Your password was changed",
    blocks,
  );
}

/** Params for the new-sign-in notification; context fields are caller-formatted display strings. */
export interface NewSignInParams {
  recipientName?: string;
  /** Absolute UTC timestamp of the sign-in as a display string. */
  timestamp?: string;
  /** Device or browser description of the sign-in. */
  device?: string;
  /** Approximate location or IP address of the sign-in. */
  location?: string;
}

/** New-sign-in notice: optional when/device notes; wasn't-you pointer gated on `supportEmail`. */
export function newSignInEmail(
  brand: BrandConfig,
  params: NewSignInParams,
): RenderedEmail {
  const blocks: EmailBlock[] = [
    { kind: "paragraph", text: greeting(params.recipientName) },
    {
      kind: "paragraph",
      text: `We noticed a new sign-in to your ${brand.appName} account.`,
    },
  ];
  if (params.timestamp)
    blocks.push({ kind: "note", text: `When: ${params.timestamp}` });
  if (params.device)
    blocks.push({ kind: "note", text: `Device: ${params.device}` });
  if (params.location)
    blocks.push({ kind: "note", text: `Location: ${params.location}` });
  blocks.push({
    kind: "note",
    text: brand.supportEmail
      ? `If this wasn't you, contact ${brand.supportEmail} and change your password.`
      : "If this wasn't you, change your password right away.",
  });
  return render(
    brand,
    `New sign-in to ${brand.appName}`,
    "New sign-in to your account",
    blocks,
  );
}

/** Params for the email-change approval email, sent to the current address. */
export interface EmailChangeApprovalParams {
  approveUrl: string;
  newEmail: string;
  recipientName?: string;
}

/** Email-change approval gate: names the pending new address; wasn't-you pointer gated on `supportEmail`. */
export function emailChangeApprovalEmail(
  brand: BrandConfig,
  params: EmailChangeApprovalParams,
): RenderedEmail {
  return render(
    brand,
    `Approve the email change for your ${brand.appName} account`,
    "Approve email change",
    [
      { kind: "paragraph", text: greeting(params.recipientName) },
      {
        kind: "paragraph",
        text: `We received a request to change the email address on your ${brand.appName} account to ${params.newEmail}.`,
      },
      { kind: "action", label: "Approve email change", url: params.approveUrl },
      {
        kind: "note",
        text: brand.supportEmail
          ? `If you didn't request this change, don't approve it. Contact ${brand.supportEmail} right away to secure your account.`
          : "If you didn't request this change, don't approve it and change your password right away to secure your account.",
      },
    ],
  );
}

/** Params for the account-deletion confirmation email. */
export interface DeleteAccountParams {
  confirmUrl: string;
  recipientName?: string;
  /** Human-readable expiry label (e.g. "24 hours"); owned by the caller so no TTL is baked in here. */
  expiresLabel?: string;
}

/** Account-deletion confirmation: confirm-to-delete link, optional expiry note, didn't-request reassurance. */
export function deleteAccountEmail(
  brand: BrandConfig,
  params: DeleteAccountParams,
): RenderedEmail {
  const blocks: EmailBlock[] = [
    { kind: "paragraph", text: greeting(params.recipientName) },
    {
      kind: "paragraph",
      text: `We received a request to permanently delete your ${brand.appName} account. Confirm below to continue.`,
    },
    {
      kind: "action",
      label: "Confirm account deletion",
      url: params.confirmUrl,
    },
  ];
  if (params.expiresLabel) {
    blocks.push({
      kind: "note",
      text: `This link expires in ${params.expiresLabel}.`,
    });
  }
  blocks.push({
    kind: "note",
    text: brand.supportEmail
      ? `If you didn't request this, ignore this email and your account will stay active. Contact ${brand.supportEmail} to secure your account.`
      : "If you didn't request this, ignore this email and your account will stay active. Consider changing your password to secure your account.",
  });
  return render(
    brand,
    `Confirm the deletion of your ${brand.appName} account`,
    "Confirm account deletion",
    blocks,
  );
}
