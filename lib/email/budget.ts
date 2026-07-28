import "server-only";

import { getPlatformBudgetStore } from "@/lib/email/_budget";

/**
 * Sends allowed per recipient address per template, per window.
 *
 * Sized against the legitimate worst case rather than the attack: a real user
 * completing sign-up may need one verification mail plus a couple of resends
 * after a typo or a slow inbox. Anything past that to the same address for the
 * same template inside an hour is a flood, not a user. Supabase ships a
 * comparable default of 2 per hour per recipient.
 */
export const EMAIL_BUDGET = { max: 3, windowSeconds: 3600 } as const;

/**
 * Build the budget key for one recipient and template.
 *
 * The address is SHA-256 hashed so no recipient address is ever written to KV,
 * matching how `lib/api/rate-limit.ts` hashes bearer tokens before they reach
 * the rate-limit store. Keyed per template rather than per address alone, so a
 * sign-in notification cannot consume the verification-email budget and lock a
 * user out of a resend.
 *
 * @param to - Recipient address.
 * @param template - Template name, as passed to the delivery helper.
 * @returns The opaque budget key.
 */
async function budgetKey(to: string, template: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(to.trim().toLowerCase()),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `emailbudget:${template}:${hex}`;
}

/**
 * Count one auth email against its recipient's budget.
 *
 * Enforced at the delivery helper rather than in a Better Auth hook, because
 * several send paths never touch the HTTP router: `auth.api.changeEmail` and
 * the team-invitation actions dispatch through server actions, which bypass
 * Better Auth's rate limiting entirely. The delivery helper is the one
 * chokepoint every auth email crosses.
 *
 * Fails open when no store is available (self-host outside a request context,
 * unbound `AUTH_KV`): a missing counter must never stop a user verifying their
 * address.
 *
 * @param to - Recipient address.
 * @param template - Template name, used to scope the budget.
 * @returns `true` when the send may proceed, `false` when it is over budget.
 */
export async function consumeEmailBudget(
  to: string,
  template: string,
): Promise<boolean> {
  const store = getPlatformBudgetStore();
  if (store === null) return true;
  return store.consume(
    await budgetKey(to, template),
    EMAIL_BUDGET.max,
    EMAIL_BUDGET.windowSeconds,
  );
}
