import "server-only";

import { LogSender } from "./log-sender";
import {
  getPlatformSender,
  platformEmailConfigured,
} from "@/lib/email/_sender";
import type { EmailSender } from "./types";

/**
 * The active email transport, or `null` when email is disabled.
 *
 * `EMAIL_TRANSPORT=log` selects the console `LogSender` (local dev and
 * unconfigured self-host). Otherwise the per-runtime platform sender decides:
 * the Cloudflare `send_email` binding on Workers or nodemailer SMTP on Node,
 * each returning `null` when its provider is not configured. A `null` result
 * means email is disabled, which keeps self-host bootable.
 *
 * Resolved per call: the Workers platform sender reads a request-scoped binding,
 * so the result must not be cached across requests.
 *
 * @returns The active email sender, or `null` when email is disabled.
 */
export function getEmailSender(): EmailSender | null {
  if (process.env.EMAIL_TRANSPORT === "log") return new LogSender();
  return getPlatformSender();
}

/**
 * Whether email is enabled for this deployment. The single capability gate
 * every email feature checks before rendering surfaces or sending mail.
 *
 * @returns `true` when an email transport is configured, otherwise `false`.
 */
export function isEmailEnabled(): boolean {
  return getEmailSender() !== null;
}

/**
 * Boot-safe variant of the capability gate for config that Better Auth reads
 * once at construction (for example whether account deletion requires an
 * emailed confirmation). Reads only static env — `EMAIL_TRANSPORT=log` or the
 * per-runtime `platformEmailConfigured()` — never the request-scoped Workers
 * binding, so it is safe at module load. Request-time delivery still goes
 * through `getEmailSender()`.
 *
 * @returns `true` when this deployment is configured to send email.
 */
export function isEmailConfiguredAtBoot(): boolean {
  return process.env.EMAIL_TRANSPORT === "log" || platformEmailConfigured();
}
