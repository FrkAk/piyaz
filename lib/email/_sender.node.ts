import "server-only";

import type { EmailSender } from "./types";

/**
 * Node / self-host platform transport selection.
 *
 * The webpack alias in `next.config.ts` resolves `lib/email/_sender` to this
 * sibling on non-Cloudflare builds, so the SMTP adapter and any Node-only
 * dependency stay out of the Workers bundle.
 *
 * Placeholder: returns `null` (email disabled) until the SMTP adapter lands.
 *
 * @returns The configured sender, or `null` when no transport is available.
 */
export function getPlatformSender(): EmailSender | null {
  return null;
}
