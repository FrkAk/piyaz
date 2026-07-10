/**
 * The five transactional email templates as pure functions of a `BrandConfig`
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

function greeting(recipientName?: string): string {
  return recipientName ? `Hi ${recipientName},` : "Hi,";
}

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

export interface VerificationParams {
  verifyUrl: string;
  recipientName?: string;
}

export function verificationEmail(
  brand: BrandConfig,
  params: VerificationParams,
): RenderedEmail {
  return render(
    brand,
    `Confirm your email for ${brand.appName}`,
    "Confirm your email",
    [
      { kind: "paragraph", text: greeting(params.recipientName) },
      {
        kind: "paragraph",
        text: `Confirm your email address to finish setting up your ${brand.appName} account.`,
      },
      { kind: "action", label: "Confirm email", url: params.verifyUrl },
      {
        kind: "note",
        text: "If you didn't create this account, you can safely ignore this email.",
      },
    ],
  );
}

export interface PasswordResetParams {
  resetUrl: string;
  recipientName?: string;
  /** Human-readable expiry label (e.g. "1 hour"); owned by the caller so no TTL is baked in here. */
  expiresLabel?: string;
}

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
    text: "If you didn't request a password reset, you can ignore this email and your password will stay the same.",
  });
  return render(brand, "Reset your password", "Reset your password", blocks);
}

export interface EmailChangeParams {
  confirmUrl: string;
  newEmail: string;
}

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

export interface PasswordChangedParams {
  recipientName?: string;
}

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
    {
      kind: "note",
      text: brand.supportEmail
        ? `If this wasn't you, contact ${brand.supportEmail} right away to secure your account.`
        : "If this wasn't you, reset your password right away to secure your account.",
    },
  ];
  return render(
    brand,
    "Your password was changed",
    "Your password was changed",
    blocks,
  );
}

export interface NewSignInParams {
  recipientName?: string;
  timestamp?: string;
  device?: string;
}

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
