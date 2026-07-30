import "server-only";

import { getPlatformBudgetStore } from "@/lib/email/_budget";
import type { EmailBudgetStore } from "@/lib/email/budget-types";

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
 * Minimum seconds between two sends of the same template to one address.
 *
 * An allowlist, not a default: only the templates an unauthenticated caller
 * triggers on demand carry one. `/send-verification-email` and
 * `/request-password-reset` both re-send to a caller-named address on every
 * call, and the hourly cap alone still lets all three of an address's sends
 * land within seconds, which empties the allowance a real user needs for a
 * typo retry. The security notifications are deliberately absent: each follows
 * a state change the account owner should always hear about, so suppressing a
 * second one is worse than mailing twice. `teamInvite` is absent for the same
 * reason its cap is raised, a colleague added to several teams at once being
 * one legitimate burst.
 *
 * Values must stay at or above KV's 60s `expirationTtl` floor, which the
 * Workers store clamps to; a shorter cooldown would silently become 60s there
 * while behaving as written on self-host. On Workers the marker also rides
 * KV's edge caches, so a retry through another POP can miss it for up to its
 * own lifetime; same-POP retries observe their write, and the hourly cap
 * bounds the total. Same abuse-damper semantics as the counter
 * (`_budget.workers.ts`); self-host's in-memory store is exact.
 */
const COOLDOWN_SECONDS: Readonly<Record<string, number>> = {
  verification: 60,
  passwordReset: 60,
};

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
 * Minimum gap enforced between two sends of one template to one address.
 *
 * @param template - Template name, as passed to the delivery helper.
 * @returns The cooldown in seconds, or `0` when the template has none.
 */
export function emailCooldownSeconds(template: string): number {
  return COOLDOWN_SECONDS[template] ?? 0;
}

/**
 * Build the hourly-budget key for one recipient digest and template.
 *
 * The address is SHA-256 hashed by the caller so no recipient address is ever
 * written to KV, matching how `lib/api/rate-limit.ts` hashes bearer tokens
 * before they reach the rate-limit store. Keyed per template rather than per
 * address alone, so a sign-in notification cannot consume the verification-email
 * budget and lock a user out of a resend.
 *
 * @param template - Template name, as passed to the delivery helper.
 * @param digest - Hex digest of the recipient address.
 * @returns The opaque budget key.
 */
function budgetKey(template: string, digest: string): string {
  return `emailbudget:${template}:${digest}`;
}

/**
 * Build the cooldown key for one recipient digest and template.
 *
 * A separate key rather than a field on the budget counter: the marker's whole
 * behavior is "exists until it expires", which the store already gives for free
 * through the window TTL, so the counter's storage shape stays untouched on both
 * runtimes.
 *
 * @param template - Template name, as passed to the delivery helper.
 * @param digest - Hex digest of the recipient address.
 * @returns The opaque cooldown key.
 */
function cooldownKey(template: string, digest: string): string {
  return `emailcooldown:${template}:${digest}`;
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
 * Why a send was withheld. `cooldown` clears on its own within seconds;
 * `budget` holds until the recipient's hourly window rolls over.
 */
export type EmailSendSuppression = "cooldown" | "budget";

/** Outcome of a budget check: a granted slot, or why the send is withheld. */
export type EmailSendDecision =
  | { allowed: true; slot: EmailBudgetSlot }
  | { allowed: false; reason: EmailSendSuppression };

/**
 * Apply both caps to one recipient and template.
 *
 * The single expression of the rule, so the reserving path and the read-only
 * probe cannot drift.
 *
 * The counter is checked first so the reported reason is always the
 * longer-lived one. Both caps hold at once for the minute after a recipient's
 * third send, and a caller told to wait a minute there would come back to a
 * budget that stays spent for the rest of the hour. Ordering costs nothing on
 * the path that matters: the counter read supplies `used`, which a granted send
 * needs anyway, so only a cooling-down caller pays the second read.
 *
 * @param store - Resolved counter store.
 * @param template - Template name, used to scope both caps.
 * @param digest - Hex digest of the recipient address.
 * @returns The suppression reason, or the observed send count when a send may
 *   proceed.
 */
async function applyCaps(
  store: EmailBudgetStore,
  template: string,
  digest: string,
): Promise<{ reason: EmailSendSuppression } | { reason: null; used: number }> {
  const used = await store.read(budgetKey(template, digest));
  if (used >= emailBudgetMax(template)) return { reason: "budget" };
  if (emailCooldownSeconds(template) > 0) {
    if ((await store.read(cooldownKey(template, digest))) > 0) {
      return { reason: "cooldown" };
    }
  }
  return { reason: null, used };
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
 * @param template - Template name, used to scope both caps.
 * @returns A slot to commit after a successful send, or the reason the send is
 *   withheld.
 */
export async function reserveEmailBudget(
  to: string,
  template: string,
): Promise<EmailSendDecision> {
  const store = getPlatformBudgetStore();
  if (store === null) return { allowed: true, slot: { async commit() {} } };
  const digest = await recipientHex(to);
  const capped = await applyCaps(store, template, digest);
  if (capped.reason !== null) return { allowed: false, reason: capped.reason };
  const cooldown = emailCooldownSeconds(template);
  return {
    allowed: true,
    slot: {
      commit: async () => {
        const writes = [
          store.commit(
            budgetKey(template, digest),
            capped.used,
            EMAIL_BUDGET.windowSeconds,
          ),
        ];
        // Count is irrelevant for the marker; only its presence is read, and
        // the window TTL is what expires the cooldown. Written alongside the
        // counter rather than after it: the keys are independent, neither
        // store throws, and no reader depends on one landing first.
        if (cooldown > 0) {
          writes.push(store.commit(cooldownKey(template, digest), 0, cooldown));
        }
        await Promise.all(writes);
      },
    },
  };
}

/**
 * Read whether a send to this recipient would currently be withheld, without
 * reserving anything.
 *
 * Exists so a caller who provably owns the address can be told the truth
 * instead of receiving the neutral success the anti-enumeration path requires.
 * Enforcement stays at the delivery helper; this only reports, and the two
 * reads it costs land on that one honest-response path.
 *
 * @param to - Recipient address.
 * @param template - Template name, used to scope both caps.
 * @returns The suppression reason, or `null` when a send would go out now.
 */
export async function probeEmailSend(
  to: string,
  template: string,
): Promise<EmailSendSuppression | null> {
  const store = getPlatformBudgetStore();
  if (store === null) return null;
  const capped = await applyCaps(store, template, await recipientHex(to));
  return capped.reason;
}
