import "server-only";

import type { EmailSender } from "./types";

/**
 * Node / self-host platform transport selection.
 *
 * The webpack alias in `next.config.ts` resolves `lib/email/_sender` to this
 * sibling on non-Cloudflare builds, so the nodemailer SMTP adapter and any
 * Node-only dependency stay out of the Workers bundle. PYZ-271 implements the
 * SMTP sender here: when `SMTP_*` and `EMAIL_FROM` are configured, return a
 * `new SmtpSender(...)`; otherwise return `null` (email disabled).
 *
 * @returns The configured SMTP sender, or `null` when self-host has no provider.
 */
export function getPlatformSender(): EmailSender | null {
  return null;
}
