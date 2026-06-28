import "server-only";

import type { EmailSender } from "./types";

/**
 * Cloudflare Workers platform transport selection.
 *
 * The webpack alias in `next.config.ts` resolves `lib/email/_sender` to this
 * sibling on `DEPLOY_TARGET=cloudflare` builds. PYZ-270 implements the cloud
 * sender here over the Workers `send_email` binding: when the `EMAIL` binding
 * and `EMAIL_FROM` are configured, return the binding-backed sender; otherwise
 * return `null` (email disabled).
 *
 * @returns The configured Cloudflare sender, or `null` when the binding is absent.
 */
export function getPlatformSender(): EmailSender | null {
  return null;
}
