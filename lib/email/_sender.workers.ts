import "server-only";

import type { EmailSender } from "./types";

/**
 * Cloudflare Workers platform transport selection.
 *
 * The webpack alias in `next.config.ts` resolves `lib/email/_sender` to this
 * sibling on `DEPLOY_TARGET=cloudflare` builds.
 *
 * Placeholder: returns `null` (email disabled) until the Workers
 * binding-backed sender lands.
 *
 * @returns The configured sender, or `null` when no transport is available.
 */
export function getPlatformSender(): EmailSender | null {
  return null;
}
