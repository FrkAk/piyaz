import "server-only";

import { LogSender } from "./log-sender";
import { getPlatformSender } from "@/lib/email/_sender";
import type { EmailSender } from "./types";

/**
 * The active email transport, or `null` when email is disabled.
 *
 * `EMAIL_TRANSPORT=log` selects the console `LogSender` (local dev and
 * unconfigured self-host). Otherwise the per-runtime platform sender decides:
 * the Cloudflare `send_email` binding on Workers (PYZ-270) or nodemailer SMTP
 * on Node (PYZ-271), each returning `null` when its provider is not configured.
 * A `null` result means email is disabled, which keeps self-host bootable.
 *
 * Resolved per call: the Workers platform sender reads a request-scoped binding,
 * so the result must not be cached across requests.
 */
export function getEmailSender(): EmailSender | null {
  if (process.env.EMAIL_TRANSPORT === "log") return new LogSender();
  return getPlatformSender();
}

/**
 * Whether email is enabled for this deployment. The single capability gate
 * every email feature checks before rendering surfaces or sending mail.
 */
export function isEmailEnabled(): boolean {
  return getEmailSender() !== null;
}
