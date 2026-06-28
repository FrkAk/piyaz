import "server-only";

import { LogSender } from "./log-sender";
import { getPlatformSender } from "./_sender";
import type { EmailSender } from "./types";

let cached: EmailSender | null | undefined;

/**
 * Resolve the active email transport from env and runtime.
 *
 * `EMAIL_TRANSPORT=log` selects the console `LogSender` (local dev and
 * unconfigured self-host). Otherwise the per-runtime platform sender decides:
 * the Cloudflare `send_email` binding on Workers (PYZ-270) or nodemailer SMTP
 * on Node (PYZ-271), each returning `null` when its provider is not configured.
 * A `null` result means email is disabled, which keeps self-host bootable.
 */
function resolve(): EmailSender | null {
  if (process.env.EMAIL_TRANSPORT === "log") return new LogSender();
  return getPlatformSender();
}

/**
 * The active email transport, or `null` when email is disabled.
 *
 * Memoized for the process lifetime; env is fixed at start, so repeated calls
 * never re-read it.
 */
export function getEmailSender(): EmailSender | null {
  if (cached === undefined) cached = resolve();
  return cached;
}

/**
 * Whether email is enabled for this deployment. The single capability gate
 * every email feature checks before rendering surfaces or sending mail.
 */
export function isEmailEnabled(): boolean {
  return getEmailSender() !== null;
}

/** Test-only seam: clear the memoized transport so each branch can be asserted. */
export function __resetEmailSenderForTest(): void {
  cached = undefined;
}
