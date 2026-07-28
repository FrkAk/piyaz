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
 *
 * `teamInvite` is the one template a flat cap gets wrong. It still mails an
 * address the sender chose, so it stays bounded, but the legitimate case is a
 * new colleague being added to several teams at once, which a cap of three
 * would silently truncate while showing the inviter a success.
 */
export const EMAIL_BUDGET = {
  windowSeconds: 3600,
  defaultMax: 3,
  perTemplate: { teamInvite: 10 } as Readonly<Record<string, number>>,
} as const;

/**
 * Sends allowed for one template per recipient per window.
 *
 * @param template - Template name, as passed to the delivery helper.
 * @returns The cap for that template.
 */
export function emailBudgetMax(template: string): number {
  return EMAIL_BUDGET.perTemplate[template] ?? EMAIL_BUDGET.defaultMax;
}

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
  return `emailbudget:${template}:${await recipientHex(to)}`;
}

/**
 * Hex SHA-256 of the normalized recipient address.
 *
 * @param to - Recipient address.
 * @returns The full lowercase hex digest.
 */
async function recipientHex(to: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(to.trim().toLowerCase()),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Attribution handle for budget log events: a stable digest prefix that
 * identifies one recipient across events without carrying the address.
 *
 * @param to - Recipient address.
 * @returns The first 12 hex characters of the recipient digest.
 */
export async function recipientDigestForLog(to: string): Promise<string> {
  return (await recipientHex(to)).slice(0, 12);
}

/** A granted send slot. Call {@link EmailBudgetSlot.commit} once mail is away. */
export interface EmailBudgetSlot {
  /** Record the delivered send against the recipient's budget. */
  commit(): Promise<void>;
}

/**
 * Claim a send slot for one auth email.
 *
 * Enforced at the delivery helper rather than in a Better Auth hook, because
 * several send paths never touch the HTTP router: `auth.api.changeEmail` and
 * the team-invitation actions dispatch through server actions, which bypass
 * Better Auth's rate limiting entirely. The delivery helper is the one
 * chokepoint every auth email crosses.
 *
 * The slot is committed by the caller only after the provider accepts the
 * message, so a failed send costs nothing. Counting at the check instead would
 * let three provider errors exhaust a recipient's hourly allowance and leave a
 * real user unable to verify their address during an outage.
 *
 * Fails open when no store is available (self-host outside a request context,
 * unbound `AUTH_KV`): a missing counter must never stop a user verifying their
 * address.
 *
 * @param to - Recipient address.
 * @param template - Template name, used to scope the budget.
 * @returns A slot to commit after a successful send, or `null` when the
 *   recipient is already at their cap for this template.
 */
export async function reserveEmailBudget(
  to: string,
  template: string,
): Promise<EmailBudgetSlot | null> {
  const store = getPlatformBudgetStore();
  if (store === null) return { async commit() {} };
  const key = await budgetKey(to, template);
  const used = await store.read(key);
  if (used >= emailBudgetMax(template)) return null;
  return {
    commit: () => store.commit(key, used, EMAIL_BUDGET.windowSeconds),
  };
}
