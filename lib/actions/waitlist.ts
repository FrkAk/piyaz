"use server";

import { z } from "zod/v4";
import { checkActionRateLimit } from "@/lib/actions/rate-limit-action";
import { putWaitlistEntry } from "@/lib/db/_waitlist-kv.workers";

type WaitlistFailureCode = "invalid_email" | "rate_limited" | "unknown";

export type WaitlistResult =
  | { ok: true }
  | { ok: false; code: WaitlistFailureCode; message: string };

/**
 * Rate-limit policy for `joinWaitlistAction`. Routed to the `"auth"`
 * backend so Workers enforces it per-PoP on the durable `RATE_LIMIT_AUTH`
 * binding. That binding ignores the declared `perIpMax`/`perUserMax` and
 * applies its own `simple.limit` (5/60) per key, so per `rate-limit-action.ts`
 * EVERY limit on the `auth` slot must equal exactly 5/60 or self-host and
 * Workers diverge — so we set exactly 5/60 here.
 */
const WAITLIST_RATE_LIMIT = {
  action: "waitlist.signup",
  windowSeconds: 60,
  perUserMax: 5,
  perIpMax: 5,
  backendKind: "auth",
} as const;

// Trim + lowercase BEFORE the email check so a whitespace-padded or
// mixed-case submission is normalized rather than rejected; `parsed.data`
// then carries the canonical key written to KV.
const waitlistSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
});

const INVALID_EMAIL_MSG = "Enter a valid email address.";
const RATE_LIMITED_MSG = "Too many requests. Please slow down and try again shortly.";
const UNKNOWN_MSG = "Something went wrong. Please try again.";

/**
 * Capture an email onto the invite-only waitlist.
 *
 * Order mirrors `joinTeamByCodeAction`'s "limit before parse" rationale:
 * rate-limit first so a malformed-input flood still costs a slot and cannot
 * dodge the limiter. `checkActionRateLimit` is IP-keyed here (`userId`
 * `null`, unauthenticated public form) and runs BEFORE any KV write, so an
 * over-limit submission is rejected without touching `WAITLIST_KV`.
 *
 * On a valid email the value is normalized (`trim().toLowerCase()`) and
 * written to `WAITLIST_KV` with the email as the key — idempotent by
 * overwrite (re-submitting the same email is a harmless no-op rewrite).
 * Postgres/Drizzle is untouched. A missing binding (self-host/dev) degrades
 * to `unknown` rather than throwing.
 *
 * @param input - `{ email }` from the public waitlist form.
 * @returns Discriminated result; `{ ok: true }` once the email is captured.
 */
export async function joinWaitlistAction(input: {
  email: string;
}): Promise<WaitlistResult> {
  const limit = await checkActionRateLimit(WAITLIST_RATE_LIMIT, null);
  if (!limit.ok) {
    return { ok: false, code: "rate_limited", message: RATE_LIMITED_MSG };
  }

  const parsed = waitlistSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "invalid_email", message: INVALID_EMAIL_MSG };
  }
  const email = parsed.data.email;

  const result = await putWaitlistEntry(email);
  if (result === "unavailable") {
    return { ok: false, code: "unknown", message: UNKNOWN_MSG };
  }

  return { ok: true };
}
